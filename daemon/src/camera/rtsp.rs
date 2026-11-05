//! Minimal RTSP(S) client: DESCRIBE/SETUP/PLAY with interleaved TCP
//! transport, Basic and Digest auth, keepalives.

use std::time::Duration;

use base64::Engine;
use bytes::{Buf, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::tls::md5_hex;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

#[derive(Debug, Clone, PartialEq)]
pub struct RtspUrl {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    /// URL without credentials, used in requests.
    pub url: String,
}

fn pct_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .into_owned()
}

pub fn parse_url(s: &str) -> Result<RtspUrl, String> {
    let (tls, rest) = if let Some(r) = s.strip_prefix("rtsps://") {
        (true, r)
    } else if let Some(r) = s.strip_prefix("rtsp://") {
        (false, r)
    } else {
        return Err("camera URL must start with rtsp:// or rtsps://".into());
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (userinfo, hostport) = match authority.rfind('@') {
        Some(i) => (Some(&authority[..i]), &authority[i + 1..]),
        None => (None, authority),
    };
    let (user, pass) = match userinfo {
        Some(ui) => match ui.split_once(':') {
            Some((u, p)) => (pct_decode(u), pct_decode(p)),
            None => (pct_decode(ui), String::new()),
        },
        None => (String::new(), String::new()),
    };
    let default_port = if tls { 322 } else { 554 };
    let (host, port) = if let Some(h) = hostport.strip_prefix('[') {
        let end = h.find(']').ok_or("bad IPv6 host")?;
        let port = h[end + 1..]
            .strip_prefix(':')
            .map(|p| p.parse::<u16>())
            .transpose()
            .map_err(|_| "bad port")?;
        (h[..end].to_string(), port.unwrap_or(default_port))
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "bad port")?),
            None => (hostport.to_string(), default_port),
        }
    };
    if host.is_empty() {
        return Err("camera URL has no host".into());
    }
    let scheme = if tls { "rtsps" } else { "rtsp" };
    let url = format!("{scheme}://{hostport}{path}");
    Ok(RtspUrl {
        tls,
        host,
        port,
        user,
        pass,
        url,
    })
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    pub fn headers_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.headers
            .iter()
            .filter(move |(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug)]
pub enum Msg {
    Response(Response),
    /// A request from the server, or anything else that is not a response.
    Other,
    Interleaved {
        channel: u8,
        data: Bytes,
    },
}

const MAX_HEADER: usize = 64 * 1024;

/// Parses one message from the front of `buf`, if complete.
pub fn parse_msg(buf: &mut BytesMut) -> Result<Option<Msg>, String> {
    if buf.is_empty() {
        return Ok(None);
    }
    if buf[0] == b'$' {
        if buf.len() < 4 {
            return Ok(None);
        }
        let len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
        if buf.len() < 4 + len {
            return Ok(None);
        }
        let channel = buf[1];
        buf.advance(4);
        return Ok(Some(Msg::Interleaved {
            channel,
            data: buf.split_to(len).freeze(),
        }));
    }
    let Some(hend) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
        if buf.len() > MAX_HEADER {
            return Err("RTSP header too large".into());
        }
        // Resync on garbage: skip until something that looks like a message.
        if !buf[0].is_ascii_uppercase() {
            let skip = buf
                .iter()
                .position(|&b| b == b'$' || b == b'R')
                .unwrap_or(buf.len());
            buf.advance(skip);
        }
        return Ok(None);
    };
    let head = String::from_utf8_lossy(&buf[..hend]).into_owned();
    let mut lines = head.split("\r\n");
    let start = lines.next().unwrap_or("");
    let mut headers = Vec::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let clen: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    if clen > 1024 * 1024 {
        return Err("RTSP body too large".into());
    }
    if buf.len() < hend + 4 + clen {
        return Ok(None);
    }
    buf.advance(hend + 4);
    let body = buf.split_to(clen).freeze();
    if let Some(rest) = start.strip_prefix("RTSP/1.0 ") {
        let status = rest
            .get(..3)
            .and_then(|s| s.parse().ok())
            .ok_or("bad RTSP status line")?;
        Ok(Some(Msg::Response(Response {
            status,
            headers,
            body,
        })))
    } else {
        Ok(Some(Msg::Other))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Auth {
    Basic,
    Digest {
        realm: String,
        nonce: String,
        opaque: Option<String>,
        qop_auth: bool,
    },
}

/// Parses `key=value, key="quoted"` auth params.
fn auth_params(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = s.trim();
    while !rest.is_empty() {
        let Some(eq) = rest.find('=') else { break };
        let key = rest[..eq]
            .trim()
            .trim_start_matches(',')
            .trim()
            .to_ascii_lowercase();
        rest = rest[eq + 1..].trim_start();
        let val;
        if let Some(r) = rest.strip_prefix('"') {
            let end = r.find('"').unwrap_or(r.len());
            val = r[..end].to_string();
            rest = r.get(end + 1..).unwrap_or("");
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            val = rest[..end].trim().to_string();
            rest = &rest[end..];
        }
        rest = rest.trim_start().trim_start_matches(',').trim_start();
        out.push((key, val));
    }
    out
}

/// Picks the best scheme from WWW-Authenticate headers (Digest preferred).
pub fn parse_challenge<'a>(headers: impl Iterator<Item = &'a str>) -> Option<Auth> {
    let mut basic = false;
    for h in headers {
        let (scheme, params) = h.split_once(' ').unwrap_or((h, ""));
        if scheme.eq_ignore_ascii_case("digest") {
            let p = auth_params(params);
            let get = |k: &str| p.iter().find(|(pk, _)| pk == k).map(|(_, v)| v.clone());
            let qop_auth = get("qop").is_some_and(|q| q.split(',').any(|x| x.trim() == "auth"));
            return Some(Auth::Digest {
                realm: get("realm").unwrap_or_default(),
                nonce: get("nonce")?,
                opaque: get("opaque"),
                qop_auth,
            });
        }
        if scheme.eq_ignore_ascii_case("basic") {
            basic = true;
        }
    }
    basic.then_some(Auth::Basic)
}

pub fn authorization(
    auth: &Auth,
    user: &str,
    pass: &str,
    method: &str,
    uri: &str,
    nc: u32,
    cnonce: &str,
) -> String {
    match auth {
        Auth::Basic => {
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"))
            )
        }
        Auth::Digest {
            realm,
            nonce,
            opaque,
            qop_auth,
        } => {
            let ha1 = md5_hex(format!("{user}:{realm}:{pass}").as_bytes());
            let ha2 = md5_hex(format!("{method}:{uri}").as_bytes());
            let mut h = format!(
                "Digest username=\"{user}\", realm=\"{realm}\", nonce=\"{nonce}\", uri=\"{uri}\""
            );
            if *qop_auth {
                let nc = format!("{nc:08x}");
                let resp = md5_hex(format!("{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}").as_bytes());
                h += &format!(", response=\"{resp}\", qop=auth, nc={nc}, cnonce=\"{cnonce}\"");
            } else {
                let resp = md5_hex(format!("{ha1}:{nonce}:{ha2}").as_bytes());
                h += &format!(", response=\"{resp}\"");
            }
            if let Some(o) = opaque {
                h += &format!(", opaque=\"{o}\"");
            }
            h
        }
    }
}

pub struct Conn {
    io: Box<dyn Io>,
    buf: BytesMut,
    cseq: u32,
    pub url: RtspUrl,
    auth: Option<Auth>,
    nc: u32,
    pub session: Option<String>,
}

impl Conn {
    pub async fn connect(url: RtspUrl) -> Result<Self, String> {
        let tcp = tokio::time::timeout(
            Duration::from_secs(10),
            TcpStream::connect((url.host.as_str(), url.port)),
        )
        .await
        .map_err(|_| "camera connect timeout".to_string())?
        .map_err(|e| format!("camera connect {}:{}: {e}", url.host, url.port))?;
        let _ = tcp.set_nodelay(true);
        let io: Box<dyn Io> = if url.tls {
            let c = tokio_rustls::TlsConnector::from(crate::tls::insecure_client_config());
            let s = tokio::time::timeout(
                Duration::from_secs(10),
                c.connect(crate::tls::server_name(&url.host), tcp),
            )
            .await
            .map_err(|_| "camera TLS handshake timeout".to_string())?
            .map_err(|e| format!("camera TLS handshake: {e}"))?;
            Box::new(s)
        } else {
            Box::new(tcp)
        };
        Ok(Self {
            io,
            buf: BytesMut::with_capacity(256 * 1024),
            cseq: 0,
            url,
            auth: None,
            nc: 0,
            session: None,
        })
    }

    /// Writes a request without waiting for the response.
    pub async fn send(
        &mut self,
        method: &str,
        uri: &str,
        extra: &[(&str, &str)],
    ) -> Result<u32, String> {
        self.cseq += 1;
        let mut req = format!(
            "{method} {uri} RTSP/1.0\r\nCSeq: {}\r\nUser-Agent: orcax1d\r\n",
            self.cseq
        );
        if let Some(a) = &self.auth {
            self.nc += 1;
            let cnonce = format!(
                "{:08x}",
                self.cseq.wrapping_mul(2654435761) ^ std::process::id()
            );
            let h = authorization(
                a,
                &self.url.user,
                &self.url.pass,
                method,
                uri,
                self.nc,
                &cnonce,
            );
            req += &format!("Authorization: {h}\r\n");
        }
        if let Some(s) = &self.session {
            req += &format!("Session: {s}\r\n");
        }
        for (k, v) in extra {
            req += &format!("{k}: {v}\r\n");
        }
        req += "\r\n";
        self.io
            .write_all(req.as_bytes())
            .await
            .map_err(|e| format!("camera write: {e}"))?;
        Ok(self.cseq)
    }

    /// Reads the next message. Cancel-safe.
    pub async fn read_msg(&mut self) -> Result<Msg, String> {
        loop {
            if let Some(m) = parse_msg(&mut self.buf)? {
                return Ok(m);
            }
            let n = self
                .io
                .read_buf(&mut self.buf)
                .await
                .map_err(|e| format!("camera read: {e}"))?;
            if n == 0 {
                return Err("camera closed the connection".into());
            }
        }
    }

    /// Sends a request and waits for its response, retrying once with
    /// credentials on 401.
    pub async fn request(
        &mut self,
        method: &str,
        uri: &str,
        extra: &[(&str, &str)],
    ) -> Result<Response, String> {
        for attempt in 0..2 {
            self.send(method, uri, extra).await?;
            let resp = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Msg::Response(r) = self.read_msg().await? {
                        return Ok::<_, String>(r);
                    }
                }
            })
            .await
            .map_err(|_| format!("camera {method} timeout"))??;
            if resp.status == 401 && attempt == 0 {
                let ch = parse_challenge(resp.headers_named("WWW-Authenticate"))
                    .ok_or("camera requires an unsupported auth scheme")?;
                self.auth = Some(ch);
                self.nc = 0;
                continue;
            }
            if resp.status == 401 {
                return Err("camera rejected credentials (check access code)".into());
            }
            return Ok(resp);
        }
        unreachable!()
    }

    pub async fn shutdown(&mut self) {
        let _ = self.io.shutdown().await;
    }
}

/// What we need from the SDP.
#[derive(Debug, Default, PartialEq)]
pub struct VideoTrack {
    pub control: Option<String>,
    pub payload_type: Option<u8>,
    pub clock_rate: u32,
    pub sprop: Vec<Vec<u8>>,
}

pub fn parse_sdp(sdp: &str) -> Option<VideoTrack> {
    let mut track: Option<VideoTrack> = None;
    let mut in_video = false;
    for line in sdp.lines() {
        let line = line.trim();
        if let Some(m) = line.strip_prefix("m=") {
            if track.is_some() {
                break; // first video track only
            }
            in_video = m.starts_with("video");
            if in_video {
                let pt = m.split_whitespace().nth(3).and_then(|p| p.parse().ok());
                track = Some(VideoTrack {
                    payload_type: pt,
                    clock_rate: 90_000,
                    ..Default::default()
                });
            }
            continue;
        }
        let (true, Some(t)) = (in_video, track.as_mut()) else {
            continue;
        };
        if let Some(c) = line.strip_prefix("a=control:") {
            t.control = Some(c.trim().to_string());
        } else if let Some(r) = line.strip_prefix("a=rtpmap:") {
            // a=rtpmap:96 H264/90000
            if let Some(rate) = r.split('/').nth(1).and_then(|x| x.trim().parse().ok()) {
                t.clock_rate = rate;
            }
        } else if let Some(f) = line.strip_prefix("a=fmtp:") {
            let params = f.split_once(' ').map(|(_, p)| p).unwrap_or("");
            for kv in params.split(';') {
                if let Some(v) = kv.trim().strip_prefix("sprop-parameter-sets=") {
                    t.sprop = v
                        .split(',')
                        .filter_map(|b| {
                            base64::engine::general_purpose::STANDARD
                                .decode(b.trim())
                                .ok()
                        })
                        .filter(|n| !n.is_empty())
                        .collect();
                }
            }
        }
    }
    track
}

/// Resolves a control attribute against the base URL.
pub fn control_url(base: &str, control: Option<&str>) -> String {
    match control {
        None | Some("*") | Some("") => base.to_string(),
        Some(c) if c.starts_with("rtsp://") || c.starts_with("rtsps://") => c.to_string(),
        Some(c) => {
            if base.ends_with('/') {
                format!("{base}{c}")
            } else {
                format!("{base}/{c}")
            }
        }
    }
}

/// Session id and timeout from a Session header ("id;timeout=60").
pub fn parse_session(h: &str) -> (String, Option<u64>) {
    let mut parts = h.split(';');
    let id = parts.next().unwrap_or("").trim().to_string();
    let timeout = parts.find_map(|p| {
        p.trim()
            .strip_prefix("timeout=")
            .and_then(|t| t.trim().parse().ok())
    });
    (id, timeout)
}

/// RTP channel from a Transport response header ("...;interleaved=0-1").
pub fn interleaved_channel(h: &str) -> Option<u8> {
    h.split(';').find_map(|p| {
        p.trim()
            .strip_prefix("interleaved=")?
            .split('-')
            .next()?
            .parse()
            .ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_parsing() {
        let u = parse_url("rtsps://bblp:ab%40cd@127.0.0.1:322/streaming/live/1").unwrap();
        assert_eq!(
            u,
            RtspUrl {
                tls: true,
                host: "127.0.0.1".into(),
                port: 322,
                user: "bblp".into(),
                pass: "ab@cd".into(),
                url: "rtsps://127.0.0.1:322/streaming/live/1".into()
            }
        );
        let u = parse_url("rtsp://[::1]/x").unwrap();
        assert_eq!(
            (u.host.as_str(), u.port, u.url.as_str()),
            ("::1", 554, "rtsp://[::1]/x")
        );
        assert!(parse_url("http://x").is_err());
    }

    #[test]
    fn message_parsing() {
        let mut b = BytesMut::from(
            &b"RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Length: 3\r\n\r\nabc$\x00\x00\x02hi"[..],
        );
        match parse_msg(&mut b).unwrap().unwrap() {
            Msg::Response(r) => {
                assert_eq!(r.status, 200);
                assert_eq!(r.header("cseq"), Some("2"));
                assert_eq!(&r.body[..], b"abc");
            }
            m => panic!("{m:?}"),
        }
        match parse_msg(&mut b).unwrap().unwrap() {
            Msg::Interleaved { channel: 0, data } => assert_eq!(&data[..], b"hi"),
            m => panic!("{m:?}"),
        }
        assert!(parse_msg(&mut b).unwrap().is_none());
        let mut partial = BytesMut::from(&b"RTSP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nab"[..]);
        assert!(parse_msg(&mut partial).unwrap().is_none());
    }

    #[test]
    fn digest_rfc2069_and_qop() {
        let ch = parse_challenge(
            [
                "Basic realm=\"x\"",
                "Digest realm=\"LIVE555 Streaming Media\", nonce=\"abc123\"",
            ]
            .into_iter(),
        )
        .unwrap();
        assert_eq!(
            ch,
            Auth::Digest {
                realm: "LIVE555 Streaming Media".into(),
                nonce: "abc123".into(),
                opaque: None,
                qop_auth: false
            }
        );
        let h = authorization(&ch, "bblp", "pw", "DESCRIBE", "rtsps://h/x", 1, "c");
        let ha1 = md5_hex(b"bblp:LIVE555 Streaming Media:pw");
        let ha2 = md5_hex(b"DESCRIBE:rtsps://h/x");
        let resp = md5_hex(format!("{ha1}:abc123:{ha2}").as_bytes());
        assert!(h.contains(&format!("response=\"{resp}\"")), "{h}");

        let ch = parse_challenge(
            ["Digest realm=r, nonce=\"n\", qop=\"auth,auth-int\", opaque=\"o\""].into_iter(),
        )
        .unwrap();
        let h = authorization(&ch, "u", "p", "PLAY", "/", 1, "cn");
        assert!(
            h.contains("qop=auth, nc=00000001, cnonce=\"cn\"") && h.contains("opaque=\"o\""),
            "{h}"
        );

        assert_eq!(
            parse_challenge(["Basic realm=\"x\""].into_iter()),
            Some(Auth::Basic)
        );
        assert_eq!(
            authorization(&Auth::Basic, "bblp", "12345678", "OPTIONS", "*", 0, ""),
            "Basic YmJscDoxMjM0NTY3OA=="
        );
    }

    #[test]
    fn sdp_parsing() {
        let sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=x\r\na=control:*\r\n\
                   m=audio 0 RTP/AVP 97\r\na=control:track0\r\n\
                   m=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n\
                   a=fmtp:96 packetization-mode=1;profile-level-id=640028;sprop-parameter-sets=Z2QAKKzZ,aOvjyw==\r\n\
                   a=control:track1\r\n";
        let t = parse_sdp(sdp).unwrap();
        assert_eq!(t.control.as_deref(), Some("track1"));
        assert_eq!(t.payload_type, Some(96));
        assert_eq!(t.clock_rate, 90000);
        assert_eq!(
            t.sprop,
            vec![
                vec![0x67, 0x64, 0x00, 0x28, 0xac, 0xd9],
                vec![0x68, 0xeb, 0xe3, 0xcb]
            ]
        );
        assert_eq!(
            control_url("rtsps://h/live/1/", Some("track1")),
            "rtsps://h/live/1/track1"
        );
        assert_eq!(
            control_url("rtsps://h/live/1", Some("track1")),
            "rtsps://h/live/1/track1"
        );
        assert_eq!(
            control_url("rtsps://h/live/1", Some("rtsps://h/x")),
            "rtsps://h/x"
        );
    }

    #[test]
    fn session_and_transport() {
        assert_eq!(parse_session("ABCD;timeout=65"), ("ABCD".into(), Some(65)));
        assert_eq!(parse_session("ABCD"), ("ABCD".into(), None));
        assert_eq!(
            interleaved_channel("RTP/AVP/TCP;unicast;interleaved=2-3"),
            Some(2)
        );
    }
}
