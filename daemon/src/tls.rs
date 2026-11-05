//! TLS plumbing: the no-verification client config used for the printer's
//! self-signed MQTT/RTSPS endpoints, and the HTTPS server certificate
//! (user-supplied, or a persisted local CA + leaf that is re-issued when the
//! machine's addresses change).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::{ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme};
use tracing::{info, warn};

pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

// The printer's services present X.509 v1 certificates, which webpki refuses
// to parse ("UnsupportedCertVersion"), so even the handshake signature check
// would fail. Since the certificate itself is never validated, checking that
// the peer holds its key adds nothing; both checks are skipped.
impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Client config that accepts any server certificate. Only used for the
/// printer's own services, which present self-signed certificates.
pub fn insecure_client_config() -> Arc<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("ring supports default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoVerify(provider)))
        .with_no_client_auth();
    Arc::new(cfg)
}

pub fn server_name(host: &str) -> ServerName<'static> {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    ServerName::try_from(h.to_string()).unwrap_or_else(|_| ServerName::try_from("printer").unwrap())
}

fn err<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::other(e.to_string())
}

fn certified_key(
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> io::Result<Arc<CertifiedKey>> {
    let signer = rustls::crypto::ring::sign::any_supported_type(&key).map_err(err)?;
    Ok(Arc::new(CertifiedKey::new(chain, signer)))
}

#[derive(Debug)]
struct Resolver(RwLock<Arc<CertifiedKey>>);

impl ResolvesServerCert for Resolver {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.read().unwrap().clone())
    }
}

pub struct ServerTls {
    pub config: Arc<ServerConfig>,
    /// DER of the generated local CA, if we generated the certificate.
    pub ca_der: Option<Vec<u8>>,
}

pub fn server_config(
    cert: Option<&Path>,
    key: Option<&Path>,
    state_dir: &Path,
) -> io::Result<ServerTls> {
    let (ck, ca_der, refresh) = match (cert, key) {
        (Some(c), Some(k)) => {
            let chain = CertificateDer::pem_file_iter(c)
                .map_err(err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(err)?;
            let key = PrivateKeyDer::from_pem_file(k).map_err(err)?;
            info!(cert = %c.display(), "using supplied TLS certificate");
            (certified_key(chain, key)?, None, None)
        }
        _ => {
            let store = SelfSigned::new(state_dir)?;
            let ck = store.load_or_issue()?;
            let ca = store.ca_der.clone();
            (ck, Some(ca), Some(store))
        }
    };
    let resolver = Arc::new(Resolver(RwLock::new(ck)));
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(resolver.clone());
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    if let Some(store) = refresh {
        // Network addresses come and go (DHCP, WiFi coming up after us):
        // re-issue the leaf when the SAN set changes.
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(60));
            iv.tick().await;
            loop {
                iv.tick().await;
                let store = &store;
                match tokio::task::block_in_place(|| store.load_or_issue_if_changed()) {
                    Ok(Some(ck)) => *resolver.0.write().unwrap() = ck,
                    Ok(None) => {}
                    Err(e) => warn!("certificate refresh failed: {e}"),
                }
            }
        });
    }
    Ok(ServerTls {
        config: Arc::new(config),
        ca_der,
    })
}

/// Local CA + leaf certificate persisted in the state dir.
struct SelfSigned {
    dir: PathBuf,
    ca_params: CertificateParams,
    ca_key: KeyPair,
    ca_der: Vec<u8>,
}

const LEAF_DAYS: i64 = 800; // Apple caps locally trusted leaves at 825 days.

fn read_opt(p: &Path) -> io::Result<Option<String>> {
    match std::fs::read_to_string(p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn write_atomic(p: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, p)
}

pub fn hostname() -> Option<String> {
    let h = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .ok()?;
    let h = h.trim();
    (!h.is_empty() && h != "(none)").then(|| h.to_string())
}

/// Names and addresses the leaf certificate should cover.
fn current_sans() -> Vec<String> {
    let mut sans = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    if let Some(h) = hostname() {
        sans.push(h.clone());
        if !h.contains('.') {
            sans.push(format!("{h}.local"));
        }
    }
    if let Ok(ifs) = if_addrs::get_if_addrs() {
        for i in ifs {
            let ip = i.ip();
            // IPv4 only: IPv6 privacy addresses rotate and would force a
            // re-issue every few hours.
            if !i.is_loopback() && ip.is_ipv4() {
                sans.push(ip.to_string());
            }
        }
    }
    sans.sort();
    sans.dedup();
    sans
}

impl SelfSigned {
    fn new(dir: &Path) -> io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let key_path = dir.join("ca.key.pem");
        let crt_path = dir.join("ca.crt.pem");
        let (ca_key, fresh) = match read_opt(&key_path)? {
            Some(pem) => (KeyPair::from_pem(&pem).map_err(err)?, false),
            None => {
                let k = KeyPair::generate().map_err(err)?;
                write_atomic(&key_path, k.serialize_pem().as_bytes())?;
                (k, true)
            }
        };
        // The CA's name is derived from its key, so the issuer can be
        // reconstructed from the key alone without parsing the stored cert.
        let digest = md5_hex(ca_key.public_key_pem().as_bytes());
        let mut ca_params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::OrganizationName, "OrcaX1");
        dn.push(
            DnType::CommonName,
            format!("orcax1d local CA {}", &digest[..8]),
        );
        ca_params.distinguished_name = dn;
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        ca_params.not_before = rcgen::date_time_ymd(2024, 1, 1);
        ca_params.not_after = rcgen::date_time_ymd(2049, 12, 31);

        let ca_pem = match read_opt(&crt_path)? {
            Some(pem) if !fresh => pem,
            _ => {
                let cert = ca_params.self_signed(&ca_key).map_err(err)?;
                write_atomic(&crt_path, cert.pem().as_bytes())?;
                // Any old leaf was signed by a different key.
                let _ = std::fs::remove_file(dir.join("server.crt.pem"));
                info!(path = %crt_path.display(), "generated local CA certificate");
                cert.pem()
            }
        };
        let ca_der = CertificateDer::from_pem_slice(ca_pem.as_bytes())
            .map_err(err)?
            .to_vec();
        Ok(Self {
            dir: dir.to_path_buf(),
            ca_params,
            ca_key,
            ca_der,
        })
    }

    fn meta_path(&self) -> PathBuf {
        self.dir.join("server.meta")
    }

    fn wanted_meta(&self, sans: &[String]) -> String {
        sans.join("\n")
    }

    fn load_or_issue(&self) -> io::Result<Arc<CertifiedKey>> {
        Ok(match self.load_or_issue_if_changed()? {
            Some(ck) => ck,
            None => self.load()?,
        })
    }

    fn load(&self) -> io::Result<Arc<CertifiedKey>> {
        let chain = vec![
            CertificateDer::from_pem_file(self.dir.join("server.crt.pem")).map_err(err)?,
            CertificateDer::from(self.ca_der.clone()),
        ];
        let key = PrivateKeyDer::from_pem_file(self.dir.join("server.key.pem")).map_err(err)?;
        certified_key(chain, key)
    }

    /// Issues a new leaf if the SANs changed, the leaf is missing, or it
    /// expires within 30 days. Returns None if the stored one is still good.
    fn load_or_issue_if_changed(&self) -> io::Result<Option<Arc<CertifiedKey>>> {
        let sans = current_sans();
        let want = self.wanted_meta(&sans);
        let now = time::OffsetDateTime::now_utc();
        if let (Some(meta), true, true) = (
            read_opt(&self.meta_path())?,
            self.dir.join("server.crt.pem").exists(),
            self.dir.join("server.key.pem").exists(),
        ) {
            let mut lines = meta.splitn(2, '\n');
            let expires: i64 = lines.next().and_then(|l| l.parse().ok()).unwrap_or(0);
            let rest = lines.next().unwrap_or("");
            if rest == want && expires - now.unix_timestamp() > 30 * 86400 {
                return Ok(None);
            }
        }

        let key = KeyPair::generate().map_err(err)?;
        let mut params = CertificateParams::new(sans.clone()).map_err(err)?;
        let mut dn = DistinguishedName::new();
        dn.push(
            DnType::CommonName,
            hostname().unwrap_or_else(|| "orcax1d".into()),
        );
        params.distinguished_name = dn;
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.use_authority_key_identifier_extension = true;
        params.not_before = now - time::Duration::days(1);
        let not_after = now + time::Duration::days(LEAF_DAYS);
        params.not_after = not_after;
        let issuer = Issuer::from_params(&self.ca_params, &self.ca_key);
        let cert = params.signed_by(&key, &issuer).map_err(err)?;

        write_atomic(
            &self.dir.join("server.key.pem"),
            key.serialize_pem().as_bytes(),
        )?;
        write_atomic(&self.dir.join("server.crt.pem"), cert.pem().as_bytes())?;
        write_atomic(
            &self.meta_path(),
            format!("{}\n{}", not_after.unix_timestamp(), want).as_bytes(),
        )?;
        info!(sans = ?sans, "issued HTTPS certificate");

        let chain = vec![
            cert.der().clone(),
            CertificateDer::from(self.ca_der.clone()),
        ];
        let key = PrivateKeyDer::try_from(key.serialize_der()).map_err(err)?;
        Ok(Some(certified_key(chain, key)?))
    }
}

pub fn md5_hex(data: &[u8]) -> String {
    use md5::Digest;
    hex(&md5::Md5::digest(data))
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}
