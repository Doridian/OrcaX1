//! RFC 2136 dynamic updates signed with TSIG (RFC 8945), as accepted by
//! BIND, Knot, PowerDNS, Technitium and most self-hosted DNS servers. Talks
//! DNS over TCP to the zone's primary.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use base64::Engine;
use ring::hmac;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::{DnsProvider, Field, ProviderInfo, Settings, choice, get, need};
use crate::http_client::Http;
use crate::util::{self, BoxFut};

const ALGORITHMS: &[&str] = &["hmac-sha256", "hmac-sha512", "hmac-sha384", "hmac-sha1"];

const ALG_FIELD: Field = Field::new("algorithm", "TSIG algorithm").options(ALGORITHMS);

pub static PROVIDER: ProviderInfo = ProviderInfo {
    id: "rfc2136",
    label: "RFC 2136 (nsupdate / TSIG)",
    help: "Dynamic updates to the zone's primary name server over TCP, signed with a TSIG key \
           (BIND, Knot, PowerDNS, Technitium, ...). The key needs permission to add and delete TXT records \
           named _acme-challenge.<domain>.",
    fields: &[
        Field::new("server", "Server")
            .required()
            .placeholder("ns1.example.com or 192.0.2.53:53"),
        Field::new("zone", "Zone")
            .placeholder("example.com")
            .help("Optional. Found with an SOA query to the server if empty."),
        Field::new("key_name", "TSIG key name").required(),
        ALG_FIELD,
        Field::new("secret", "TSIG secret (base64)")
            .secret()
            .required(),
    ],
    persistent: false,
    single_value: false,
    build,
};

const T_SOA: u16 = 6;
const T_TXT: u16 = 16;
const T_TSIG: u16 = 250;
const C_IN: u16 = 1;
const C_NONE: u16 = 254;
const C_ANY: u16 = 255;
const TIMEOUT: Duration = Duration::from_secs(15);

struct Rfc2136 {
    server: String,
    zone: String,
    key_name: String,
    alg: &'static str,
    key: hmac::Key,
}

fn build(s: &Settings, _http: &Http) -> Result<Box<dyn DnsProvider>, String> {
    let alg = choice(s, &ALG_FIELD)?;
    let secret = base64::engine::general_purpose::STANDARD
        .decode(need(s, "secret")?)
        .map_err(|_| "secret is not valid base64".to_string())?;
    let ring_alg = match alg {
        "hmac-sha256" => hmac::HMAC_SHA256,
        "hmac-sha384" => hmac::HMAC_SHA384,
        "hmac-sha512" => hmac::HMAC_SHA512,
        _ => hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
    };
    let key_name = need(s, "key_name")?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    // Fail early on unencodable names.
    encode_name(&mut Vec::new(), &key_name)?;
    Ok(Box::new(Rfc2136 {
        server: need(s, "server")?.to_string(),
        zone: get(s, "zone").trim_end_matches('.').to_string(),
        key_name,
        alg,
        key: hmac::Key::new(ring_alg, &secret),
    }))
}

fn encode_name(out: &mut Vec<u8>, name: &str) -> Result<(), String> {
    let name = name.trim_end_matches('.');
    if !name.is_empty() {
        for label in name.split('.') {
            if label.is_empty() || label.len() > 63 {
                return Err(format!("invalid DNS name {name:?}"));
            }
            out.push(label.len() as u8);
            out.extend_from_slice(label.as_bytes());
        }
    }
    out.push(0);
    Ok(())
}

fn put16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn header(id: u16, flags: u16, counts: [u16; 4]) -> Vec<u8> {
    let mut m = Vec::with_capacity(512);
    put16(&mut m, id);
    put16(&mut m, flags);
    for c in counts {
        put16(&mut m, c);
    }
    m
}

/// Reads a possibly compressed name at `pos`; returns it and the offset
/// just past it.
fn parse_name(msg: &[u8], mut pos: usize) -> Result<(String, usize), String> {
    let bad = || "malformed DNS response".to_string();
    let mut labels: Vec<String> = Vec::new();
    let mut end = None;
    for _ in 0..128 {
        let len = *msg.get(pos).ok_or_else(bad)? as usize;
        if len & 0xC0 == 0xC0 {
            let lo = *msg.get(pos + 1).ok_or_else(bad)? as usize;
            end.get_or_insert(pos + 2);
            pos = ((len & 0x3F) << 8) | lo;
        } else if len == 0 {
            return Ok((labels.join("."), end.unwrap_or(pos + 1)));
        } else {
            let l = msg.get(pos + 1..pos + 1 + len).ok_or_else(bad)?;
            labels.push(String::from_utf8_lossy(l).to_ascii_lowercase());
            pos += 1 + len;
        }
    }
    Err(bad())
}

fn rcode_text(rcode: u8) -> &'static str {
    match rcode {
        1 => "FORMERR (server could not parse the request)",
        2 => "SERVFAIL",
        3 => "NXDOMAIN",
        4 => "NOTIMP (server doesn't support dynamic updates)",
        5 => "REFUSED (the key may not update this name, or updates are disabled)",
        8 => "NXRRSET",
        9 => {
            "NOTAUTH (bad TSIG key, secret or clock, or the server isn't authoritative for the zone)"
        }
        10 => "NOTZONE (name is outside the zone)",
        _ => "error",
    }
}

impl Rfc2136 {
    async fn addr(&self) -> Result<SocketAddr, String> {
        let s = self.server.as_str();
        if let Ok(a) = s.parse::<SocketAddr>() {
            return Ok(a);
        }
        if let Ok(ip) = s
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
        {
            return Ok(SocketAddr::new(ip, 53));
        }
        let target = if s.contains(':') {
            s.to_string()
        } else {
            format!("{s}:53")
        };
        let mut it = tokio::net::lookup_host(target)
            .await
            .map_err(|e| format!("resolving {s}: {e}"))?;
        it.next()
            .ok_or_else(|| format!("resolving {s}: no address"))
    }

    /// One request/response over DNS-over-TCP.
    async fn exchange(&self, msg: &[u8]) -> Result<Vec<u8>, String> {
        let addr = self.addr().await?;
        let fut = async {
            let mut tcp = TcpStream::connect(addr)
                .await
                .map_err(|e| format!("{addr}: {e}"))?;
            let mut buf = Vec::with_capacity(msg.len() + 2);
            put16(&mut buf, msg.len() as u16);
            buf.extend_from_slice(msg);
            tcp.write_all(&buf)
                .await
                .map_err(|e| format!("{addr}: {e}"))?;
            let len = tcp.read_u16().await.map_err(|e| format!("{addr}: {e}"))?;
            let mut resp = vec![0u8; len as usize];
            tcp.read_exact(&mut resp)
                .await
                .map_err(|e| format!("{addr}: {e}"))?;
            if resp.len() < 12 || resp[..2] != msg[..2] {
                return Err(format!("{addr}: malformed DNS response"));
            }
            Ok(resp)
        };
        tokio::time::timeout(TIMEOUT, fut)
            .await
            .map_err(|_| format!("{addr}: timed out"))?
    }

    /// Appends a TSIG record signing `msg` (RFC 8945 §4.3).
    fn sign(&self, msg: &mut Vec<u8>) -> Result<(), String> {
        let now = util::now_unix() as u64;
        let time48 = &now.to_be_bytes()[2..];
        let fudge: u16 = 300;

        let mut vars = Vec::new();
        encode_name(&mut vars, &self.key_name)?;
        put16(&mut vars, C_ANY);
        vars.extend_from_slice(&0u32.to_be_bytes());
        encode_name(&mut vars, self.alg)?;
        vars.extend_from_slice(time48);
        put16(&mut vars, fudge);
        put16(&mut vars, 0); // error
        put16(&mut vars, 0); // other len

        let mut ctx = hmac::Context::with_key(&self.key);
        ctx.update(msg);
        ctx.update(&vars);
        let mac = ctx.sign();
        let mac = mac.as_ref();

        let mut rdata = Vec::new();
        encode_name(&mut rdata, self.alg)?;
        rdata.extend_from_slice(time48);
        put16(&mut rdata, fudge);
        put16(&mut rdata, mac.len() as u16);
        rdata.extend_from_slice(mac);
        rdata.extend_from_slice(&msg[..2]); // original id
        put16(&mut rdata, 0);
        put16(&mut rdata, 0);

        encode_name(msg, &self.key_name)?;
        put16(msg, T_TSIG);
        put16(msg, C_ANY);
        msg.extend_from_slice(&0u32.to_be_bytes());
        put16(msg, rdata.len() as u16);
        msg.extend_from_slice(&rdata);
        let ar = u16::from_be_bytes([msg[10], msg[11]]) + 1;
        msg[10..12].copy_from_slice(&ar.to_be_bytes());
        Ok(())
    }

    /// The zone containing `name`: configured, or the owner of the SOA
    /// record the server returns for it.
    async fn zone_for(&self, name: &str) -> Result<String, String> {
        if !self.zone.is_empty() {
            return Ok(self.zone.clone());
        }
        let id = u16::from_be_bytes(util::random_bytes::<2>());
        let mut q = header(id, 0, [1, 0, 0, 0]);
        encode_name(&mut q, name)?;
        put16(&mut q, T_SOA);
        put16(&mut q, C_IN);
        let r = self.exchange(&q).await?;
        let counts: Vec<usize> = (0..4)
            .map(|i| u16::from_be_bytes([r[4 + 2 * i], r[5 + 2 * i]]) as usize)
            .collect();
        let mut pos = 12;
        for _ in 0..counts[0] {
            pos = parse_name(&r, pos)?.1 + 4;
        }
        for _ in 0..counts[1] + counts[2] {
            let (owner, p) = parse_name(&r, pos)?;
            let f = r.get(p..p + 10).ok_or("malformed DNS response")?;
            let rtype = u16::from_be_bytes([f[0], f[1]]);
            let rdlen = u16::from_be_bytes([f[8], f[9]]) as usize;
            if rtype == T_SOA {
                return Ok(owner);
            }
            pos = p + 10 + rdlen;
        }
        Err(format!(
            "could not find the zone for {name} on {} ({}); set the zone explicitly",
            self.server,
            rcode_text(r[3] & 0x0F)
        ))
    }

    async fn update(&self, name: &str, value: &str, add: bool) -> Result<(), String> {
        let zone = self.zone_for(name).await?;
        let id = u16::from_be_bytes(util::random_bytes::<2>());
        // opcode UPDATE; zone, prerequisite, update, additional counts
        let mut m = header(id, 5 << 11, [1, 0, 1, 0]);
        encode_name(&mut m, &zone)?;
        put16(&mut m, T_SOA);
        put16(&mut m, C_IN);
        encode_name(&mut m, name)?;
        put16(&mut m, T_TXT);
        // Delete one RR from a set: class NONE, TTL 0 (RFC 2136 §2.5.4).
        put16(&mut m, if add { C_IN } else { C_NONE });
        m.extend_from_slice(&(if add { 60u32 } else { 0 }).to_be_bytes());
        put16(&mut m, value.len() as u16 + 1);
        m.push(value.len() as u8);
        m.extend_from_slice(value.as_bytes());
        self.sign(&mut m)?;
        let r = self.exchange(&m).await?;
        match r[3] & 0x0F {
            0 => Ok(()),
            rc => Err(format!(
                "DNS update for {name} in zone {zone} failed: {}",
                rcode_text(rc)
            )),
        }
    }
}

impl DnsProvider for Rfc2136 {
    fn present<'a>(&'a self, name: &'a str, value: &'a str) -> BoxFut<'a, Result<String, String>> {
        Box::pin(async move { self.update(name, value, true).await.map(|_| String::new()) })
    }

    fn cleanup<'a>(
        &'a self,
        name: &'a str,
        value: &'a str,
        _token: &'a str,
    ) -> BoxFut<'a, Result<(), String>> {
        Box::pin(self.update(name, value, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        let mut v = Vec::new();
        encode_name(&mut v, "_acme-challenge.Example.com.").unwrap();
        assert_eq!(v, b"\x0f_acme-challenge\x07Example\x03com\x00");
        let msg = b"\x00\x00\x03foo\x03com\x00\x03bar\xc0\x02";
        assert_eq!(parse_name(msg, 2).unwrap(), ("foo.com".into(), 11));
        assert_eq!(parse_name(msg, 11).unwrap(), ("bar.foo.com".into(), 17));
        // pointer loop
        assert!(parse_name(b"\xc0\x00", 0).is_err());
    }
}
