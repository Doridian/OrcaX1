//! Camera bridge: one upstream RTSP session, started on demand and shared
//! by all WebRTC (WHEP) viewers.

pub mod h264;
pub mod rtsp;
pub mod webrtc;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tokio::sync::{Notify, broadcast};
use tracing::{debug, info, warn};

use crate::App;
use crate::config::Config;
use h264::{Assembler, Clock, Output, parse_rtp};
use rtsp::{Conn, Msg};

/// One H.264 access unit (Annex-B; keyframes carry SPS and PPS).
#[derive(Clone)]
struct Frame {
    key: bool,
    /// Presentation time in microseconds, from the RTP clock.
    us: u64,
    data: Arc<[u8]>,
}

pub struct CameraHub {
    tx: broadcast::Sender<Frame>,
    wake: Notify,
    /// Current codec string, e.g. "avc1.640028".
    codec: Mutex<Option<String>>,
    /// Why the last upstream attempt failed; cleared when a stream starts.
    last_error: Mutex<Option<String>>,
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
            codec: Mutex::new(None),
            last_error: Mutex::new(None),
            available: AtomicBool::new(true),
        })
    }

    pub fn available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    fn clients(&self) -> usize {
        self.tx.receiver_count()
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }

    fn error(&self, msg: &str) {
        self.available.store(false, Ordering::Relaxed);
        *self.last_error.lock().unwrap() = Some(msg.to_string());
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
    *hub.last_error.lock().unwrap() = None;

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
                *hub.codec.lock().unwrap() = Some(codec);
            }
            Output::Frame {
                key,
                timestamp,
                data,
            } => {
                let _ = hub.tx.send(Frame {
                    key,
                    us: clock.micros(timestamp),
                    data: data.into(),
                });
            }
        }
    }
}

fn whep_error(status: StatusCode, msg: impl Into<String>) -> Response {
    crate::files::ApiError::new(status, msg).into_response()
}

/// `POST /api/camera/whep`: WHEP (RFC 9725) offer -> answer.
pub async fn whep_offer(State(app): State<Arc<App>>, body: String) -> Response {
    // Accepted even while the camera is failing: the viewer's subscription
    // is what keeps the upstream retrying (see /api/info camera_error).
    match app.webrtc.offer(body).await {
        Ok((id, answer)) => (
            StatusCode::CREATED,
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/sdp"),
                ),
                (
                    header::LOCATION,
                    HeaderValue::from_str(&format!("/api/camera/whep/{id}"))
                        .expect("ascii location"),
                ),
            ],
            answer,
        )
            .into_response(),
        Err(webrtc::OfferError::BadOffer(e)) => {
            debug!("webrtc offer rejected: {e}");
            whep_error(StatusCode::BAD_REQUEST, e)
        }
        Err(webrtc::OfferError::Busy) => {
            whep_error(StatusCode::SERVICE_UNAVAILABLE, "too many WebRTC viewers")
        }
        Err(webrtc::OfferError::Internal(e)) => {
            warn!("webrtc: {e}");
            whep_error(StatusCode::SERVICE_UNAVAILABLE, e)
        }
    }
}

/// `DELETE /api/camera/whep/{id}`: end a WHEP session.
pub async fn whep_delete(State(app): State<Arc<App>>, Path(id): Path<u64>) -> StatusCode {
    app.webrtc.close(id).await;
    StatusCode::OK
}
