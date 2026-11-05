//! Camera bridge: one upstream RTSP session shared by all /api/camera
//! WebSocket clients, started on demand.

pub mod h264;
pub mod rtsp;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use bytes::Bytes;
use serde_json::json;
use tokio::sync::{Notify, broadcast};
use tracing::{debug, info, warn};

use crate::App;
use crate::config::Config;
use h264::{Assembler, Clock, Output, parse_rtp};
use rtsp::{Conn, Msg};

#[derive(Clone)]
enum CamEvent {
    Config(Utf8Bytes),
    Frame { key: bool, data: Bytes },
    Error(Utf8Bytes),
}

pub struct CameraHub {
    tx: broadcast::Sender<CamEvent>,
    wake: Notify,
    config: Mutex<Option<Utf8Bytes>>,
    available: AtomicBool,
}

/// Keep the upstream session this long after the last client leaves, so a
/// page reload doesn't cost a full RTSP handshake.
const LINGER: Duration = Duration::from_secs(5);
/// Give up on a session that delivers no media for this long.
const STALL: Duration = Duration::from_secs(15);

impl CameraHub {
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(64);
        Arc::new(Self {
            tx,
            wake: Notify::new(),
            config: Mutex::new(None),
            available: AtomicBool::new(true),
        })
    }

    pub fn available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    fn clients(&self) -> usize {
        self.tx.receiver_count()
    }

    fn error(&self, msg: &str) {
        let _ = self.tx.send(CamEvent::Error(
            json!({"type": "error", "message": msg}).to_string().into(),
        ));
    }

    fn set_codec(&self, codec: &str) {
        let text: Utf8Bytes = json!({"type": "config", "codec": codec}).to_string().into();
        *self.config.lock().unwrap() = Some(text.clone());
        let _ = self.tx.send(CamEvent::Config(text));
    }
}

/// Upstream manager: runs a session whenever clients are connected.
pub async fn run(hub: Arc<CameraHub>, cfg: Arc<Config>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        while hub.clients() == 0 {
            hub.wake.notified().await;
        }
        let Some(url) = cfg.rtsp_url() else {
            hub.available.store(false, Ordering::Relaxed);
            hub.error("no camera URL: access code unknown");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        };
        let started = Instant::now();
        match session(&hub, &url).await {
            Ok(()) => {
                debug!("camera session closed (no clients)");
                backoff = Duration::from_secs(1);
                continue;
            }
            Err(e) => {
                warn!("camera: {e}");
                hub.available.store(false, Ordering::Relaxed);
                hub.error(&e);
            }
        }
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn session(hub: &CameraHub, url: &str) -> Result<(), String> {
    let url = rtsp::parse_url(url)?;
    let mut c = Conn::connect(url).await?;
    let base_url = c.url.url.clone();

    let opts = c.request("OPTIONS", &base_url, &[]).await?;
    let mut use_get_parameter = opts.header("Public").is_some_and(|p| {
        p.split(',')
            .any(|m| m.trim().eq_ignore_ascii_case("GET_PARAMETER"))
    });

    let desc = c
        .request("DESCRIBE", &base_url, &[("Accept", "application/sdp")])
        .await?;
    if desc.status != 200 {
        return Err(format!("camera DESCRIBE failed: {}", desc.status));
    }
    let base = desc
        .header("Content-Base")
        .or(desc.header("Content-Location"))
        .unwrap_or(&base_url)
        .to_string();
    let sdp = String::from_utf8_lossy(&desc.body);
    let track = rtsp::parse_sdp(&sdp).ok_or("camera SDP has no video track")?;

    let setup_url = rtsp::control_url(&base, track.control.as_deref());
    let setup = c
        .request(
            "SETUP",
            &setup_url,
            &[("Transport", "RTP/AVP/TCP;unicast;interleaved=0-1")],
        )
        .await?;
    if setup.status != 200 {
        return Err(format!("camera SETUP failed: {}", setup.status));
    }
    let (sid, timeout) = rtsp::parse_session(
        setup
            .header("Session")
            .ok_or("camera SETUP returned no session")?,
    );
    c.session = Some(sid);
    let rtp_channel = setup
        .header("Transport")
        .and_then(rtsp::interleaved_channel)
        .unwrap_or(0);

    let play = c.request("PLAY", &base, &[("Range", "npt=0.000-")]).await?;
    if play.status != 200 {
        return Err(format!("camera PLAY failed: {}", play.status));
    }
    info!(codec_hint = ?track.sprop.first().and_then(|s| h264::codec_string(s)), "camera stream started");
    hub.available.store(true, Ordering::Relaxed);

    let mut asm = Assembler::new();
    let mut clock = Clock::new(track.clock_rate);
    let mut out = Vec::new();
    asm.set_parameter_sets(&track.sprop, &mut out);
    emit(hub, &mut clock, &mut out);

    let keepalive_every = Duration::from_secs(timeout.map(|t| (t / 2).clamp(5, 30)).unwrap_or(30));
    let mut keepalive = tokio::time::interval_at(
        tokio::time::Instant::now() + keepalive_every,
        keepalive_every,
    );
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut last_media = Instant::now();
    let mut idle_since: Option<Instant> = None;
    let mut keepalive_cseq = None;

    loop {
        tokio::select! {
            msg = c.read_msg() => match msg? {
                Msg::Interleaved { channel, data } if channel == rtp_channel => {
                    last_media = Instant::now();
                    if let Some(pkt) = parse_rtp(&data)
                        && track.payload_type.is_none_or(|pt| pt == pkt.payload_type) {
                            asm.push(&pkt, &mut out);
                            emit(hub, &mut clock, &mut out);
                        }
                }
                Msg::Interleaved { .. } | Msg::Other => {}
                Msg::Response(r) => {
                    let cseq = r.header("CSeq").and_then(|s| s.parse::<u32>().ok());
                    if use_get_parameter && cseq.is_some() && cseq == keepalive_cseq && matches!(r.status, 405 | 451 | 501) {
                        debug!("camera rejected GET_PARAMETER; using OPTIONS for keepalive");
                        use_get_parameter = false;
                    }
                }
            },
            _ = keepalive.tick() => {
                let method = if use_get_parameter { "GET_PARAMETER" } else { "OPTIONS" };
                keepalive_cseq = Some(c.send(method, &base, &[]).await?);
            }
            _ = tick.tick() => {
                if last_media.elapsed() > STALL {
                    return Err("camera stream stalled".into());
                }
                if hub.clients() == 0 {
                    let since = *idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= LINGER {
                        let _ = tokio::time::timeout(Duration::from_secs(1), c.send("TEARDOWN", &base, &[])).await;
                        c.shutdown().await;
                        return Ok(());
                    }
                } else {
                    idle_since = None;
                }
            }
        }
    }
}

fn emit(hub: &CameraHub, clock: &mut Clock, out: &mut Vec<Output>) {
    for o in out.drain(..) {
        match o {
            Output::Config(codec) => {
                info!(%codec, "camera codec");
                hub.set_codec(&codec);
            }
            Output::Frame {
                key,
                timestamp,
                data,
            } => {
                let us = clock.micros(timestamp);
                let mut buf = Vec::with_capacity(9 + data.len());
                buf.push(key as u8);
                buf.extend_from_slice(&us.to_be_bytes());
                buf.extend_from_slice(&data);
                let _ = hub.tx.send(CamEvent::Frame {
                    key,
                    data: buf.into(),
                });
            }
        }
    }
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    ws.max_message_size(64 * 1024)
        .on_upgrade(move |s| ws_client(s, app.camera.clone()))
}

async fn ws_client(mut ws: WebSocket, hub: Arc<CameraHub>) {
    let mut rx = hub.tx.subscribe();
    hub.wake.notify_one();
    let cfg = hub.config.lock().unwrap().clone();
    if let Some(cfg) = cfg
        && ws.send(Message::Text(cfg)).await.is_err()
    {
        return;
    }
    let mut waiting_key = true;
    loop {
        tokio::select! {
            ev = rx.recv() => {
                let msg = match ev {
                    Ok(CamEvent::Config(t)) | Ok(CamEvent::Error(t)) => Message::Text(t),
                    Ok(CamEvent::Frame { key, data }) => {
                        if waiting_key && !key {
                            continue;
                        }
                        waiting_key = false;
                        Message::Binary(data)
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        waiting_key = true;
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                };
                if ws.send(msg).await.is_err() {
                    return;
                }
            }
            m = ws.recv() => match m {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => {}
            },
        }
    }
}
