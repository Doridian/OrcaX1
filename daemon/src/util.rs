//! Small shared helpers.

use std::future::Future;
use std::io;
use std::path::Path;
use std::pin::Pin;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub fn now_unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    use ring::rand::SecureRandom;
    let mut b = [0u8; N];
    ring::rand::SystemRandom::new()
        .fill(&mut b)
        .expect("system RNG");
    b
}

pub fn sha256_hex(data: &[u8]) -> String {
    crate::tls::hex(ring::digest::digest(&ring::digest::SHA256, data).as_ref())
}

pub fn read_opt(p: &Path) -> io::Result<Option<Vec<u8>>> {
    match std::fs::read(p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Writes via a temp file and rename, so readers never see a partial file.
pub fn write_atomic(p: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, p)
}
