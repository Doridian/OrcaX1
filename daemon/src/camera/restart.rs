//! Restarting the printer's camera service (`ipcam`).
//!
//! Bambu's `ipcam` serves the RTSPS stream from its embedded live555 server,
//! which can wedge: the thread spins at full CPU and never answers new
//! connections, so every attempt ends in "camera TLS handshake timeout".
//! Only restarting `ipcam` fixes that. Restarting alone is not enough,
//! though: the RTSP server is switched on by an `init` command that the
//! screen (`bbl_screen`) publishes on DDS once at boot, and a fresh `ipcam`
//! never gets it again. So after the restart we publish that command
//! ourselves, through X1Plus's Python DDS bindings.
//!
//! The restart interrupts everything else `ipcam` does, including recording
//! the current print's timelapse.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use tokio::process::Command;
use tracing::{info, warn};

use crate::App;
use crate::files::ApiError;

const INIT_SCRIPT: &str = "/etc/init.d/S99ipcam_service";
const X1PLUS_PYTHON: &str = "/opt/x1plus/lib/python";
const RTSPS_PORT: u16 = 322;

static BUSY: AtomicBool = AtomicBool::new(false);

/// Publishes the RTSP `init` that `bbl_screen` sends at boot (same fields;
/// the access code comes from the environment so it stays out of `ps`).
/// Waits for the publisher to match `ipcam`'s subscriber first: a message
/// published before discovery completes is lost. Prints `ORCAX1D_MATCHED`
/// when it matched.
const PUBLISH_INIT: &str = r#"
import ctypes as c, json, os, sys, threading, time
sys.path.insert(0, os.environ["ORCAX1D_X1PLUS_PYTHON"])
from x1plus import dds
matched = threading.Event()
@c.CFUNCTYPE(None, c.c_char_p, c.c_int)
def on_match(topic, change):
    if change > 0:
        matched.set()
try:
    pub = dds.dds_intf.createJSONPublisher(c.c_char_p(b"device/request/liveview"), on_match)
    ok = matched.wait(15)
    msg = json.dumps({
        "command": "liveview",
        "op_protocols": [{
            "command": "init", "type": "rtsp", "media_port": int(os.environ["ORCAX1D_PORT"]),
            "server_use_tls": 1, "streams_cfg": "default",
            "username": "bblp", "passwd": os.environ["ORCAX1D_CODE"],
        }],
        "peer_host": "orcax1d", "sequence_id": "0", "version": 1,
    })
    dds.dds_intf.publishJSON(c.c_void_p(pub), c.c_char_p(msg.encode()))
    time.sleep(1)
    print("ORCAX1D_MATCHED" if ok else "ORCAX1D_UNMATCHED", flush=True)
finally:
    dds.shutdown()
"#;

/// Whether this daemon can restart the camera service: it runs on the
/// printer (not in remote mode) under X1Plus.
pub fn available(app: &App) -> bool {
    app.cfg.printer.is_none()
        && Path::new(INIT_SCRIPT).is_file()
        && Path::new(X1PLUS_PYTHON).join("x1plus/dds.py").is_file()
}

/// `POST /api/camera/restart`: restart `ipcam` and switch its RTSP server
/// back on. Answers once the RTSPS port listens again (or with the step that
/// failed).
pub async fn restart(State(app): State<Arc<App>>) -> Result<Response, ApiError> {
    if !available(&app) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "restarting the camera service needs orcax1d running on an X1Plus printer",
        ));
    }
    let Some(code) = app.cfg.access_code() else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "access code unknown",
        ));
    };
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "the camera service is already restarting",
        ));
    }
    let result = run(&code).await;
    BUSY.store(false, Ordering::SeqCst);
    // Retry the stream now instead of after the backoff, either way.
    app.camera.retry_now();
    match result {
        Ok(()) => {
            info!("camera: ipcam restarted, RTSPS listening again");
            Ok(axum::Json(json!({"ok": true})).into_response())
        }
        Err(e) => {
            warn!("camera: ipcam restart failed: {e}");
            Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))
        }
    }
}

async fn run(code: &str) -> Result<(), String> {
    info!("camera: restarting ipcam");
    let old = ipcam_pids();
    init_script("stop").await?;
    // The init script doesn't wait for ipcam to exit, and starting while it
    // still runs is a no-op ("already running").
    if !wait_for(Duration::from_secs(15), || {
        let now = ipcam_pids();
        old.iter().all(|p| !now.contains(p))
    })
    .await
    {
        warn!("camera: ipcam didn't stop, killing it");
        for p in &old {
            let _ = Command::new("kill").args(["-9", &p.to_string()]).status().await;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    // X1Plus's watchdog may have started it again already; then this is a no-op.
    init_script("start").await?;
    if !wait_for(Duration::from_secs(10), || !ipcam_pids().is_empty()).await {
        return Err("ipcam didn't start again".into());
    }
    // ipcam subscribes to the topic ~1 s after starting but only builds its
    // liveview flow ~2 s later; an init that arrives in between is rejected
    // ("command value error"). The retry below covers slower starts.
    tokio::time::sleep(Duration::from_secs(5)).await;

    for attempt in 1..=3 {
        let matched = publish_init(code).await?;
        if wait_for(Duration::from_secs(10), rtsps_listening).await {
            return Ok(());
        }
        warn!(attempt, matched, "camera: RTSPS port not listening after the liveview init");
    }
    Err(format!(
        "ipcam restarted, but its RTSP server didn't come back on port {RTSPS_PORT}"
    ))
}

async fn init_script(action: &str) -> Result<(), String> {
    let out = tokio::time::timeout(
        Duration::from_secs(20),
        Command::new(INIT_SCRIPT).arg(action).output(),
    )
    .await
    .map_err(|_| format!("{INIT_SCRIPT} {action} timed out"))?
    .map_err(|e| format!("{INIT_SCRIPT} {action}: {e}"))?;
    info!(
        action,
        output = %String::from_utf8_lossy(&out.stdout).trim(),
        "camera: ipcam init script"
    );
    Ok(())
}

/// Runs [`PUBLISH_INIT`]; true if the publisher matched ipcam's subscriber.
async fn publish_init(code: &str) -> Result<bool, String> {
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new("python3")
            .arg("-c")
            .arg(PUBLISH_INIT)
            .env("ORCAX1D_X1PLUS_PYTHON", X1PLUS_PYTHON)
            .env("ORCAX1D_PORT", RTSPS_PORT.to_string())
            .env("ORCAX1D_CODE", code)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "publishing the liveview init timed out".to_string())?
    .map_err(|e| format!("python3: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
        return Err(format!("publishing the liveview init failed: {last}"));
    }
    Ok(stdout.contains("ORCAX1D_MATCHED"))
}

/// PIDs of running `ipcam` processes.
fn ipcam_pids() -> Vec<u32> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.filter_map(|e| {
        let e = e.ok()?;
        let pid: u32 = e.file_name().to_str()?.parse().ok()?;
        let comm = std::fs::read_to_string(e.path().join("comm")).ok()?;
        (comm.trim() == "ipcam").then_some(pid)
    })
    .collect()
}

/// Whether something listens on the RTSPS port. Read from /proc rather than
/// by connecting, so the check itself never touches ipcam's RTSP server.
fn rtsps_listening() -> bool {
    ["/proc/net/tcp", "/proc/net/tcp6"]
        .iter()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .any(|s| listening_on(&s, RTSPS_PORT))
}

/// Whether a /proc/net/tcp table has a LISTEN (state 0A) socket on `port`.
fn listening_on(table: &str, port: u16) -> bool {
    let want = format!("{port:04X}");
    table.lines().skip(1).any(|l| {
        let mut f = l.split_whitespace();
        let local = f.nth(1);
        let state = f.nth(1);
        state == Some("0A") && local.and_then(|a| a.rsplit(':').next()) == Some(want.as_str())
    })
}

async fn wait_for(limit: Duration, mut f: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    loop {
        if f() {
            return true;
        }
        if start.elapsed() >= limit {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listen_table() {
        let t = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   9: 00000000:0142 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 19032 1
  21: 0F0C020A:0142 010A020A:8F74 08 00000000:0000063E 02:0000404B 00000000     0        0 2781404 2
";
        assert!(listening_on(t, 322));
        assert!(!listening_on(t, 554));
        // Only the CLOSE_WAIT socket left: not listening.
        let t2 = "header\n  21: 0F0C020A:0142 010A020A:8F74 08 00000000:0000063E 02:0000404B 00000000 0 0 1 2\n";
        assert!(!listening_on(t2, 322));
    }
}
