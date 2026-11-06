//! Self-update from a release zip uploaded through the web UI.
//!
//! `POST /api/update` takes the same `orcax1-<version>.zip` that is unpacked
//! onto the SD card for a manual install. The daemon:
//!
//! 1. streams it to `<install dir>/.update.zip`,
//! 2. extracts it to `<install dir>/.update/` and checks it is a release
//!    (orcax1d, www/index.html, install.sh, S99orcax1d),
//! 3. runs the new binary's `--version` from the directory the current one
//!    runs from (the SD card is not executable), which catches a wrong
//!    architecture or a broken download before anything is replaced,
//! 4. swaps each top-level file and directory into place (the old ones go to
//!    `.update-old/` and are put back if a step fails), and
//! 5. replies, then runs `install.sh` detached, which restarts the daemon.
//!
//! The UI waits for `boot_id` in `/api/info` to change.

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

use crate::App;
use crate::files::ApiError;

/// Largest zip accepted (a release is ~10 MB).
const MAX_ZIP: u64 = 256 << 20;
/// Largest total unpacked size, against zip bombs.
const MAX_UNPACKED: u64 = 512 << 20;
/// Where install.sh's output goes when the daemon runs it.
pub const LOG: &str = "/tmp/orcax1d-update.log";

const ZIP_NAME: &str = ".update.zip";
const STAGE_DIR: &str = ".update";
const OLD_DIR: &str = ".update-old";
/// Never taken from a zip: user data and our own scratch space.
const RESERVED: &[&str] = &["state", "orcax1d.conf", ZIP_NAME, STAGE_DIR, OLD_DIR];
const REQUIRED: &[&str] = &["orcax1d", "www/index.html", "install.sh", "S99orcax1d"];

/// Set while an update runs, and left set once install.sh has been started
/// (the daemon is about to be restarted).
static BUSY: AtomicBool = AtomicBool::new(false);

struct BusyGuard {
    keep: bool,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if !self.keep {
            BUSY.store(false, Ordering::SeqCst);
        }
    }
}

/// Whether the daemon can update itself: it runs on the printer from an
/// install made by install.sh (not in remote/development mode).
pub fn available(app: &App) -> bool {
    app.cfg.printer.is_none() && app.cfg.install_dir.join("install.sh").is_file()
}

/// The installed release (the VERSION file from the zip), if any.
pub fn release(app: &App) -> Option<String> {
    let v = std::fs::read_to_string(app.cfg.install_dir.join("VERSION")).ok()?;
    let v = v.trim();
    (!v.is_empty()).then(|| v.to_string())
}

pub async fn upload(State(app): State<Arc<App>>, body: Body) -> Result<Response, ApiError> {
    if !available(&app) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "updates need orcax1d installed on the printer with install.sh ({} not found{})",
                app.cfg.install_dir.join("install.sh").display(),
                if app.cfg.printer.is_some() {
                    ", and the daemon is in remote mode"
                } else {
                    ""
                }
            ),
        ));
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "an update is already in progress",
        ));
    }
    let mut guard = BusyGuard { keep: false };
    let dir = app.cfg.install_dir.clone();

    let zip_path = dir.join(ZIP_NAME);
    let size = receive(body, &zip_path).await?;
    info!(size, "update zip received");

    let res = install(&dir, &zip_path).await;
    let _ = tokio::fs::remove_file(&zip_path).await;
    let version = res?;

    // Reply first: install.sh restarts the daemon, ending this connection.
    guard.keep = true;
    let script = dir.join("install.sh");
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Err(e) = run_install(&script) {
            warn!("could not start {}: {e}", script.display());
            BUSY.store(false, Ordering::SeqCst);
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "version": version, "log": LOG })),
    )
        .into_response())
}

/// Streams the request body to `path`, up to MAX_ZIP bytes.
async fn receive(body: Body, path: &Path) -> Result<u64, ApiError> {
    let mut f = tokio::fs::File::create(path).await?;
    let mut stream = body.into_data_stream();
    let mut size = 0u64;
    let res: Result<(), ApiError> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ApiError::bad_request(format!("upload: {e}")))?;
            size += chunk.len() as u64;
            if size > MAX_ZIP {
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("zip is larger than {} MB", MAX_ZIP >> 20),
                ));
            }
            f.write_all(&chunk).await?;
        }
        f.flush().await?;
        f.sync_all().await?;
        Ok(())
    }
    .await;
    if let Err(e) = res {
        drop(f);
        let _ = tokio::fs::remove_file(path).await;
        return Err(e);
    }
    Ok(size)
}

/// Extracts, checks and swaps in the release. Returns its version.
async fn install(dir: &Path, zip_path: &Path) -> Result<String, ApiError> {
    let stage = dir.join(STAGE_DIR);
    let (zip_path2, stage2) = (zip_path.to_path_buf(), stage.clone());
    let root = tokio::task::spawn_blocking(move || extract(&zip_path2, &stage2))
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let res = async {
        let root = root?;
        let version = std::fs::read_to_string(root.join("VERSION"))
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        check_binary(&root.join("orcax1d")).await?;
        let (dir2, root2) = (dir.to_path_buf(), root.clone());
        tokio::task::spawn_blocking(move || swap(&dir2, &root2))
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .map_err(|e| {
                ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("install: {e}"))
            })?;
        info!(%version, "update installed, running install.sh");
        Ok(version)
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&stage).await;
    res
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::bad_request(msg)
}

/// Unpacks `zip_path` into a fresh `stage`. Returns the release root inside
/// it: `stage/orcax1` for a release zip, or `stage` when the zip holds the
/// files without the folder.
fn extract(zip_path: &Path, stage: &Path) -> Result<PathBuf, ApiError> {
    if stage.exists() {
        std::fs::remove_dir_all(stage)?;
    }
    std::fs::create_dir_all(stage)?;
    let f = std::fs::File::open(zip_path)?;
    let mut zip = zip::ZipArchive::new(io::BufReader::new(f))
        .map_err(|e| bad(format!("not a zip file: {e}")))?;

    let names: Vec<String> = zip
        .file_names()
        .map(|n| n.map(|n| n.into_owned()))
        .collect::<Result<_, _>>()
        .map_err(|e| bad(format!("bad zip: {e}")))?;
    let prefix = if names.iter().any(|n| n == "orcax1/install.sh") {
        "orcax1/"
    } else if names.iter().any(|n| n == "install.sh") {
        ""
    } else {
        return Err(bad(
            "not an OrcaX1 release zip (no orcax1/install.sh in it)",
        ));
    };

    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| bad(format!("zip entry {i}: {e}")))?;
        let raw = entry
            .name()
            .map_err(|e| bad(format!("zip entry {i}: {e}")))?
            .into_owned();
        let Some(rel) = raw.strip_prefix(prefix) else {
            continue; // Anything outside the release folder.
        };
        let Some(rel_path) = entry.enclosed_name() else {
            return Err(bad(format!("unsafe path in zip: {raw:?}")));
        };
        let first = rel.split('/').next().unwrap_or_default();
        if rel.is_empty() || first.is_empty() {
            continue;
        }
        if RESERVED.contains(&first) {
            return Err(bad(format!("zip must not contain {raw:?}")));
        }
        if entry.is_symlink() {
            return Err(bad(format!("zip must not contain symlinks ({raw:?})")));
        }
        let dest = stage.join(
            rel_path
                .strip_prefix(prefix.trim_end_matches('/'))
                .unwrap_or(&rel_path),
        );
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)?;
            continue;
        }
        total += entry.size();
        if total > MAX_UNPACKED {
            return Err(bad(format!(
                "zip unpacks to more than {} MB",
                MAX_UNPACKED >> 20
            )));
        }
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p)?;
        }
        let mut out = std::fs::File::create(&dest)?;
        // Bound the copy by the declared size, whatever the stream says.
        let declared = entry.size();
        let n = io::copy(&mut (&mut entry).take(declared + 1), &mut out)
            .map_err(|e| bad(format!("{raw}: {e}")))?;
        if n != declared {
            return Err(bad(format!("{raw}: size mismatch")));
        }
    }

    for r in REQUIRED {
        if !stage.join(r).is_file() {
            return Err(bad(format!("release is incomplete: {prefix}{r} missing")));
        }
    }
    Ok(stage.to_path_buf())
}

/// Runs `<new binary> --version` from the running binary's directory.
async fn check_binary(bin: &Path) -> Result<(), ApiError> {
    use std::os::unix::fs::PermissionsExt;
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .ok_or_else(|| {
            ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "cannot find own binary")
        })?;
    let probe = exe_dir.join("orcax1d.update-check");
    tokio::fs::copy(bin, &probe).await?;
    let res = async {
        tokio::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755)).await?;
        let out = tokio::time::timeout(
            Duration::from_secs(20),
            tokio::process::Command::new(&probe)
                .arg("--version")
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| bad("the new orcax1d did not answer --version in time"))?
        .map_err(|e| bad(format!("the new orcax1d does not run on this printer: {e}")))?;
        let s = String::from_utf8_lossy(&out.stdout);
        if !out.status.success() || !s.starts_with("orcax1d ") {
            return Err(bad(format!(
                "the new orcax1d failed its self-check ({}): {}",
                out.status,
                s.trim()
            )));
        }
        info!(version = %s.trim(), "new binary runs");
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_file(&probe).await;
    res
}

/// Moves every top-level entry of `root` into `dir`, keeping what it
/// replaces in `dir/.update-old` until all moves are done; on failure the
/// moves made so far are undone.
fn swap(dir: &Path, root: &Path) -> io::Result<()> {
    let old = dir.join(OLD_DIR);
    if old.exists() {
        std::fs::remove_dir_all(&old)?;
    }
    std::fs::create_dir(&old)?;

    // Directories last, so a failure leaves the small files to undo first.
    let mut items: Vec<(String, bool)> = std::fs::read_dir(root)?
        .map(|e| {
            let e = e?;
            Ok((
                e.file_name().to_string_lossy().into_owned(),
                e.file_type()?.is_dir(),
            ))
        })
        .collect::<io::Result<_>>()?;
    items.sort_by_key(|(n, d)| (*d, n.clone()));

    // (name, whether something was moved aside)
    let mut done: Vec<(String, bool)> = Vec::new();
    let res = (|| {
        for (name, _) in &items {
            let dst = dir.join(name);
            let had = dst.exists();
            if had {
                std::fs::rename(&dst, old.join(name))?;
            }
            if let Err(e) = std::fs::rename(root.join(name), &dst) {
                if had {
                    let _ = std::fs::rename(old.join(name), &dst);
                }
                return Err(e);
            }
            done.push((name.clone(), had));
        }
        Ok(())
    })();
    if let Err(e) = res {
        for (name, had) in done.iter().rev() {
            let dst = dir.join(name);
            let _ = if dst.is_dir() {
                std::fs::remove_dir_all(&dst)
            } else {
                std::fs::remove_file(&dst)
            };
            if *had {
                let _ = std::fs::rename(old.join(name), &dst);
            }
        }
        let _ = std::fs::remove_dir_all(&old);
        return Err(e);
    }
    if let Err(e) = std::fs::remove_dir_all(&old) {
        warn!("could not remove {}: {e}", old.display());
    }
    Ok(())
}

/// Starts `sh install.sh` in its own process group, writing to LOG, so it
/// outlives the daemon it restarts.
fn run_install(script: &Path) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    let log = std::fs::File::create(LOG)?;
    std::process::Command::new("sh")
        .arg(script)
        .current_dir("/")
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orcax1d-upd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_zip(path: &Path, files: &[(&str, &[u8])]) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (n, data) in files {
            z.start_file(*n, opts).unwrap();
            z.write_all(data).unwrap();
        }
        z.finish().unwrap();
    }

    const RELEASE: &[(&str, &[u8])] = &[
        ("orcax1/orcax1d", b"bin"),
        ("orcax1/www/index.html", b"<html>"),
        ("orcax1/www/assets/a.js.gz", b"js"),
        ("orcax1/install.sh", b"#!/bin/sh"),
        ("orcax1/S99orcax1d", b"#!/bin/sh"),
        ("orcax1/VERSION", b"v9\n"),
    ];

    #[test]
    fn extract_and_swap() {
        let d = tmp("ok");
        let inst = d.join("orcax1");
        std::fs::create_dir_all(inst.join("www/old")).unwrap();
        std::fs::write(inst.join("www/old/stale.js"), b"x").unwrap();
        std::fs::write(inst.join("orcax1d"), b"oldbin").unwrap();
        std::fs::create_dir_all(inst.join("state")).unwrap();
        std::fs::write(inst.join("state/key"), b"k").unwrap();

        let z = d.join("r.zip");
        make_zip(&z, RELEASE);
        let root = extract(&z, &inst.join(STAGE_DIR)).unwrap();
        swap(&inst, &root).unwrap();
        assert_eq!(std::fs::read(inst.join("orcax1d")).unwrap(), b"bin");
        assert_eq!(std::fs::read(inst.join("VERSION")).unwrap(), b"v9\n");
        assert!(inst.join("www/assets/a.js.gz").is_file());
        assert!(!inst.join("www/old").exists(), "old web files are dropped");
        assert_eq!(std::fs::read(inst.join("state/key")).unwrap(), b"k");
        assert!(!inst.join(OLD_DIR).exists());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn rejects_bad_zips() {
        let d = tmp("bad");
        let z = d.join("r.zip");
        let stage = d.join("stage");

        make_zip(&z, &[("orcax1/install.sh", b"x")]);
        assert!(extract(&z, &stage).unwrap_err().1.contains("incomplete"));

        let mut evil = RELEASE.to_vec();
        evil.push(("orcax1/state/auth.key", b"x"));
        make_zip(&z, &evil);
        assert!(
            extract(&z, &stage)
                .unwrap_err()
                .1
                .contains("must not contain")
        );

        let mut evil = RELEASE.to_vec();
        evil.push(("orcax1/../../etc/passwd", b"x"));
        make_zip(&z, &evil);
        assert!(extract(&z, &stage).is_err());

        make_zip(&z, &[("hello.txt", b"x")]);
        assert!(extract(&z, &stage).unwrap_err().1.contains("not an OrcaX1"));

        std::fs::write(&z, b"not a zip").unwrap();
        assert!(extract(&z, &stage).unwrap_err().1.contains("not a zip"));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn swap_keeps_other_entries() {
        let d = tmp("keep");
        let inst = d.join("inst");
        let root = d.join("new");
        std::fs::create_dir_all(inst.join("state")).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(inst.join("a"), b"old").unwrap();
        std::fs::write(inst.join("orcax1d.conf"), b"conf").unwrap();
        std::fs::write(root.join("a"), b"new").unwrap();
        std::fs::write(root.join("b"), b"new").unwrap();
        swap(&inst, &root).unwrap();
        assert_eq!(std::fs::read(inst.join("a")).unwrap(), b"new");
        assert_eq!(std::fs::read(inst.join("b")).unwrap(), b"new");
        assert_eq!(std::fs::read(inst.join("orcax1d.conf")).unwrap(), b"conf");
        assert!(inst.join("state").is_dir());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
