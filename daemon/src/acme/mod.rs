//! ACME (Let's Encrypt and friends) certificates via the DNS-01 challenge
//! (or dns-persist-01, with a record the user sets up once), so the printer
//! never has to be reachable from the internet.
//!
//! Configured from the UI (`/api/acme`, behind login). The certificate is
//! served for TLS connections whose SNI matches one of its names; access by
//! IP address keeps using the self-signed certificate. Renewal runs in the
//! background 30 days before expiry.
//!
//! Files in `<state-dir>/acme/`: `config.json` (including DNS credentials),
//! `account.json` (ACME account key), `cert.pem`, `key.pem`, `cert.json`.

pub mod dns;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use base64::Engine;
use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, ExternalAccountKey,
    Identifier, NewAccount, NewOrder, OrderStatus, RetryPolicy,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::{info, warn};

use crate::App;
use crate::files::ApiError;
use crate::http_client::Http;
use crate::tls::CertResolver;
use crate::util::{self, now_unix};

const RENEW_BEFORE: i64 = 30 * 86400;
const RETRY_AFTER_FAILURE: i64 = 6 * 3600;
const LOG_LINES: usize = 60;

pub const DIRECTORIES: &[(&str, &str, bool)] = &[
    (
        "Let's Encrypt",
        "https://acme-v02.api.letsencrypt.org/directory",
        false,
    ),
    (
        "Let's Encrypt (staging)",
        "https://acme-staging-v02.api.letsencrypt.org/directory",
        false,
    ),
    ("ZeroSSL", "https://acme.zerossl.com/v2/DV90", true),
    (
        "Google Trust Services",
        "https://dv.acme-v02.api.pki.goog/directory",
        true,
    ),
];

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AcmeConfig {
    /// Keep a certificate issued and renewed in the background.
    pub enabled: bool,
    pub directory: String,
    pub email: String,
    pub domains: Vec<String>,
    /// External account binding (ZeroSSL, Google, most commercial CAs).
    pub eab_kid: String,
    pub eab_hmac: String,
    pub dns_provider: String,
    pub dns: dns::Settings,
    /// Wait after publishing the TXT records before asking the CA to check
    /// (not used for dns-persist-01).
    pub propagation_seconds: u32,
}

impl Default for AcmeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            directory: DIRECTORIES[0].1.to_string(),
            email: String::new(),
            domains: Vec::new(),
            eab_kid: String::new(),
            eab_hmac: String::new(),
            dns_provider: dns::PROVIDERS[0].id.to_string(),
            dns: Default::default(),
            propagation_seconds: 30,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct StoredAccount {
    directory: String,
    email: String,
    eab_kid: String,
    credentials: AccountCredentials,
}

impl StoredAccount {
    /// The account URL (`accounturi` in dns-persist-01 records). instant-acme
    /// keeps it private but serializes it as `id`.
    fn uri(&self) -> Option<String> {
        serde_json::to_value(&self.credentials).ok()?["id"]
            .as_str()
            .map(str::to_string)
    }
}

const DNS_PERSIST_01: &str = "dns-persist-01";
const ISSUER_NEEDED: &str =
    "set the CA's issuer domain name for dns-persist-01 (only Let's Encrypt's is known)";

#[derive(Serialize, Deserialize, Clone)]
pub struct CertMeta {
    pub domains: Vec<String>,
    pub directory: String,
    pub issued_at: i64,
    pub not_after: i64,
}

#[derive(Serialize, Default)]
struct RunStatus {
    running: bool,
    last_attempt: Option<i64>,
    last_success: Option<i64>,
    last_error: Option<String>,
    log: Vec<(i64, String)>,
}

pub struct Acme {
    dir: PathBuf,
    http: Http,
    resolver: Option<Arc<CertResolver>>,
    config: Mutex<AcmeConfig>,
    cert: Mutex<Option<CertMeta>>,
    status: Mutex<RunStatus>,
}

impl Acme {
    /// Loads saved state, installs a saved certificate, and starts the
    /// renewal loop.
    pub fn start(
        state_dir: &std::path::Path,
        resolver: Option<Arc<CertResolver>>,
        http: Http,
    ) -> Arc<Self> {
        let dir = state_dir.join("acme");
        let config = util::read_opt(&dir.join("config.json"))
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let this = Arc::new(Self {
            dir,
            http,
            resolver,
            config: Mutex::new(config),
            cert: Mutex::new(None),
            status: Mutex::new(RunStatus::default()),
        });
        if let Err(e) = this.load_cert() {
            warn!("ACME certificate: {e}");
        }
        let t = this.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(60)).await;
            loop {
                if t.due() {
                    let _ = t.begin();
                }
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        });
        this
    }

    fn load_cert(&self) -> Result<(), String> {
        let (Some(meta), Some(crt), Some(key)) = (
            util::read_opt(&self.dir.join("cert.json")).map_err(|e| e.to_string())?,
            util::read_opt(&self.dir.join("cert.pem")).map_err(|e| e.to_string())?,
            util::read_opt(&self.dir.join("key.pem")).map_err(|e| e.to_string())?,
        ) else {
            return Ok(());
        };
        let meta: CertMeta = serde_json::from_slice(&meta).map_err(|e| e.to_string())?;
        let ck = crate::tls::certified_key_from_pem(&crt, &key).map_err(|e| e.to_string())?;
        if let Some(r) = &self.resolver {
            r.set_acme(Some((meta.domains.clone(), ck)));
        }
        info!(domains = ?meta.domains, not_after = meta.not_after, "using ACME certificate");
        *self.cert.lock().unwrap() = Some(meta);
        Ok(())
    }

    /// Whether the background loop should (re)issue now.
    fn due(&self) -> bool {
        let cfg = self.config.lock().unwrap().clone();
        if !cfg.enabled || cfg.domains.is_empty() {
            return false;
        }
        {
            let st = self.status.lock().unwrap();
            if st.last_error.is_some()
                && st
                    .last_attempt
                    .is_some_and(|t| now_unix() - t < RETRY_AFTER_FAILURE)
            {
                return false;
            }
        }
        match &*self.cert.lock().unwrap() {
            None => true,
            Some(m) => {
                m.not_after - now_unix() < RENEW_BEFORE
                    || m.directory != cfg.directory
                    || !same_names(&m.domains, &cfg.domains)
            }
        }
    }

    fn log(&self, msg: impl Into<String>) {
        let msg = msg.into();
        info!("acme: {msg}");
        let mut st = self.status.lock().unwrap();
        if st.log.len() >= LOG_LINES {
            st.log.remove(0);
        }
        st.log.push((now_unix(), msg));
    }

    /// Starts an issuance in the background.
    fn begin(self: &Arc<Self>) -> Result<(), ApiError> {
        let cfg = self.config.lock().unwrap().clone();
        validate(&cfg, true, &self.http).map_err(ApiError::bad_request)?;
        {
            let mut st = self.status.lock().unwrap();
            if st.running {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "a certificate request is already running",
                ));
            }
            st.running = true;
            st.last_attempt = Some(now_unix());
            st.log.clear();
        }
        let this = self.clone();
        tokio::spawn(async move {
            let res = this.issue(cfg).await;
            if let Err(e) = &res {
                this.log(format!("failed: {e}"));
            }
            let mut st = this.status.lock().unwrap();
            st.running = false;
            match res {
                Ok(()) => {
                    st.last_error = None;
                    st.last_success = Some(now_unix());
                }
                Err(e) => st.last_error = Some(e),
            }
        });
        Ok(())
    }

    /// The saved account, if it was made for `cfg`'s CA, email and EAB key.
    fn stored_account(&self, cfg: &AcmeConfig) -> Option<StoredAccount> {
        util::read_opt(&self.dir.join("account.json"))
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice::<StoredAccount>(&b).ok())
            .filter(|s| {
                s.directory == cfg.directory && s.email == cfg.email && s.eab_kid == cfg.eab_kid
            })
    }

    async fn account(&self, cfg: &AcmeConfig) -> Result<Account, String> {
        let path = self.dir.join("account.json");
        let builder = || Account::builder_with_http(Box::new(self.http.clone()));
        if let Some(stored) = self.stored_account(cfg) {
            return builder()
                .from_credentials(stored.credentials)
                .await
                .map_err(|e| format!("loading ACME account: {e}"));
        }
        self.log(format!("registering an account with {}", cfg.directory));
        let contact = (!cfg.email.is_empty()).then(|| format!("mailto:{}", cfg.email));
        let contact: Vec<&str> = contact.iter().map(String::as_str).collect();
        let eab = if cfg.eab_kid.is_empty() {
            None
        } else {
            let b = &cfg.eab_hmac;
            let key = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(b.trim_end_matches('='))
                .or_else(|_| base64::engine::general_purpose::STANDARD.decode(b))
                .map_err(|_| "EAB HMAC key is not valid base64".to_string())?;
            Some(ExternalAccountKey::new(cfg.eab_kid.clone(), &key))
        };
        let (account, credentials) = builder()
            .create(
                &NewAccount {
                    contact: &contact,
                    terms_of_service_agreed: true,
                    only_return_existing: false,
                },
                cfg.directory.clone(),
                eab.as_ref(),
            )
            .await
            .map_err(|e| format!("creating ACME account: {e}"))?;
        let stored = StoredAccount {
            directory: cfg.directory.clone(),
            email: cfg.email.clone(),
            eab_kid: cfg.eab_kid.clone(),
            credentials,
        };
        util::write_atomic(
            &path,
            &serde_json::to_vec(&stored).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("saving {}: {e}", path.display()))?;
        Ok(account)
    }

    async fn issue(&self, cfg: AcmeConfig) -> Result<(), String> {
        let info = dns::find(&cfg.dns_provider).ok_or("unknown DNS provider")?;
        let provider = (info.build)(&cfg.dns, &self.http)?;
        let account = self.account(&cfg).await?;
        if info.persistent {
            self.log(format!("account {}", account.id()));
        }
        self.log(format!(
            "ordering a certificate for {}",
            cfg.domains.join(", ")
        ));
        let ids: Vec<Identifier> = cfg
            .domains
            .iter()
            .map(|d| Identifier::Dns(d.clone()))
            .collect();
        let mut order = account
            .new_order(&NewOrder::new(&ids))
            .await
            .map_err(|e| format!("new order: {e}"))?;

        // (record name, value, cleanup token)
        let mut records: Vec<(String, String, String)> = Vec::new();
        let res = self
            .validate_order(
                &mut order,
                provider.as_ref(),
                &mut records,
                info.persistent,
                info.single_value,
                cfg.propagation_seconds,
            )
            .await;
        for (name, value, token) in &records {
            if let Err(e) = provider.cleanup(name, value, token).await {
                self.log(format!("could not remove TXT {name}: {e}"));
            }
        }
        if let Err(e) = res {
            return Err(match self.persist_records(&cfg) {
                Some(Ok(r)) if info.persistent => format!(
                    "{e} (expected TXT records: {})",
                    r.iter()
                        .map(|(n, v)| format!("{n} \"{v}\""))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                _ => e,
            });
        }

        self.log("validated; finalizing");
        let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
        let mut params =
            rcgen::CertificateParams::new(cfg.domains.clone()).map_err(|e| e.to_string())?;
        params.distinguished_name = rcgen::DistinguishedName::new();
        let csr = params.serialize_request(&key).map_err(|e| e.to_string())?;
        order
            .finalize_csr(csr.der())
            .await
            .map_err(|e| format!("finalize: {e}"))?;
        let chain = order
            .poll_certificate(&RetryPolicy::new().timeout(Duration::from_secs(120)))
            .await
            .map_err(|e| format!("downloading certificate: {e}"))?;

        let key_pem = key.serialize_pem();
        let ck = crate::tls::certified_key_from_pem(chain.as_bytes(), key_pem.as_bytes())
            .map_err(|e| e.to_string())?;
        let not_after = ck
            .end_entity_cert()
            .ok()
            .and_then(|c| cert_not_after(c))
            .ok_or("could not read the certificate's expiry")?;
        let meta = CertMeta {
            domains: cfg.domains.clone(),
            directory: cfg.directory.clone(),
            issued_at: now_unix(),
            not_after,
        };
        let w = |name: &str, data: &[u8]| {
            util::write_atomic(&self.dir.join(name), data)
                .map_err(|e| format!("saving {name}: {e}"))
        };
        w("key.pem", key_pem.as_bytes())?;
        w("cert.pem", chain.as_bytes())?;
        w(
            "cert.json",
            &serde_json::to_vec(&meta).map_err(|e| e.to_string())?,
        )?;
        if let Some(r) = &self.resolver {
            r.set_acme(Some((meta.domains.clone(), ck)));
        }
        let days = (not_after - now_unix()) / 86400;
        self.log(format!("certificate installed, valid for {days} days"));
        *self.cert.lock().unwrap() = Some(meta);
        Ok(())
    }

    /// Publishes the DNS-01 records, waits, and has the CA check them. With
    /// `persist`, uses dns-persist-01 and the records the user set up. With
    /// `single_value`, names sharing a record are checked in separate rounds.
    async fn validate_order(
        &self,
        order: &mut instant_acme::Order,
        provider: &dyn dns::DnsProvider,
        records: &mut Vec<(String, String, String)>,
        persist: bool,
        single_value: bool,
        wait: u32,
    ) -> Result<(), String> {
        let kind = || {
            if persist {
                ChallengeType::Unknown(DNS_PERSIST_01.into())
            } else {
                ChallengeType::Dns01
            }
        };
        for first in std::iter::once(true).chain(std::iter::repeat(false)) {
            // Indices of the authorizations handled in this round, and
            // whether some had to wait for a later one.
            let mut batch = Vec::new();
            let mut deferred = false;
            let mut names = std::collections::HashSet::new();
            let mut authzs = order.authorizations();
            let mut i = 0;
            while let Some(a) = authzs.next().await {
                let idx = i;
                i += 1;
                let mut a = a.map_err(|e| format!("authorization: {e}"))?;
                let ident = a.identifier().to_string();
                match a.status {
                    AuthorizationStatus::Pending => {}
                    AuthorizationStatus::Valid => {
                        if first {
                            self.log(format!("{ident}: already authorized"));
                        }
                        continue;
                    }
                    s => return Err(format!("{ident}: authorization is {s:?}")),
                }
                let Identifier::Dns(base) = a.identifier().identifier.clone() else {
                    return Err(format!("{ident}: not a DNS name"));
                };
                if persist {
                    a.challenge(kind()).ok_or_else(|| {
                        format!("{ident}: the CA offered no {DNS_PERSIST_01} challenge")
                    })?;
                    self.log(format!("{ident}: using TXT _validation-persist.{base}"));
                    batch.push(idx);
                    continue;
                }
                let name = format!("_acme-challenge.{base}");
                if single_value && names.contains(&name) {
                    deferred = true;
                    continue;
                }
                let ch = a
                    .challenge(kind())
                    .ok_or_else(|| format!("{ident}: the CA offered no dns-01 challenge"))?;
                let value = ch.key_authorization().dns_value();
                self.log(format!("{ident}: adding TXT {name}"));
                let token = provider
                    .present(&name, &value)
                    .await
                    .map_err(|e| format!("{ident}: {e}"))?;
                names.insert(name.clone());
                records.push((name, value, token));
                batch.push(idx);
            }
            if batch.is_empty() {
                if first {
                    return Ok(());
                }
                break;
            }
            if wait > 0 && !persist {
                self.log(format!("waiting {wait} s for DNS to propagate"));
                tokio::time::sleep(Duration::from_secs(wait.into())).await;
            }
            let mut authzs = order.authorizations();
            let mut i = 0;
            while let Some(a) = authzs.next().await {
                let mut a = a.map_err(|e| format!("authorization: {e}"))?;
                i += 1;
                if !batch.contains(&(i - 1)) {
                    continue;
                }
                if let Some(mut ch) = a.challenge(kind()) {
                    ch.set_ready()
                        .await
                        .map_err(|e| format!("challenge: {e}"))?;
                }
            }
            self.log("asked the CA to check the records");
            if !deferred {
                break;
            }
            // Wait for this round before its records are overwritten.
            self.await_authorizations(order, &batch).await?;
        }
        let status = order
            .poll_ready(
                &RetryPolicy::new()
                    .initial_delay(Duration::from_secs(2))
                    .timeout(Duration::from_secs(180)),
            )
            .await
            .map_err(|e| format!("waiting for validation: {e}"))?;
        if status == OrderStatus::Ready {
            return Ok(());
        }
        // Collect the CA's explanation.
        let mut why = Vec::new();
        let mut authzs = order.authorizations();
        while let Some(Ok(a)) = authzs.next().await {
            for c in &a.challenges {
                if let Some(p) = &c.error {
                    why.push(format!(
                        "{}: {}",
                        a.identifier(),
                        p.detail.as_deref().unwrap_or("validation failed")
                    ));
                }
            }
        }
        Err(if why.is_empty() {
            format!("order is {status:?}")
        } else {
            why.join("; ")
        })
    }

    /// Polls the authorizations at `batch` (indices into the order) until
    /// the CA has decided; fails unless all are valid.
    async fn await_authorizations(
        &self,
        order: &mut instant_acme::Order,
        batch: &[usize],
    ) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        let mut authzs = order.authorizations();
        let mut i = 0;
        while let Some(a) = authzs.next().await {
            let mut a = a.map_err(|e| format!("authorization: {e}"))?;
            i += 1;
            if !batch.contains(&(i - 1)) {
                continue;
            }
            while a.status == AuthorizationStatus::Pending {
                if tokio::time::Instant::now() > deadline {
                    return Err(format!("{}: validation timed out", a.identifier()));
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
                a.refresh()
                    .await
                    .map_err(|e| format!("authorization: {e}"))?;
            }
            if a.status != AuthorizationStatus::Valid {
                let why = a
                    .challenges
                    .iter()
                    .find_map(|c| c.error.as_ref()?.detail.clone())
                    .unwrap_or_else(|| format!("authorization is {:?}", a.status));
                return Err(format!("{}: {why}", a.identifier()));
            }
            self.log(format!("{}: validated", a.identifier()));
        }
        Ok(())
    }

    /// The dns-persist-01 records for the saved account: `None` if the
    /// provider isn't `persist` or there is no account yet, `Err` if the
    /// issuer is unknown.
    fn persist_records(&self, cfg: &AcmeConfig) -> Option<Result<Vec<(String, String)>, String>> {
        if !dns::find(&cfg.dns_provider).is_some_and(|p| p.persistent) {
            return None;
        }
        let uri = self.stored_account(cfg)?.uri()?;
        Some(
            dns::persist::issuer(&cfg.dns, &cfg.directory)
                .map(|i| dns::persist::records(&cfg.domains, &i, &uri))
                .ok_or_else(|| ISSUER_NEEDED.to_string()),
        )
    }

    fn view(&self) -> Value {
        let cfg = self.config.lock().unwrap().clone();
        let persist = dns::find(&cfg.dns_provider)
            .is_some_and(|p| p.persistent)
            .then(|| {
                let account = self.stored_account(&cfg).and_then(|s| s.uri());
                let (records, error) = match self.persist_records(&cfg) {
                    Some(Ok(r)) => (r, None),
                    Some(Err(e)) => (Vec::new(), Some(e)),
                    None => (Vec::new(), None),
                };
                let records: Vec<Value> = records
                    .into_iter()
                    .map(|(name, value)| json!({ "name": name, "value": value }))
                    .collect();
                json!({ "account": account, "records": records, "error": error })
            });
        let (cfg, secrets_set) = redact(cfg);
        json!({
            "config": cfg,
            "secrets_set": secrets_set,
            "providers": dns::PROVIDERS,
            "directories": DIRECTORIES.iter().map(|(label, url, eab)| json!({ "label": label, "url": url, "eab": eab })).collect::<Vec<_>>(),
            "tls": self.resolver.is_some(),
            "cert": *self.cert.lock().unwrap(),
            "status": *self.status.lock().unwrap(),
            "persist": persist,
        })
    }
}

fn same_names(a: &[String], b: &[String]) -> bool {
    let mut a = a.to_vec();
    let mut b = b.to_vec();
    a.sort();
    b.sort();
    a == b
}

fn valid_domain(d: &str) -> bool {
    let base = d.strip_prefix("*.").unwrap_or(d);
    let labels: Vec<&str> = base.split('.').collect();
    base.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
        && !labels.last().unwrap().chars().all(|c| c.is_ascii_digit())
}

/// Checks a config; `full` also requires everything needed to issue.
fn validate(cfg: &AcmeConfig, full: bool, http: &Http) -> Result<(), String> {
    if !cfg.directory.starts_with("https://") {
        return Err("the ACME directory must be an https:// URL".into());
    }
    if let Some(d) = cfg.domains.iter().find(|d| !valid_domain(d)) {
        return Err(format!("{d:?} is not a valid domain name"));
    }
    if cfg.domains.len() > 50 {
        return Err("too many domains".into());
    }
    if !cfg.email.is_empty()
        && (!cfg.email.contains('@') || cfg.email.contains(char::is_whitespace))
    {
        return Err("invalid email address".into());
    }
    if cfg.propagation_seconds > 900 {
        return Err("propagation wait is at most 900 seconds".into());
    }
    let info = dns::find(&cfg.dns_provider)
        .ok_or_else(|| format!("unknown DNS provider {:?}", cfg.dns_provider))?;
    if full || cfg.enabled {
        if cfg.domains.is_empty() {
            return Err("add at least one domain".into());
        }
        if !cfg.eab_kid.is_empty() && cfg.eab_hmac.is_empty() {
            return Err("the EAB key ID needs its HMAC key".into());
        }
        (info.build)(&cfg.dns, http).map(|_| ())?;
        if info.persistent && dns::persist::issuer(&cfg.dns, &cfg.directory).is_none() {
            return Err(ISSUER_NEEDED.into());
        }
    }
    Ok(())
}

/// Blanks secret values; returns the names of those that were set.
fn redact(mut cfg: AcmeConfig) -> (AcmeConfig, Vec<String>) {
    let mut set = Vec::new();
    if !cfg.eab_hmac.is_empty() {
        cfg.eab_hmac.clear();
        set.push("eab_hmac".to_string());
    }
    if let Some(info) = dns::find(&cfg.dns_provider) {
        for f in info.fields.iter().filter(|f| f.secret) {
            if let Some(v) = cfg.dns.get_mut(f.key)
                && v.as_str().is_some_and(|s| !s.is_empty())
            {
                *v = Value::String(String::new());
                set.push(format!("dns.{}", f.key));
            }
        }
    }
    (cfg, set)
}

/// Cleans up a config from the browser; empty secrets keep their saved value.
fn merge(mut new: AcmeConfig, old: &AcmeConfig) -> AcmeConfig {
    new.directory = new.directory.trim().to_string();
    new.email = new.email.trim().to_string();
    new.eab_kid = new.eab_kid.trim().to_string();
    new.eab_hmac = new.eab_hmac.trim().to_string();
    let mut domains: Vec<String> = new
        .domains
        .iter()
        .map(|d| d.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|d| !d.is_empty())
        .collect();
    let mut seen = std::collections::HashSet::new();
    domains.retain(|d| seen.insert(d.clone()));
    new.domains = domains;
    if new.eab_hmac.is_empty() {
        new.eab_hmac = old.eab_hmac.clone();
    }
    if let Some(info) = dns::find(&new.dns_provider) {
        let mut dns = dns::Settings::new();
        for f in info.fields {
            let mut v = dns::get(&new.dns, f.key).to_string();
            if v.is_empty() && f.secret && old.dns_provider == new.dns_provider {
                v = dns::get(&old.dns, f.key).to_string();
            }
            if !v.is_empty() {
                dns.insert(f.key.to_string(), Value::String(v));
            }
        }
        new.dns = dns;
    }
    new
}

/// notAfter of a DER certificate, as a Unix time.
fn cert_not_after(der: &[u8]) -> Option<i64> {
    fn tlv(b: &[u8]) -> Option<(u8, &[u8], &[u8])> {
        let tag = *b.first()?;
        let l0 = *b.get(1)? as usize;
        let (len, hdr) = if l0 < 0x80 {
            (l0, 2)
        } else {
            let n = l0 & 0x7f;
            if n == 0 || n > 4 {
                return None;
            }
            let mut len = 0usize;
            for i in 0..n {
                len = (len << 8) | *b.get(2 + i)? as usize;
            }
            (len, 2 + n)
        };
        Some((tag, b.get(hdr..hdr.checked_add(len)?)?, b.get(hdr + len..)?))
    }
    let (_, cert, _) = tlv(der)?;
    let (_, tbs, _) = tlv(cert)?;
    let (tag, _, mut rest) = tlv(tbs)?;
    if tag == 0xA0 {
        rest = tlv(rest)?.2; // explicit version, then serial
    }
    rest = tlv(rest)?.2; // signature algorithm
    rest = tlv(rest)?.2; // issuer
    let (_, validity, _) = tlv(rest)?;
    let (tag, t, _) = tlv(tlv(validity)?.2)?;
    let s = std::str::from_utf8(t).ok()?.strip_suffix('Z')?;
    let (year, s) = match tag {
        0x17 => {
            let yy: i32 = s.get(..2)?.parse().ok()?;
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, s.get(2..)?)
        }
        0x18 => (s.get(..4)?.parse().ok()?, s.get(4..)?),
        _ => return None,
    };
    let n = |i: usize| s.get(i..i + 2)?.parse::<u8>().ok();
    let date =
        time::Date::from_calendar_date(year, time::Month::try_from(n(0)?).ok()?, n(2)?).ok()?;
    let t = time::Time::from_hms(n(4)?, n(6)?, n(8)?).ok()?;
    Some(
        time::PrimitiveDateTime::new(date, t)
            .assume_utc()
            .unix_timestamp(),
    )
}

/// `GET /api/acme`
pub async fn get(State(app): State<Arc<App>>) -> Json<Value> {
    Json(app.acme.view())
}

#[derive(Deserialize)]
pub struct PutBody {
    config: AcmeConfig,
    /// Also start issuing right away.
    #[serde(default)]
    issue: bool,
}

/// `PUT /api/acme` with `{"config":{…},"issue":bool}`
pub async fn put(
    State(app): State<Arc<App>>,
    Json(body): Json<PutBody>,
) -> Result<Json<Value>, ApiError> {
    let acme = &app.acme;
    let old = acme.config.lock().unwrap().clone();
    let cfg = merge(body.config, &old);
    validate(&cfg, body.issue, &acme.http).map_err(ApiError::bad_request)?;
    let path = acme.dir.join("config.json");
    util::write_atomic(
        &path,
        &serde_json::to_vec_pretty(&cfg)
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
    )?;
    *acme.config.lock().unwrap() = cfg;
    if body.issue {
        acme.begin()?;
    }
    Ok(Json(acme.view()))
}

/// `POST /api/acme/issue`
pub async fn issue(State(app): State<Arc<App>>) -> Result<(StatusCode, Json<Value>), ApiError> {
    app.acme.begin()?;
    Ok((StatusCode::ACCEPTED, Json(app.acme.view())))
}

/// `POST /api/acme/account`: registers the ACME account for the saved
/// config (or loads the existing one), so dns-persist-01 records can be set
/// up before the first request.
pub async fn account(State(app): State<Arc<App>>) -> Result<Json<Value>, ApiError> {
    let acme = &app.acme;
    if acme.status.lock().unwrap().running {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "a certificate request is running",
        ));
    }
    let cfg = acme.config.lock().unwrap().clone();
    validate(&cfg, false, &acme.http).map_err(ApiError::bad_request)?;
    if !cfg.eab_kid.is_empty() && cfg.eab_hmac.is_empty() {
        return Err(ApiError::bad_request("the EAB key ID needs its HMAC key"));
    }
    acme.account(&cfg)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(acme.view()))
}

/// `DELETE /api/acme/cert`: stop serving and delete the certificate, and
/// turn off automatic renewal.
pub async fn delete_cert(State(app): State<Arc<App>>) -> Result<Json<Value>, ApiError> {
    let acme = &app.acme;
    if acme.status.lock().unwrap().running {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "a certificate request is running",
        ));
    }
    {
        let mut cfg = acme.config.lock().unwrap();
        cfg.enabled = false;
        util::write_atomic(
            &acme.dir.join("config.json"),
            &serde_json::to_vec_pretty(&*cfg).unwrap_or_default(),
        )?;
    }
    for f in ["cert.json", "cert.pem", "key.pem"] {
        match std::fs::remove_file(acme.dir.join(f)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    if let Some(r) = &acme.resolver {
        r.set_acme(None);
    }
    *acme.cert.lock().unwrap() = None;
    info!("ACME certificate removed");
    Ok(Json(acme.view()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_after() {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut p = rcgen::CertificateParams::new(vec!["a.example.com".into()]).unwrap();
        p.not_after = rcgen::date_time_ymd(2031, 7, 4);
        let c = p.self_signed(&key).unwrap();
        assert_eq!(cert_not_after(c.der()), Some(1940889600));
        p.not_after = rcgen::date_time_ymd(2051, 1, 2); // GeneralizedTime
        let c = p.self_signed(&key).unwrap();
        assert_eq!(cert_not_after(c.der()), Some(2556230400));
    }

    #[test]
    fn domains() {
        assert!(valid_domain("printer.example.com"));
        assert!(valid_domain("*.lan.example.com"));
        assert!(!valid_domain("example"));
        assert!(!valid_domain("192.168.1.5"));
        assert!(!valid_domain("a..com"));
        assert!(!valid_domain("*.*.example.com"));
        assert!(!valid_domain("Upper.example.com"));
    }

    #[test]
    fn secrets_survive_redaction() {
        let mut old = AcmeConfig::default();
        old.dns.insert("api_token".into(), "tok".into());
        old.eab_hmac = "h".into();
        let (red, set) = redact(old.clone());
        assert_eq!(set, ["eab_hmac", "dns.api_token"]);
        let merged = merge(red, &old);
        assert_eq!(dns::get(&merged.dns, "api_token"), "tok");
        assert_eq!(merged.eab_hmac, "h");
    }
}
