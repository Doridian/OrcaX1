//! Minimal MQTT 3.1.1 client over TLS: just enough for the Bambu local
//! broker (QoS 0 publish/subscribe, keepalive).

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::{Buf, Bytes, BytesMut};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::printer::Printer;

const KEEPALIVE: Duration = Duration::from_secs(30);
const MAX_PACKET: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum Packet {
    ConnAck {
        code: u8,
    },
    Publish {
        topic: String,
        payload: Bytes,
        qos: u8,
        pid: Option<u16>,
    },
    SubAck,
    PingResp,
    Other(u8),
}

fn put_len(mut n: usize, out: &mut Vec<u8>) {
    loop {
        let mut b = (n % 128) as u8;
        n /= 128;
        if n > 0 {
            b |= 0x80;
        }
        out.push(b);
        if n == 0 {
            break;
        }
    }
}

fn put_str(s: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(&(s.len() as u16).to_be_bytes());
    out.extend_from_slice(s);
}

fn packet(first: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 5);
    out.push(first);
    put_len(body.len(), &mut out);
    out.extend_from_slice(body);
    out
}

pub fn connect_packet(client_id: &str, user: &str, pass: &str, keepalive: u16) -> Vec<u8> {
    let mut b = Vec::new();
    put_str(b"MQTT", &mut b);
    b.push(4); // protocol level 3.1.1
    b.push(0b1100_0010); // username, password, clean session
    b.extend_from_slice(&keepalive.to_be_bytes());
    put_str(client_id.as_bytes(), &mut b);
    put_str(user.as_bytes(), &mut b);
    put_str(pass.as_bytes(), &mut b);
    packet(0x10, &b)
}

pub fn subscribe_packet(pid: u16, topic: &str) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&pid.to_be_bytes());
    put_str(topic.as_bytes(), &mut b);
    b.push(0); // QoS 0
    packet(0x82, &b)
}

pub fn publish_packet(topic: &str, payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(topic.len() + 2 + payload.len());
    put_str(topic.as_bytes(), &mut b);
    b.extend_from_slice(payload);
    packet(0x30, &b)
}

/// Decodes one packet from the front of `buf`, if complete.
pub fn decode(buf: &mut BytesMut) -> Result<Option<Packet>, String> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let mut len: usize = 0;
    let mut i = 1;
    loop {
        if i >= buf.len() {
            return Ok(None);
        }
        if i > 4 {
            return Err("malformed remaining length".into());
        }
        let b = buf[i];
        len |= ((b & 0x7f) as usize) << (7 * (i - 1));
        i += 1;
        if b & 0x80 == 0 {
            break;
        }
    }
    if len > MAX_PACKET {
        return Err(format!("packet too large ({len} bytes)"));
    }
    if buf.len() < i + len {
        buf.reserve(i + len - buf.len());
        return Ok(None);
    }
    let first = buf[0];
    buf.advance(i);
    let mut body = buf.split_to(len).freeze();
    let p = match first >> 4 {
        2 => Packet::ConnAck {
            code: *body.get(1).unwrap_or(&0xff),
        },
        3 => {
            let qos = (first >> 1) & 3;
            if body.len() < 2 {
                return Err("short publish".into());
            }
            let tl = body.get_u16() as usize;
            if body.len() < tl {
                return Err("short publish topic".into());
            }
            let topic = String::from_utf8_lossy(&body.split_to(tl)).into_owned();
            let pid = if qos > 0 {
                if body.len() < 2 {
                    return Err("short publish pid".into());
                }
                Some(body.get_u16())
            } else {
                None
            };
            Packet::Publish {
                topic,
                payload: body,
                qos,
                pid,
            }
        }
        9 => Packet::SubAck,
        13 => Packet::PingResp,
        t => Packet::Other(t),
    };
    Ok(Some(p))
}

type Stream = tokio_rustls::client::TlsStream<TcpStream>;

async fn read_packet(s: &mut Stream, buf: &mut BytesMut) -> Result<Packet, String> {
    loop {
        if let Some(p) = decode(buf)? {
            return Ok(p);
        }
        let n = s.read_buf(buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed by broker".into());
        }
    }
}

/// Runs forever, reconnecting with backoff.
pub async fn run(printer: Arc<Printer>, cfg: Arc<Config>, mut outbox: mpsc::Receiver<Vec<u8>>) {
    let tls = tokio_rustls::TlsConnector::from(crate::tls::insecure_client_config());
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        match session(&printer, &cfg, &tls, &mut outbox).await {
            Ok(()) => info!("MQTT session ended"),
            Err(e) => warn!("MQTT: {e}"),
        }
        printer.set_connected(false);
        while outbox.try_recv().is_ok() {}
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn session(
    printer: &Printer,
    cfg: &Config,
    tls: &tokio_rustls::TlsConnector,
    outbox: &mut mpsc::Receiver<Vec<u8>>,
) -> Result<(), String> {
    let code = cfg.access_code().ok_or_else(|| {
        format!(
            "no access code (--access-code or {})",
            cfg.access_code_file.display()
        )
    })?;
    let host = cfg.mqtt_host.trim_start_matches('[').trim_end_matches(']');
    let tcp = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect((host, cfg.mqtt_port)),
    )
    .await
    .map_err(|_| "connect timeout".to_string())?
    .map_err(|e| format!("connect {}:{}: {e}", cfg.mqtt_host, cfg.mqtt_port))?;
    let _ = tcp.set_nodelay(true);
    let mut s = tokio::time::timeout(
        Duration::from_secs(10),
        tls.connect(crate::tls::server_name(host), tcp),
    )
    .await
    .map_err(|_| "TLS handshake timeout".to_string())?
    .map_err(|e| format!("TLS handshake: {e}"))?;

    let client_id = format!("orcax1d-{:08x}", rand_u32());
    s.write_all(&connect_packet(
        &client_id,
        "bblp",
        &code,
        KEEPALIVE.as_secs() as u16,
    ))
    .await
    .map_err(|e| e.to_string())?;
    let mut buf = BytesMut::with_capacity(64 * 1024);
    match tokio::time::timeout(Duration::from_secs(10), read_packet(&mut s, &mut buf))
        .await
        .map_err(|_| "CONNACK timeout".to_string())??
    {
        Packet::ConnAck { code: 0 } => {}
        Packet::ConnAck { code: 4 | 5 } => {
            return Err("broker refused credentials (check access code)".into());
        }
        Packet::ConnAck { code } => return Err(format!("broker refused connection (code {code})")),
        p => return Err(format!("expected CONNACK, got {p:?}")),
    }

    let mut serial = printer.serial();
    let topic = match &serial {
        Some(sn) => format!("device/{sn}/report"),
        None => "device/+/report".to_string(),
    };
    s.write_all(&subscribe_packet(1, &topic))
        .await
        .map_err(|e| e.to_string())?;
    info!(%topic, "MQTT connected");
    printer.set_connected(true);
    if let Some(sn) = &serial {
        s.write_all(&pushall(sn)).await.map_err(|e| e.to_string())?;
    }

    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + KEEPALIVE, KEEPALIVE);
    let mut last_rx = Instant::now();
    loop {
        tokio::select! {
            r = s.read_buf(&mut buf) => {
                let n = r.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("connection closed by broker".into());
                }
                last_rx = Instant::now();
                while let Some(p) = decode(&mut buf)? {
                    match p {
                        Packet::Publish { topic, payload, qos, pid } => {
                            if let (1, Some(pid)) = (qos, pid) {
                                let mut ack = vec![0x40, 2];
                                ack.extend_from_slice(&pid.to_be_bytes());
                                s.write_all(&ack).await.map_err(|e| e.to_string())?;
                            }
                            let Some(sn) = topic.strip_prefix("device/").and_then(|t| t.strip_suffix("/report")) else {
                                debug!(%topic, "ignoring message on unexpected topic");
                                continue;
                            };
                            if serial.is_none() {
                                info!(serial = %sn, "learned printer serial from MQTT");
                                printer.set_serial(sn.to_string());
                                serial = Some(sn.to_string());
                                s.write_all(&pushall(sn)).await.map_err(|e| e.to_string())?;
                            } else if serial.as_deref() != Some(sn) {
                                continue;
                            }
                            printer.handle_report(&payload);
                        }
                        Packet::PingResp | Packet::SubAck => {}
                        p => debug!(?p, "ignoring MQTT packet"),
                    }
                }
            }
            msg = outbox.recv() => {
                let Some(msg) = msg else { return Ok(()) };
                let Some(sn) = &serial else { continue };
                s.write_all(&publish_packet(&format!("device/{sn}/request"), &msg)).await.map_err(|e| e.to_string())?;
            }
            _ = ping.tick() => {
                if last_rx.elapsed() > KEEPALIVE * 2 + Duration::from_secs(5) {
                    return Err("broker stopped responding".into());
                }
                s.write_all(&[0xC0, 0]).await.map_err(|e| e.to_string())?;
            }
        }
    }
}

fn pushall(sn: &str) -> Vec<u8> {
    publish_packet(
        &format!("device/{sn}/request"),
        br#"{"pushing":{"sequence_id":"0","command":"pushall","version":1,"push_target":1}}"#,
    )
}

fn rand_u32() -> u32 {
    let mut b = [0u8; 4];
    if getrandom(&mut b).is_err() {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        return t.subsec_nanos() ^ std::process::id();
    }
    u32::from_le_bytes(b)
}

fn getrandom(b: &mut [u8]) -> Result<(), ()> {
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(b)
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaining_length_encoding() {
        let mut v = Vec::new();
        put_len(321, &mut v);
        assert_eq!(v, [0xC1, 0x02]);
        let mut v = Vec::new();
        put_len(127, &mut v);
        assert_eq!(v, [0x7f]);
    }

    #[test]
    fn publish_roundtrip() {
        let payload = vec![b'x'; 300];
        let pkt = publish_packet("device/SN/report", &payload);
        let mut buf = BytesMut::from(&pkt[..5]);
        assert_eq!(decode(&mut buf).unwrap(), None);
        let mut buf = BytesMut::from(&pkt[..]);
        buf.extend_from_slice(&[0xD0, 0x00]);
        match decode(&mut buf).unwrap().unwrap() {
            Packet::Publish {
                topic,
                payload: p,
                qos,
                pid,
            } => {
                assert_eq!(topic, "device/SN/report");
                assert_eq!(&p[..], &payload[..]);
                assert_eq!((qos, pid), (0, None));
            }
            p => panic!("{p:?}"),
        }
        assert_eq!(decode(&mut buf).unwrap(), Some(Packet::PingResp));
        assert!(buf.is_empty());
    }

    #[test]
    fn connack() {
        let mut buf = BytesMut::from(&[0x20u8, 2, 0, 5][..]);
        assert_eq!(decode(&mut buf).unwrap(), Some(Packet::ConnAck { code: 5 }));
    }
}
