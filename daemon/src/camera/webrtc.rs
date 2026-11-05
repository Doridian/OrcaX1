//! WebRTC (WHEP) delivery of the camera feed.
//!
//! The browser POSTs an SDP offer to `/api/camera/whep` and gets an answer
//! back; media then flows over UDP from one socket per local IP address, all
//! on the same port. The daemon is an ICE-lite peer with host candidates
//! only, so the browser needs a UDP route to one of the printer's addresses.
//!
//! Frames come from the shared upstream RTSP session (`CameraHub`) and are
//! written as-is: no transcoding. `str0m` packetizes
//! them (FU-A) and handles DTLS-SRTP, RTCP and NACK retransmission.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use str0m::change::SdpOffer;
use str0m::format::PayloadParams;
use str0m::media::{MediaKind, MediaTime, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, info, warn};

use super::{CameraHub, Frame};

/// Concurrent WebRTC viewers. Each one costs SRTP encryption on the printer.
const MAX_PEERS: usize = 8;
/// Drop a peer that hasn't completed ICE + DTLS by then.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

pub struct Offer {
    pub sdp: String,
    pub reply: oneshot::Sender<Result<(u64, String), OfferError>>,
}

pub enum OfferError {
    BadOffer(String),
    Busy,
    Internal(String),
}

enum Cmd {
    Offer(Offer),
    Close(u64),
}

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Cmd>,
}

impl Handle {
    pub async fn offer(&self, sdp: String) -> Result<(u64, String), OfferError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::Offer(Offer { sdp, reply }))
            .await
            .map_err(|_| OfferError::Internal("webrtc server stopped".into()))?;
        rx.await
            .map_err(|_| OfferError::Internal("webrtc server stopped".into()))?
    }

    pub async fn close(&self, id: u64) {
        let _ = self.tx.send(Cmd::Close(id)).await;
    }
}

/// Starts the WebRTC server task. `port` is the UDP port used on every
/// local address (0: a random one per address).
pub fn start(hub: Arc<CameraHub>, port: u16) -> Handle {
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(Server::new(hub, port).run(rx));
    Handle { tx }
}

struct Datagram {
    local: SocketAddr,
    source: SocketAddr,
    data: Vec<u8>,
}

struct Peer {
    id: u64,
    rtc: Rtc,
    created: Instant,
    mid: Option<Mid>,
    pt: Option<Pt>,
    connected: bool,
    waiting_key: bool,
    timeout: Instant,
}

struct Server {
    hub: Arc<CameraHub>,
    port: u16,
    sockets: HashMap<IpAddr, Arc<UdpSocket>>,
    net_tx: mpsc::Sender<Datagram>,
    net_rx: mpsc::Receiver<Datagram>,
    peers: Vec<Peer>,
    next_id: u64,
    frames: Option<broadcast::Receiver<Frame>>,
}

impl Server {
    fn new(hub: Arc<CameraHub>, port: u16) -> Self {
        let (net_tx, net_rx) = mpsc::channel(256);
        Self {
            hub,
            port,
            sockets: HashMap::new(),
            net_tx,
            net_rx,
            peers: Vec::new(),
            next_id: 1,
            frames: None,
        }
    }

    async fn run(mut self, mut cmds: mpsc::Receiver<Cmd>) {
        loop {
            let next = self.drive();
            // Only hold a frame subscription (which keeps the upstream RTSP
            // session alive) while someone is watching.
            if self.peers.is_empty() {
                self.frames = None;
            } else if self.frames.is_none() {
                self.frames = Some(self.hub.tx.subscribe());
                self.hub.wake.notify_one();
            }
            tokio::select! {
                cmd = cmds.recv() => match cmd {
                    Some(Cmd::Offer(o)) => {
                        let res = self.accept(o.sdp).await;
                        let _ = o.reply.send(res);
                    }
                    Some(Cmd::Close(id)) => {
                        if let Some(p) = self.peers.iter_mut().find(|p| p.id == id) {
                            debug!(peer = id, "webrtc: closed by client");
                            p.rtc.disconnect();
                        }
                    }
                    None => return,
                },
                Some(d) = self.net_rx.recv() => self.receive(d),
                ev = recv_frame(&mut self.frames) => self.frame(ev),
                _ = tokio::time::sleep_until(next.into()) => {
                    let now = Instant::now();
                    for p in &mut self.peers {
                        if p.timeout <= now
                            && let Err(e) = p.rtc.handle_input(Input::Timeout(now)) {
                                debug!(peer = p.id, "webrtc timeout: {e}");
                                p.rtc.disconnect();
                            }
                    }
                }
            }
        }
    }

    /// Binds a socket on each current local address that doesn't have one
    /// yet. Addresses can change (DHCP), so this runs for every offer.
    async fn refresh_sockets(&mut self) {
        let Ok(ifs) = if_addrs::get_if_addrs() else {
            return;
        };
        for i in ifs {
            let ip = i.ip();
            let usable = match ip {
                IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_link_local(),
                // Link-local v6 would need a scope id; skip it.
                IpAddr::V6(v6) => !v6.is_loopback() && !v6.is_unicast_link_local(),
            };
            if !usable || self.sockets.contains_key(&ip) {
                continue;
            }
            match UdpSocket::bind(SocketAddr::new(ip, self.port)).await {
                Ok(s) => {
                    let s = Arc::new(s);
                    let local = match s.local_addr() {
                        Ok(a) => a,
                        Err(_) => continue,
                    };
                    info!("webrtc: listening on udp {local}");
                    tokio::spawn(read_loop(s.clone(), local, self.net_tx.clone()));
                    self.sockets.insert(ip, s);
                }
                Err(e) => warn!("webrtc: bind udp {ip}:{}: {e}", self.port),
            }
        }
    }

    async fn accept(&mut self, sdp: String) -> Result<(u64, String), OfferError> {
        let offer =
            SdpOffer::from_sdp_string(&sdp).map_err(|e| OfferError::BadOffer(e.to_string()))?;
        if self.peers.len() >= MAX_PEERS {
            return Err(OfferError::Busy);
        }
        self.refresh_sockets().await;
        if self.sockets.is_empty() {
            return Err(OfferError::Internal("no usable UDP socket".into()));
        }

        let now = Instant::now();
        let mut rtc = Rtc::builder()
            .set_ice_lite(true)
            .clear_codecs()
            .enable_h264(true)
            .build(now);
        for s in self.sockets.values() {
            if let Ok(addr) = s.local_addr()
                && let Ok(c) = Candidate::host(addr, "udp")
            {
                rtc.add_local_candidate(c);
            }
        }
        let answer = rtc
            .sdp_api()
            .accept_offer(offer)
            .map_err(|e| OfferError::BadOffer(e.to_string()))?;

        let id = self.next_id;
        self.next_id += 1;
        let mut peer = Peer {
            id,
            rtc,
            created: now,
            mid: None,
            pt: None,
            connected: false,
            waiting_key: true,
            timeout: now,
        };
        let answer = answer.to_sdp_string();
        // str0m only reports MediaAdded once connected; read the video mid
        // from the answer so an offer we can't serve fails here and the
        // browser falls back right away.
        let Some(mid) = video_mid(&answer) else {
            return Err(OfferError::BadOffer("offer has no video to receive".into()));
        };
        peer.mid = Some(mid);
        let codec = self.hub.codec.lock().unwrap().clone();
        peer.pt = peer
            .rtc
            .writer(mid)
            .and_then(|w| pick_pt(w.payload_params(), codec.as_deref()));
        if peer.pt.is_none() {
            return Err(OfferError::BadOffer(
                "no common H.264 format (packetization-mode=1)".into(),
            ));
        }
        info!(peer = id, "webrtc: new viewer");
        self.peers.push(peer);
        Ok((id, answer))
    }

    fn receive(&mut self, d: Datagram) {
        let Ok(contents) = d.data.as_slice().try_into() else {
            return;
        };
        let input = Input::Receive(
            Instant::now(),
            Receive {
                proto: Protocol::Udp,
                source: d.source,
                destination: d.local,
                contents,
            },
        );
        if let Some(p) = self.peers.iter_mut().find(|p| p.rtc.accepts(&input))
            && let Err(e) = p.rtc.handle_input(input)
        {
            debug!(peer = p.id, "webrtc input: {e}");
            p.rtc.disconnect();
        }
    }

    fn frame(&mut self, ev: Result<Frame, broadcast::error::RecvError>) {
        let Frame { key, us, data } = match ev {
            Ok(f) => f,
            Err(broadcast::error::RecvError::Lagged(_)) => {
                for p in &mut self.peers {
                    p.waiting_key = true;
                }
                return;
            }
            Err(broadcast::error::RecvError::Closed) => {
                self.frames = None;
                return;
            }
        };
        let rtp_time = MediaTime::from_90khz(us.saturating_mul(9) / 100);
        let now = Instant::now();
        for p in &mut self.peers {
            let (Some(mid), Some(pt)) = (p.mid, p.pt) else {
                continue;
            };
            if !p.connected || (p.waiting_key && !key) {
                continue;
            }
            p.waiting_key = false;
            let Some(w) = p.rtc.writer(mid) else {
                continue;
            };
            if let Err(e) = w.write(pt, now, rtp_time, data.clone()) {
                debug!(peer = p.id, "webrtc write: {e}");
                p.rtc.disconnect();
            }
        }
    }

    /// Flushes every peer's output, drops dead peers and returns the next
    /// time a timeout is due.
    fn drive(&mut self) -> Instant {
        let now = Instant::now();
        let mut next = now + Duration::from_secs(1);
        for p in &mut self.peers {
            poll(p, &self.sockets);
            if !p.connected && now.duration_since(p.created) > CONNECT_TIMEOUT {
                debug!(peer = p.id, "webrtc: never connected");
                p.rtc.disconnect();
            }
            next = next.min(p.timeout);
        }
        self.peers.retain(|p| {
            let alive = p.rtc.is_alive();
            if !alive {
                info!(peer = p.id, "webrtc: viewer left");
            }
            alive
        });
        next.max(now)
    }
}

fn poll(p: &mut Peer, sockets: &HashMap<IpAddr, Arc<UdpSocket>>) {
    while p.rtc.is_alive() {
        match p.rtc.poll_output() {
            Ok(Output::Timeout(t)) => {
                p.timeout = t;
                return;
            }
            Ok(Output::Transmit(t)) => {
                if let Some(s) = sockets.get(&t.source.ip()) {
                    // Non-blocking: a full socket buffer drops the packet,
                    // which NACK/keyframes recover from.
                    let _ = s.try_send_to(&t.contents, t.destination);
                }
            }
            Ok(Output::Event(e)) => match e {
                Event::MediaAdded(m) if m.kind == MediaKind::Video => p.mid = Some(m.mid),
                Event::Connected => {
                    debug!(peer = p.id, "webrtc: connected");
                    p.connected = true;
                    p.waiting_key = true;
                }
                Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                    p.rtc.disconnect();
                }
                _ => {}
            },
            Err(e) => {
                debug!(peer = p.id, "webrtc: {e}");
                p.rtc.disconnect();
            }
        }
    }
}

/// Picks the negotiated H.264 payload type to send with: one using
/// packetization-mode=1 (FU-A, needed for frames larger than a packet),
/// preferring the camera's own profile.
fn pick_pt<'a>(params: impl Iterator<Item = &'a PayloadParams>, codec: Option<&str>) -> Option<Pt> {
    // "avc1.PPCCLL" -> profile_idc PP
    let profile = codec
        .and_then(|c| c.strip_prefix("avc1."))
        .and_then(|h| u8::from_str_radix(h.get(0..2)?, 16).ok());
    let mut best: Option<(bool, Pt)> = None;
    for p in params {
        let f = p.spec().format;
        if f.packetization_mode != Some(1) {
            continue;
        }
        let matches = profile.is_some_and(|want| {
            f.profile_level_id
                .is_some_and(|pl| (pl >> 16) as u8 == want)
        });
        if best.is_none_or(|(m, _)| matches && !m) {
            best = Some((matches, p.pt()));
        }
    }
    best.map(|(_, pt)| pt)
}

/// The mid of the first (active) video m-line in an SDP.
fn video_mid(sdp: &str) -> Option<Mid> {
    let mut in_video = false;
    for line in sdp.lines() {
        if let Some(m) = line.strip_prefix("m=") {
            // A rejected m-line has port 0.
            in_video = m.starts_with("video ") && !m.starts_with("video 0 ");
        } else if in_video && let Some(mid) = line.strip_prefix("a=mid:") {
            return Some(Mid::from(mid.trim()));
        }
    }
    None
}

async fn recv_frame(
    rx: &mut Option<broadcast::Receiver<Frame>>,
) -> Result<Frame, broadcast::error::RecvError> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

async fn read_loop(s: Arc<UdpSocket>, local: SocketAddr, tx: mpsc::Sender<Datagram>) {
    let mut buf = vec![0u8; 2048];
    loop {
        match s.recv_from(&mut buf).await {
            Ok((n, source)) => {
                let d = Datagram {
                    local,
                    source,
                    data: buf[..n].to_vec(),
                };
                if tx.send(d).await.is_err() {
                    return;
                }
            }
            Err(e) => {
                // ICMP port-unreachable surfaces here on some platforms;
                // keep going.
                debug!("webrtc: udp {local} recv: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_video_mid() {
        let sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n\
                   m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\n";
        assert_eq!(video_mid(sdp), Some(Mid::from("1")));
        assert_eq!(
            video_mid("v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n"),
            None
        );
    }
}
