//! Learns the printer model from Bambu's SSDP-style discovery broadcasts.
//!
//! MQTT can't tell an X1 from an X1 Carbon (same serial prefix, same
//! `get_version` modules), but the printer's own discovery NOTIFY carries
//! `DevModel.bambu.com` (BL-P001 = X1 Carbon, BL-P002 = X1, C13 = X1E). The
//! firmware sends it to 255.255.255.255:2021, which local listeners receive
//! too, so this works both on the printer and from elsewhere on the LAN.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use tracing::{debug, info, warn};

use crate::printer::Printer;

const PORT: u16 = 2021;
const ST: &str = "urn:bambulab-com:device:3dprinter:1";
const SEARCH_EVERY: Duration = Duration::from_secs(30);
const RETRY_BIND: Duration = Duration::from_secs(60);

pub async fn run(printer: Arc<Printer>) {
    loop {
        match bind() {
            Ok(sock) => {
                if let Err(e) = listen(&sock, &printer).await {
                    warn!("SSDP listener failed: {e}");
                }
            }
            Err(e) => warn!("cannot listen for SSDP on UDP {PORT} (model detection off): {e}"),
        }
        tokio::time::sleep(RETRY_BIND).await;
    }
}

fn bind() -> std::io::Result<UdpSocket> {
    // The firmware's discovery service holds this port too, so share it.
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    s.set_broadcast(true)?;
    s.set_nonblocking(true)?;
    s.bind(&SocketAddr::from(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORT)).into())?;
    UdpSocket::from_std(s.into())
}

async fn listen(sock: &UdpSocket, printer: &Printer) -> std::io::Result<()> {
    let search = format!(
        "M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1990\r\nST: {ST}\r\nMAN: \"ssdp:discover\"\r\nMX: 3\r\n\r\n"
    );
    let dest = SocketAddrV4::new(Ipv4Addr::BROADCAST, PORT);
    let mut tick = tokio::time::interval(SEARCH_EVERY);
    let mut buf = [0u8; 2048];
    loop {
        tokio::select! {
            _ = tick.tick() => {
                // The printer announces itself every few seconds anyway; a
                // search just speeds up the first answer.
                if printer.model().is_none()
                    && let Err(e) = sock.send_to(search.as_bytes(), dest).await
                {
                    debug!("SSDP search failed: {e}");
                }
            }
            r = sock.recv_from(&mut buf) => {
                let (n, from) = r?;
                let Some(ann) = parse(&buf[..n]) else { continue };
                if printer.serial().as_deref() != Some(ann.usn) {
                    continue;
                }
                if printer.model().as_deref() != Some(ann.model) {
                    info!(model = ann.model, %from, "learned printer model from SSDP");
                    printer.set_model(ann.model.to_string());
                }
            }
        }
    }
}

#[derive(Debug, PartialEq)]
struct Announcement<'a> {
    usn: &'a str,
    model: &'a str,
}

/// A printer's NOTIFY or search response; None for anything else (including
/// other clients' M-SEARCH requests).
fn parse(pkt: &[u8]) -> Option<Announcement<'_>> {
    let text = std::str::from_utf8(pkt).ok()?;
    let mut lines = text.split("\r\n");
    let start = lines.next()?;
    if start != "NOTIFY * HTTP/1.1" && start != "HTTP/1.1 200 OK" {
        return None;
    }
    let (mut usn, mut model, mut kind) = (None, None, None);
    for line in lines.take_while(|l| !l.is_empty()) {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim();
        match k.trim().to_ascii_lowercase().as_str() {
            "usn" => usn = Some(v),
            "devmodel.bambu.com" => model = Some(v),
            "nt" | "st" => kind = Some(v),
            _ => {}
        }
    }
    let (usn, model) = (usn?, model?);
    (kind == Some(ST) && !usn.is_empty() && !model.is_empty())
        .then_some(Announcement { usn, model })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTIFY: &[u8] =
        b"NOTIFY * HTTP/1.1\r\nHost: 239.255.255.250:1990\r\nServer: UPnP/1.0\r\n\
Location: 10.2.12.15\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nNTS: ssdp:alive\r\n\
USN: 00M00A280102436\r\nCache-Control: max-age=1800\r\nDevModel.bambu.com: BL-P001\r\n\
DevName.bambu.com: 3DP-00M-436\r\nDevVersion.bambu.com: 99.00.00.00\r\n\r\n";

    #[test]
    fn parses_notify() {
        assert_eq!(
            parse(NOTIFY),
            Some(Announcement {
                usn: "00M00A280102436",
                model: "BL-P001"
            })
        );
    }

    #[test]
    fn parses_search_response() {
        let r = b"HTTP/1.1 200 OK\r\nST: urn:bambulab-com:device:3dprinter:1\r\nusn: SN1\r\ndevmodel.bambu.com: C13\r\n\r\n";
        assert_eq!(
            parse(r),
            Some(Announcement {
                usn: "SN1",
                model: "C13"
            })
        );
    }

    #[test]
    fn ignores_searches_and_strangers() {
        let search = b"M-SEARCH * HTTP/1.1\r\nST: urn:bambulab-com:device:3dprinter:1\r\nMAN: \"ssdp:discover\"\r\n\r\n";
        assert_eq!(parse(search), None);
        let other =
            b"NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\nUSN: x\r\nDevModel.bambu.com: y\r\n\r\n";
        assert_eq!(parse(other), None);
        let no_model =
            b"NOTIFY * HTTP/1.1\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nUSN: x\r\n\r\n";
        assert_eq!(parse(no_model), None);
    }
}
