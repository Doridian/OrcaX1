//! File stores behind the /api/files endpoints: the local SD card
//! directory, or the printer's FTPS server in remote mode.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::http::StatusCode;
use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use md5::Digest;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::files::{ApiError, check_within};

pub type ByteStream = BoxStream<'static, std::io::Result<Bytes>>;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
}

pub struct Download {
    pub size: Option<u64>,
    pub body: ByteStream,
}

/// All paths are sanitized relative paths (see `files::sanitize_rel`);
/// the empty path is the root.
pub trait FileStore: Send + Sync {
    fn list<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<Vec<Entry>, ApiError>>;
    fn download<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<Download, ApiError>>;
    /// Deletes a file or an empty directory.
    fn delete<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<(), ApiError>>;
    /// Streams `body` to `rel` (creating parent dirs); returns (size, md5).
    fn upload<'a>(
        &'a self,
        rel: &'a Path,
        body: ByteStream,
    ) -> BoxFuture<'a, Result<(u64, String), ApiError>>;
    /// md5 of a file's contents.
    fn md5<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<String, ApiError>> {
        Box::pin(async move {
            let mut dl = self.download(rel).await?;
            let mut h = md5::Md5::new();
            while let Some(chunk) = dl.body.next().await {
                h.update(&chunk?);
            }
            Ok(crate::tls::hex(&h.finalize()))
        })
    }
}

pub fn sort_entries(v: &mut [Entry]) {
    v.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

pub struct LocalStore {
    pub root: PathBuf,
}

/// Removes a partially written upload if the request is dropped midway.
struct PartGuard(Option<PathBuf>);

impl Drop for PartGuard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

fn mtime_secs(m: &std::fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl LocalStore {
    async fn full(&self, rel: &Path) -> Result<PathBuf, ApiError> {
        let full = self.root.join(rel);
        check_within(&self.root, &full).await?;
        Ok(full)
    }
}

impl FileStore for LocalStore {
    fn list<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<Vec<Entry>, ApiError>> {
        Box::pin(async move {
            let full = self.full(rel).await?;
            if !tokio::fs::metadata(&full).await?.is_dir() {
                return Err(ApiError::bad_request("not a directory"));
            }
            let mut rd = tokio::fs::read_dir(&full).await?;
            let mut out = Vec::new();
            while let Some(e) = rd.next_entry().await? {
                // Follow symlinks for type/size; skip dangling ones.
                let Ok(m) = tokio::fs::metadata(e.path()).await else {
                    continue;
                };
                out.push(Entry {
                    name: e.file_name().to_string_lossy().into_owned(),
                    is_dir: m.is_dir(),
                    size: if m.is_dir() { 0 } else { m.len() },
                    mtime: mtime_secs(&m),
                });
            }
            Ok(out)
        })
    }

    fn download<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<Download, ApiError>> {
        Box::pin(async move {
            let full = self.full(rel).await?;
            let file = tokio::fs::File::open(&full).await?;
            let meta = file.metadata().await?;
            if !meta.is_file() {
                return Err(ApiError::bad_request("not a file"));
            }
            Ok(Download {
                size: Some(meta.len()),
                body: ReaderStream::with_capacity(file, 128 * 1024).boxed(),
            })
        })
    }

    fn delete<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<(), ApiError>> {
        Box::pin(async move {
            let full = self.full(rel).await?;
            if tokio::fs::symlink_metadata(&full).await?.is_dir() {
                tokio::fs::remove_dir(&full).await?;
            } else {
                tokio::fs::remove_file(&full).await?;
            }
            Ok(())
        })
    }

    fn upload<'a>(
        &'a self,
        rel: &'a Path,
        mut body: ByteStream,
    ) -> BoxFuture<'a, Result<(u64, String), ApiError>> {
        Box::pin(async move {
            let full = self.full(rel).await?;
            if let Ok(m) = tokio::fs::metadata(&full).await
                && m.is_dir()
            {
                return Err(ApiError::new(StatusCode::CONFLICT, "path is a directory"));
            }
            if let Some(parent) = full.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let mut part = full.clone().into_os_string();
            part.push(".part");
            let part = PathBuf::from(part);
            let mut guard = PartGuard(Some(part.clone()));

            let file = tokio::fs::File::create(&part).await?;
            let mut w = tokio::io::BufWriter::with_capacity(256 * 1024, file);
            let mut hasher = md5::Md5::new();
            let mut size: u64 = 0;
            while let Some(chunk) = body.next().await {
                let chunk =
                    chunk.map_err(|e| ApiError::bad_request(format!("upload aborted: {e}")))?;
                hasher.update(&chunk);
                size += chunk.len() as u64;
                w.write_all(&chunk).await?;
            }
            w.flush().await?;
            let file = w.into_inner();
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&part, &full).await?;
            guard.0 = None;
            Ok((size, crate::tls::hex(&hasher.finalize())))
        })
    }

    fn md5<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<String, ApiError>> {
        Box::pin(async move {
            let full = self.full(rel).await?;
            if !tokio::fs::metadata(&full).await?.is_file() {
                return Err(ApiError::bad_request("not a file"));
            }
            // Hash off the async runtime with plain blocking reads.
            tokio::task::spawn_blocking(move || {
                use std::io::Read;
                let mut f = std::fs::File::open(full)?;
                let mut h = md5::Md5::new();
                let mut buf = vec![0u8; 128 * 1024];
                loop {
                    let n = f.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    h.update(&buf[..n]);
                }
                Ok::<_, std::io::Error>(crate::tls::hex(&h.finalize()))
            })
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .map_err(ApiError::from)
        })
    }
}
