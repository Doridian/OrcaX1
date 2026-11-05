//! FileStore backed by the printer's implicit-TLS FTP server (remote mode).
//!
//! One control connection per API call (the printer allows few concurrent
//! sessions, so they are capped by a semaphore). Passive mode, PROT P, and a
//! shared rustls config so the data connection resumes the control
//! connection's TLS session, which Bambu's server requires.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use md5::Digest;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tracing::debug;

use crate::config::Config;
use crate::files::{ApiError, rel_to_string};
use crate::store::{ByteStream, Download, Entry, FileStore};

const REPLY_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

type Tls = TlsStream<TcpStream>;

#[derive(Debug, Clone)]
pub struct Reply {
    pub code: u16,
    pub text: String,
}

fn bad_gateway(msg: impl std::fmt::Display) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, format!("printer FTP: {msg}"))
}

fn reply_err(r: &Reply) -> ApiError {
    let lower = r.text.to_ascii_lowercase();
    let code = match r.code {
        450 | 550 if lower.contains("not empty") => StatusCode::CONFLICT,
        450 | 550 => StatusCode::NOT_FOUND,
        501 | 553 => StatusCode::BAD_REQUEST,
        452 | 552 => StatusCode::INSUFFICIENT_STORAGE,
        _ => StatusCode::BAD_GATEWAY,
    };
    ApiError::new(code, format!("printer FTP {}: {}", r.code, r.text))
}

struct Ctrl {
    s: Tls,
    buf: BytesMut,
}

impl Ctrl {
    /// Reads one CRLF line. Cancel-safe (state lives in `buf`).
    async fn read_line(&mut self) -> Result<String, ApiError> {
        loop {
            if let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
                let line = self.buf.split_to(i + 1);
                return Ok(String::from_utf8_lossy(&line).trim_end().to_string());
            }
            if self.buf.len() > 64 * 1024 {
                return Err(bad_gateway("control line too long"));
            }
            let n = self.s.read_buf(&mut self.buf).await.map_err(bad_gateway)?;
            if n == 0 {
                return Err(bad_gateway("control connection closed"));
            }
        }
    }

    /// Reads a (possibly multi-line) reply. Cancel-safe between lines only,
    /// so callers race it only before any line has arrived.
    async fn read_reply(&mut self) -> Result<Reply, ApiError> {
        let fut = async {
            let first = self.read_line().await?;
            let code: u16 = first
                .get(..3)
                .and_then(|c| c.parse().ok())
                .ok_or_else(|| bad_gateway(format!("bad reply {first:?}")))?;
            let mut text = first.get(4..).unwrap_or("").to_string();
            if first.as_bytes().get(3) == Some(&b'-') {
                let end = format!("{code} ");
                loop {
                    let l = self.read_line().await?;
                    if l.starts_with(&end) || l == code.to_string() {
                        text.push('\n');
                        text.push_str(l.get(4..).unwrap_or(""));
                        break;
                    }
                    text.push('\n');
                    text.push_str(&l);
                }
            }
            Ok(Reply { code, text })
        };
        tokio::time::timeout(REPLY_TIMEOUT, fut)
            .await
            .map_err(|_| bad_gateway("reply timeout"))?
    }

    async fn send(&mut self, line: &str) -> Result<(), ApiError> {
        debug!(cmd = %line.split(' ').next().unwrap_or(""), "FTP >");
        self.s
            .write_all(format!("{line}\r\n").as_bytes())
            .await
            .map_err(bad_gateway)
    }

    async fn cmd(&mut self, line: &str) -> Result<Reply, ApiError> {
        self.send(line).await?;
        self.read_reply().await
    }

    /// Sends a command and requires a reply code in `ok`.
    async fn expect(&mut self, line: &str, ok: &[u16]) -> Result<Reply, ApiError> {
        let r = self.cmd(line).await?;
        if ok.contains(&r.code) {
            Ok(r)
        } else {
            Err(reply_err(&r))
        }
    }
}

pub struct FtpsStore {
    host: String,
    port: u16,
    cfg: Arc<Config>,
    tls: TlsConnector,
    sem: Arc<Semaphore>,
}

struct Session {
    ctrl: Ctrl,
    /// Server advertises MLSD in FEAT.
    mlsd: bool,
    _permit: OwnedSemaphorePermit,
}

pub fn ftp_path(rel: &Path) -> String {
    format!("/{}", rel_to_string(rel))
}

impl FtpsStore {
    pub fn new(host: String, port: u16, cfg: Arc<Config>) -> Self {
        // A single config (and thus a single session cache) for control and
        // data connections, so the data connection resumes the session.
        Self {
            host,
            port,
            cfg,
            tls: TlsConnector::from(crate::tls::insecure_client_config()),
            sem: Arc::new(Semaphore::new(2)),
        }
    }

    async fn tls_connect(&self, port: u16) -> Result<TcpStream, ApiError> {
        let host = self.host.trim_start_matches('[').trim_end_matches(']');
        tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
            .await
            .map_err(|_| bad_gateway(format!("connect {}:{port} timed out", self.host)))?
            .map_err(|e| bad_gateway(format!("connect {}:{port}: {e}", self.host)))
    }

    async fn handshake(&self, tcp: TcpStream) -> Result<Tls, ApiError> {
        tokio::time::timeout(
            CONNECT_TIMEOUT,
            self.tls.connect(crate::tls::server_name(&self.host), tcp),
        )
        .await
        .map_err(|_| bad_gateway("TLS handshake timed out"))?
        .map_err(|e| bad_gateway(format!("TLS handshake: {e}")))
    }

    async fn login(&self) -> Result<Session, ApiError> {
        let permit = self
            .sem
            .clone()
            .acquire_owned()
            .await
            .map_err(bad_gateway)?;
        let code = self
            .cfg
            .access_code()
            .ok_or_else(|| bad_gateway("no access code configured"))?;
        let tcp = self.tls_connect(self.port).await?;
        let s = self.handshake(tcp).await?;
        let mut ctrl = Ctrl {
            s,
            buf: BytesMut::with_capacity(4096),
        };
        let hello = ctrl.read_reply().await?;
        if hello.code != 220 {
            return Err(reply_err(&hello));
        }
        let r = ctrl.cmd("USER bblp").await?;
        if r.code == 331 {
            // The printer's vsftpd answers a wrong password with a plaintext
            // reply on the TLS stream, which surfaces as a TLS decode error.
            let r = ctrl.cmd(&format!("PASS {code}")).await.map_err(|_| {
                bad_gateway("login failed (connection broken after PASS); check the access code".to_string())
            })?;
            if r.code != 230 {
                return Err(bad_gateway(format!(
                    "login failed ({} {}); check the access code",
                    r.code, r.text
                )));
            }
        } else if r.code != 230 {
            return Err(reply_err(&r));
        }
        ctrl.expect("PBSZ 0", &[200]).await?;
        ctrl.expect("PROT P", &[200]).await?;
        ctrl.expect("TYPE I", &[200]).await?;
        let _ = ctrl.cmd("OPTS UTF8 ON").await;
        // Probe MLSD via FEAT rather than by trial: a failed transfer command
        // can burn a TLS 1.3 session ticket, and the next data connection
        // then fails the server's session-reuse check.
        let feat = ctrl.cmd("FEAT").await?;
        let mlsd = feat.code == 211
            && feat.text.lines().any(|l| {
                l.trim().eq_ignore_ascii_case("MLSD")
                    || l.trim().to_ascii_uppercase().starts_with("MLST")
            });
        Ok(Session {
            ctrl,
            mlsd,
            _permit: permit,
        })
    }

    /// Enters passive mode and returns the data port. The address in the
    /// PASV reply is ignored in favour of the control host (NAT-safe).
    async fn passive_port(&self, ctrl: &mut Ctrl) -> Result<u16, ApiError> {
        let r = ctrl.cmd("PASV").await?;
        if r.code == 227 {
            return parse_pasv(&r.text)
                .ok_or_else(|| bad_gateway(format!("bad PASV reply {:?}", r.text)));
        }
        let r = ctrl.expect("EPSV", &[229]).await?;
        parse_epsv(&r.text).ok_or_else(|| bad_gateway(format!("bad EPSV reply {:?}", r.text)))
    }

    /// Opens a TLS data connection for `cmd` (LIST/RETR/STOR...). The data
    /// TLS handshake races the 1xx preliminary reply because servers differ
    /// in which they wait for first.
    async fn open_data(&self, ctrl: &mut Ctrl, cmd: &str) -> Result<Tls, ApiError> {
        let port = self.passive_port(ctrl).await?;
        let tcp = self.tls_connect(port).await?;
        ctrl.send(cmd).await?;
        let hs = self.handshake(tcp);
        tokio::pin!(hs);
        let mut data = None;
        let mut prelim = false;
        while data.is_none() || !prelim {
            tokio::select! {
                d = &mut hs, if data.is_none() => data = Some(d?),
                r = ctrl.read_reply(), if !prelim => {
                    let r = r?;
                    if !matches!(r.code, 125 | 150) {
                        return Err(reply_err(&r));
                    }
                    prelim = true;
                }
            }
        }
        Ok(data.unwrap())
    }

    async fn finish(ctrl: &mut Ctrl) -> Result<(), ApiError> {
        let r = ctrl.read_reply().await?;
        if matches!(r.code, 226 | 250) {
            Ok(())
        } else {
            Err(reply_err(&r))
        }
    }

    async fn read_all(&self, ctrl: &mut Ctrl, cmd: &str) -> Result<String, ApiError> {
        let mut data = self.open_data(ctrl, cmd).await?;
        let mut out = Vec::new();
        read_to_end_lenient(&mut data, &mut out)
            .await
            .map_err(bad_gateway)?;
        let _ = data.shutdown().await;
        drop(data);
        Self::finish(ctrl).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

/// Reads to EOF, treating a missing TLS close_notify as a normal EOF (the
/// final 226 reply on the control connection confirms completion).
async fn read_to_end_lenient(s: &mut Tls, out: &mut Vec<u8>) -> std::io::Result<()> {
    match s.read_to_end(out).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(()),
        Err(e) => Err(e),
    }
}

impl FileStore for FtpsStore {
    fn list<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<Vec<Entry>, ApiError>> {
        Box::pin(async move {
            let mut s = self.login().await?;
            let c = &mut s.ctrl;
            let r = c.cmd(&format!("CWD {}", ftp_path(rel))).await?;
            if r.code != 250 {
                return Err(ApiError::new(
                    StatusCode::NOT_FOUND,
                    format!("not a directory: {}", r.text),
                ));
            }
            let now = time::OffsetDateTime::now_utc();
            let entries = if s.mlsd {
                parse_mlsd(&self.read_all(c, "MLSD").await?)
            } else {
                let t = self.read_all(c, "LIST").await?;
                t.lines().filter_map(|l| parse_list_line(l, now)).collect()
            };
            let _ = c.cmd("QUIT").await;
            Ok(entries)
        })
    }

    fn download<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<Download, ApiError>> {
        Box::pin(async move {
            let mut s = self.login().await?;
            let path = ftp_path(rel);
            let size = match s.ctrl.cmd(&format!("SIZE {path}")).await? {
                r if r.code == 213 => r.text.trim().parse::<u64>().ok(),
                _ => None,
            };
            let data = self.open_data(&mut s.ctrl, &format!("RETR {path}")).await?;
            struct St {
                s: Session,
                data: Tls,
                got: u64,
                size: Option<u64>,
            }
            let st = St {
                s,
                data,
                got: 0,
                size,
            };
            let body = futures_util::stream::unfold(Some(st), |st| async move {
                let mut st = st?;
                let mut buf = BytesMut::with_capacity(64 * 1024);
                let eof = match st.data.read_buf(&mut buf).await {
                    Ok(0) => true,
                    Ok(n) => {
                        st.got += n as u64;
                        return Some((Ok::<Bytes, std::io::Error>(buf.freeze()), Some(st)));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => true,
                    Err(e) => return Some((Err(e), None)),
                };
                debug_assert!(eof);
                // Close our side (TLS close_notify): servers such as vsftpd
                // wait for it before sending the final 226.
                let _ = st.data.shutdown().await;
                if let Some(size) = st.size
                    && size != st.got
                {
                    let e = std::io::Error::other(format!(
                        "short transfer: {} of {size} bytes",
                        st.got
                    ));
                    return Some((Err(e), None));
                }
                match FtpsStore::finish(&mut st.s.ctrl).await {
                    Ok(()) => {
                        let _ = st.s.ctrl.cmd("QUIT").await;
                        None
                    }
                    Err(e) => Some((Err(std::io::Error::other(e.1)), None)),
                }
            });
            Ok(Download {
                size,
                body: body.boxed(),
            })
        })
    }

    fn delete<'a>(&'a self, rel: &'a Path) -> BoxFuture<'a, Result<(), ApiError>> {
        Box::pin(async move {
            let mut s = self.login().await?;
            let path = ftp_path(rel);
            let dele = s.ctrl.cmd(&format!("DELE {path}")).await?;
            if dele.code == 250 {
                return Ok(());
            }
            let rmd = s.ctrl.cmd(&format!("RMD {path}")).await?;
            let _ = s.ctrl.cmd("QUIT").await;
            match rmd.code {
                250 => Ok(()),
                _ if rmd.text.to_ascii_lowercase().contains("not empty") => Err(reply_err(&rmd)),
                _ => Err(reply_err(&dele)),
            }
        })
    }

    fn upload<'a>(
        &'a self,
        rel: &'a Path,
        mut body: ByteStream,
    ) -> BoxFuture<'a, Result<(u64, String), ApiError>> {
        Box::pin(async move {
            let mut s = self.login().await?;
            let c = &mut s.ctrl;
            // Create parent directories; failures (already exists) are fine.
            if let Some(parent) = rel.parent() {
                let mut acc = std::path::PathBuf::new();
                for comp in parent.components() {
                    acc.push(comp);
                    let _ = c.cmd(&format!("MKD {}", ftp_path(&acc))).await?;
                }
            }
            let path = ftp_path(rel);
            let part = format!("{path}.part");
            let mut data = self.open_data(c, &format!("STOR {part}")).await?;
            let mut hasher = md5::Md5::new();
            let mut size = 0u64;
            let res: Result<(), ApiError> = async {
                while let Some(chunk) = body.next().await {
                    let chunk =
                        chunk.map_err(|e| ApiError::bad_request(format!("upload aborted: {e}")))?;
                    hasher.update(&chunk);
                    size += chunk.len() as u64;
                    data.write_all(&chunk).await.map_err(bad_gateway)?;
                }
                data.shutdown().await.map_err(bad_gateway)?;
                Ok(())
            }
            .await;
            drop(data);
            if let Err(e) = res {
                // Best effort: the control connection may still be usable.
                let _ = tokio::time::timeout(Duration::from_secs(5), async {
                    let _ = c.read_reply().await;
                    let _ = c.cmd(&format!("DELE {part}")).await;
                })
                .await;
                return Err(e);
            }
            Self::finish(c).await?;
            let _ = c.cmd(&format!("DELE {path}")).await?;
            c.expect(&format!("RNFR {part}"), &[350]).await?;
            c.expect(&format!("RNTO {path}"), &[250]).await?;
            let _ = c.cmd("QUIT").await;
            Ok((size, crate::tls::hex(&hasher.finalize())))
        })
    }
}

/// "227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)." -> port
pub fn parse_pasv(text: &str) -> Option<u16> {
    let start = text
        .find('(')
        .map(|i| i + 1)
        .or_else(|| text.find(|c: char| c.is_ascii_digit()))?;
    let inner: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ',')
        .collect();
    let nums: Vec<u16> = inner.split(',').filter_map(|n| n.parse().ok()).collect();
    if nums.len() != 6 || nums[4] > 255 || nums[5] > 255 {
        return None;
    }
    Some(nums[4] * 256 + nums[5])
}

/// "229 Entering Extended Passive Mode (|||6446|)" -> port
pub fn parse_epsv(text: &str) -> Option<u16> {
    let s = text.find("(|||")? + 4;
    text[s..].split('|').next()?.parse().ok()
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// Parses a unix-style LIST line:
/// `-rw-r--r-- 1 user group 1234 Nov  5 12:11 name with spaces`
pub fn parse_list_line(line: &str, now: time::OffsetDateTime) -> Option<Entry> {
    // Tokens with byte offsets, so the name keeps its inner spacing.
    let mut toks: Vec<(usize, &str)> = Vec::new();
    let mut i = 0;
    let b = line.as_bytes();
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let s = i;
        while i < b.len() && !b[i].is_ascii_whitespace() {
            i += 1;
        }
        if s < i {
            toks.push((s, &line[s..i]));
        }
    }
    let perms = toks.first()?.1;
    if !perms.starts_with(['-', 'd', 'l']) {
        return None;
    }
    let m = (2..toks.len().saturating_sub(3)).find(|&k| {
        MONTHS.contains(&toks[k].1.to_ascii_lowercase().as_str())
            && toks[k - 1].1.parse::<u64>().is_ok()
            && toks[k + 1]
                .1
                .parse::<u8>()
                .is_ok_and(|d| (1..=31).contains(&d))
    })?;
    let size: u64 = toks[m - 1].1.parse().ok()?;
    let month = MONTHS
        .iter()
        .position(|x| *x == toks[m].1.to_ascii_lowercase())? as u8
        + 1;
    let day: u8 = toks[m + 1].1.parse().ok()?;
    let tyear = toks[m + 2].1;
    let name_start = toks.get(m + 3)?.0;
    let mut name = &line[name_start..];
    if perms.starts_with('l')
        && let Some(i) = name.find(" -> ")
    {
        name = &name[..i];
    }
    if name == "." || name == ".." {
        return None;
    }
    let month = time::Month::try_from(month).ok()?;
    let (year, hour, minute) = match tyear.split_once(':') {
        Some((h, mi)) => (now.year(), h.parse().ok()?, mi.parse().ok()?),
        None => (tyear.parse().ok()?, 0, 0),
    };
    let mk = |y: i32| -> Option<i64> {
        let d = time::Date::from_calendar_date(y, month, day).ok()?;
        Some(
            time::PrimitiveDateTime::new(d, time::Time::from_hms(hour, minute, 0).ok()?)
                .assume_utc()
                .unix_timestamp(),
        )
    };
    let mut ts = mk(year)?;
    // "Mon DD HH:MM" means within the last ~6 months: a future date is last year.
    if tyear.contains(':') && ts > now.unix_timestamp() + 86400 {
        ts = mk(year - 1)?;
    }
    let is_dir = perms.starts_with('d');
    Some(Entry {
        name: name.to_string(),
        is_dir,
        size: if is_dir { 0 } else { size },
        mtime: ts.max(0) as u64,
    })
}

/// Parses MLSD output: `type=file;size=12;modify=20241105121100; name`.
pub fn parse_mlsd(text: &str) -> Vec<Entry> {
    text.lines()
        .filter_map(|line| {
            let (facts, name) = line.split_once(' ')?;
            if name.is_empty() || name == "." || name == ".." {
                return None;
            }
            let mut kind = "";
            let mut size = 0;
            let mut mtime = 0;
            for f in facts.split(';') {
                let Some((k, v)) = f.split_once('=') else {
                    continue;
                };
                match k.to_ascii_lowercase().as_str() {
                    "type" => kind = v,
                    "size" => size = v.parse().unwrap_or(0),
                    "modify" => mtime = parse_mlsd_time(v).unwrap_or(0),
                    _ => {}
                }
            }
            let kind = kind.to_ascii_lowercase();
            if kind == "cdir" || kind == "pdir" {
                return None;
            }
            let is_dir = kind == "dir";
            Some(Entry {
                name: name.to_string(),
                is_dir,
                size: if is_dir { 0 } else { size },
                mtime,
            })
        })
        .collect()
}

fn parse_mlsd_time(v: &str) -> Option<u64> {
    let v = v.get(..14)?;
    let n = |r: std::ops::Range<usize>| v.get(r)?.parse::<u32>().ok();
    let month = time::Month::try_from(n(4..6)? as u8).ok()?;
    let d = time::Date::from_calendar_date(n(0..4)? as i32, month, n(6..8)? as u8).ok()?;
    let t = time::Time::from_hms(n(8..10)? as u8, n(10..12)? as u8, n(12..14)? as u8).ok()?;
    Some(
        time::PrimitiveDateTime::new(d, t)
            .assume_utc()
            .unix_timestamp()
            .max(0) as u64,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> time::OffsetDateTime {
        // 2026-11-05 12:00:00 UTC
        time::OffsetDateTime::from_unix_timestamp(1_793_880_000).unwrap()
    }

    #[test]
    fn pasv_epsv() {
        assert_eq!(
            parse_pasv("Entering Passive Mode (192,168,1,5,195,80)."),
            Some(50000)
        );
        assert_eq!(
            parse_pasv("Entering Passive Mode 192,168,1,5,4,1"),
            Some(1025)
        );
        assert_eq!(parse_pasv("garbage"), None);
        assert_eq!(
            parse_epsv("Entering Extended Passive Mode (|||6446|)"),
            Some(6446)
        );
    }

    #[test]
    fn list_unix() {
        let e = parse_list_line(
            "-rw-r--r--    1 root     root      1234567 Nov  5 11:30 my model.gcode.3mf",
            now(),
        )
        .unwrap();
        assert_eq!(e.name, "my model.gcode.3mf");
        assert_eq!((e.is_dir, e.size), (false, 1234567));
        assert_eq!(e.mtime, 1_793_880_000 - 1800);

        let e = parse_list_line("drwxr-xr-x 2 0 0 4096 Jan 15  2024 timelapse", now()).unwrap();
        assert_eq!((e.name.as_str(), e.is_dir, e.size), ("timelapse", true, 0));
        assert_eq!(e.mtime, 1_705_276_800);

        // Future date with a time means last year.
        let e = parse_list_line("-rw-r--r-- 1 u g 1 Dec 24 10:00 x", now()).unwrap();
        assert_eq!(e.mtime, 1_766_570_400);

        // No group column, double spaces in name, symlink.
        let e = parse_list_line("-rw-r--r-- 1 owner 42 Mar  3 2025 a  b", now()).unwrap();
        assert_eq!((e.name.as_str(), e.size), ("a  b", 42));
        let e = parse_list_line("lrwxrwxrwx 1 u g 7 Mar  3 2025 link -> target", now()).unwrap();
        assert_eq!(e.name, "link");

        assert!(parse_list_line("total 12", now()).is_none());
        assert!(parse_list_line("drwxr-xr-x 2 u g 4096 Jan 15 2024 .", now()).is_none());
    }

    #[test]
    fn mlsd() {
        let t = "type=cdir;modify=20241105121100; .\r\n\
                 type=dir;modify=20241105121100;UNIX.mode=0755; cache\r\n\
                 type=file;size=123;modify=20241105121100.123; a b.3mf\r\n";
        let v = parse_mlsd(t);
        assert_eq!(
            v,
            vec![
                Entry {
                    name: "cache".into(),
                    is_dir: true,
                    size: 0,
                    mtime: 1_730_808_660
                },
                Entry {
                    name: "a b.3mf".into(),
                    is_dir: false,
                    size: 123,
                    mtime: 1_730_808_660
                },
            ]
        );
    }
}
