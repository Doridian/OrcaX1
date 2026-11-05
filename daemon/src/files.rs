//! SD card file API.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;

use crate::App;
use crate::store::sort_entries;

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn new(code: StatusCode, msg: impl Into<String>) -> Self {
        Self(code, msg.into())
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        let code = match e.kind() {
            NotFound => StatusCode::NOT_FOUND,
            PermissionDenied => StatusCode::FORBIDDEN,
            AlreadyExists => StatusCode::CONFLICT,
            DirectoryNotEmpty => StatusCode::CONFLICT,
            NotADirectory | IsADirectory => StatusCode::BAD_REQUEST,
            StorageFull => StatusCode::INSUFFICIENT_STORAGE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(code, e.to_string())
    }
}

/// Turns a client-supplied relative path into a clean relative PathBuf.
/// Rejects absolute paths, `..`, NUL and backslashes. Empty and `.`
/// components are dropped, so "" means the root.
pub fn sanitize_rel(p: &str) -> Result<PathBuf, &'static str> {
    if p.contains('\0') {
        return Err("path contains NUL");
    }
    if p.contains('\\') {
        return Err("path contains a backslash");
    }
    if p.starts_with('/') {
        return Err("path must be relative");
    }
    let mut out = PathBuf::new();
    for comp in p.split('/') {
        match comp {
            "" | "." => {}
            ".." => return Err("path must not contain '..'"),
            c => out.push(c),
        }
    }
    // Belt and braces: everything left must be a plain name.
    if out.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("invalid path");
    }
    Ok(out)
}

pub fn rel_to_string(p: &Path) -> String {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Ensures `full` does not escape `root` through symlinks: the deepest
/// existing ancestor of `full` must canonicalize to somewhere under `root`.
pub async fn check_within(root: &Path, full: &Path) -> Result<(), ApiError> {
    let root_c = tokio::fs::canonicalize(root).await.map_err(|e| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("root {}: {e}", root.display()),
        )
    })?;
    let mut probe = full.to_path_buf();
    loop {
        match tokio::fs::canonicalize(&probe).await {
            Ok(c) => {
                return if c.starts_with(&root_c) {
                    Ok(())
                } else {
                    Err(ApiError::bad_request("path escapes the SD root"))
                };
            }
            Err(_) => {
                if !probe.pop() {
                    return Err(ApiError::bad_request("invalid path"));
                }
            }
        }
    }
}

fn resolve(raw: &str) -> Result<PathBuf, ApiError> {
    sanitize_rel(raw).map_err(ApiError::bad_request)
}

#[derive(Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    path: String,
}

pub async fn list(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let rel = resolve(&q.path)?;
    let mut out = app.store.list(&rel).await?;
    sort_entries(&mut out);
    Ok(Json(out).into_response())
}

pub fn content_disposition(name: &str) -> HeaderValue {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let enc = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{enc}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

pub async fn download(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let rel = resolve(&q.path)?;
    if rel.as_os_str().is_empty() {
        return Err(ApiError::bad_request("not a file"));
    }
    let dl = app.store.download(&rel).await?;
    let name = rel
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut res = Body::from_stream(dl.body).into_response();
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    if let Some(size) = dl.size {
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    }
    h.insert(header::CONTENT_DISPOSITION, content_disposition(&name));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

pub async fn delete(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
) -> Result<StatusCode, ApiError> {
    let rel = resolve(&q.path)?;
    if rel.as_os_str().is_empty() {
        return Err(ApiError::bad_request("refusing to delete the SD root"));
    }
    app.store.delete(&rel).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn upload(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
    body: Body,
) -> Result<Response, ApiError> {
    let rel = resolve(&q.path)?;
    if rel.as_os_str().is_empty() || q.path.ends_with('/') {
        return Err(ApiError::bad_request("path must name a file"));
    }
    let stream = body
        .into_data_stream()
        .map(|r| r.map_err(std::io::Error::other))
        .boxed();
    let (size, md5) = app.store.upload(&rel, stream).await?;
    let path = rel_to_string(&rel);
    tracing::info!(%path, size, %md5, "upload complete");
    Ok(Json(json!({ "path": path, "size": size, "md5": md5 })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_accepts_relative() {
        assert_eq!(sanitize_rel("").unwrap(), PathBuf::new());
        assert_eq!(sanitize_rel("a/b.3mf").unwrap(), PathBuf::from("a/b.3mf"));
        assert_eq!(sanitize_rel("a//./b/").unwrap(), PathBuf::from("a/b"));
        assert_eq!(
            sanitize_rel("my model.gcode.3mf").unwrap(),
            PathBuf::from("my model.gcode.3mf")
        );
        assert_eq!(sanitize_rel("..foo").unwrap(), PathBuf::from("..foo"));
    }

    #[test]
    fn sanitize_rejects_escapes() {
        for bad in [
            "..",
            "../x",
            "a/../../x",
            "a/..",
            "/etc/passwd",
            "a\\..\\b",
            "a\0b",
            "/",
        ] {
            assert!(sanitize_rel(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn rel_string_roundtrip() {
        assert_eq!(
            rel_to_string(&sanitize_rel("x/./y//z.gcode").unwrap()),
            "x/y/z.gcode"
        );
    }

    #[tokio::test]
    async fn check_within_blocks_symlink_escape() {
        let tmp = std::env::temp_dir().join(format!("orcax1d-test-{}", std::process::id()));
        let root = tmp.join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink("/", root.join("evil")).unwrap();
        assert!(check_within(&root, &root.join("ok/new.txt")).await.is_ok());
        assert!(check_within(&root, &root.join("evil/etc")).await.is_err());
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
