//! Login with an OpenID Connect provider (Kanidm, Authelia, Keycloak,
//! authentik, …): the authorization code flow with PKCE.
//!
//! Configured from the UI (`/api/oidc`, behind login), stored in
//! `<state-dir>/oidc.json`. `GET /api/auth/oidc/start` redirects to the
//! provider; it sends the browser back to `GET /api/auth/oidc/callback`,
//! which exchanges the code for an ID token and starts a session.
//!
//! The redirect URI is built from the Host the browser used, so every name
//! the printer is opened by (`https://printer.lan/…`, `https://10.0.0.5/…`)
//! has to be registered with the provider; the settings page shows the one
//! for the current address.
//!
//! The ID token comes straight from the token endpoint over a TLS
//! connection checked against the configured issuer, so its signature is
//! not checked (OpenID Connect Core 3.1.3.7, item 6); its issuer, audience,
//! expiry and nonce are.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use ring::hmac;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::{info, warn};

use super::{AuthProvider, Identity, LoginError};
use crate::App;
use crate::files::ApiError;
use crate::http_client::Http;
use crate::util::{self, BoxFut, now_unix};

/// How long the user has to finish logging in at the provider.
const PENDING_TTL: i64 = 600;
const MAX_PENDING: usize = 64;
const DISCOVERY_TTL: i64 = 3600;
/// Clock skew tolerated on `exp` (the printer's clock may be off).
const LEEWAY: i64 = 300;
pub const CALLBACK_PATH: &str = "/api/auth/oidc/callback";

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct OidcConfig {
    pub enabled: bool,
    /// Shown on the login button ("Sign in with …").
    pub label: String,
    /// e.g. `https://idm.example.com/oauth2/openid/<client id>` for Kanidm.
    pub issuer: String,
    pub client_id: String,
    /// Empty for a public client (PKCE only).
    pub client_secret: String,
    /// Space-separated; `openid` is always added.
    pub scopes: String,
    /// Who may log in: `sub`, `preferred_username` or `email` values, or
    /// entries of the `groups` claim. Empty: anyone the provider lets
    /// through.
    pub allowed: Vec<String>,
}

impl Default for OidcConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            label: String::new(),
            issuer: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            scopes: "openid profile email".into(),
            allowed: Vec::new(),
        }
    }
}

impl OidcConfig {
    fn usable(&self) -> bool {
        self.enabled && !self.issuer.is_empty() && !self.client_id.is_empty()
    }
}

#[derive(Deserialize, Clone)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
}

struct Pending {
    verifier: String,
    nonce: String,
    redirect_uri: String,
    created: i64,
}

pub struct Oidc {
    path: PathBuf,
    config: Mutex<OidcConfig>,
    /// state -> login in progress
    pending: Mutex<HashMap<String, Pending>>,
    /// (issuer it was fetched for, when, document)
    discovery: Mutex<Option<(String, i64, Discovery)>>,
    http: Http,
    key: hmac::Key,
    /// TLS listener: https redirect URI, `__Host-` + `Secure` cookie.
    secure: bool,
}

fn b64url(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

fn random_token() -> String {
    b64url(&util::random_bytes::<32>())
}

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn same_issuer(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

impl Oidc {
    pub fn new(state_dir: &std::path::Path, http: Http, key: hmac::Key, secure: bool) -> Self {
        let path = state_dir.join("oidc.json");
        let config = util::read_opt(&path)
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            config: Mutex::new(config),
            pending: Mutex::new(HashMap::new()),
            discovery: Mutex::new(None),
            http,
            key,
            secure,
        }
    }

    fn cookie_name(&self) -> &'static str {
        if self.secure {
            "__Host-orcax1_oidc"
        } else {
            "orcax1_oidc"
        }
    }

    /// Ties the login to the browser that started it. `Lax`, unlike the
    /// session cookie, so it comes along on the provider's redirect back.
    fn state_cookie(&self, value: &str, max_age: i64) -> HeaderValue {
        let secure = if self.secure { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}",
            self.cookie_name()
        ))
        .expect("cookie is ASCII")
    }

    fn cookie_value<'h>(&self, headers: &'h HeaderMap) -> Option<&'h str> {
        let name = self.cookie_name();
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|kv| kv.trim().split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v)
    }

    async fn discover(&self, issuer: &str) -> Result<Discovery, String> {
        let now = now_unix();
        if let Some((iss, at, d)) = &*self.discovery.lock().unwrap()
            && iss == issuer
            && now - at < DISCOVERY_TTL
        {
            return Ok(d.clone());
        }
        let url = format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        );
        let (status, body) = self
            .http
            .json(axum::http::Method::GET, &url, &[], None)
            .await?;
        if !status.is_success() {
            return Err(format!("{url}: HTTP {status}"));
        }
        let d: Discovery = serde_json::from_value(body)
            .map_err(|e| format!("{url}: not a discovery document ({e})"))?;
        if !same_issuer(&d.issuer, issuer) {
            return Err(format!(
                "the provider calls itself {:?}, not {issuer:?}; use that as the issuer",
                d.issuer
            ));
        }
        for u in [&d.authorization_endpoint, &d.token_endpoint] {
            if !u.starts_with("https://") {
                return Err(format!("{u}: provider endpoints must use https"));
            }
        }
        *self.discovery.lock().unwrap() = Some((issuer.to_string(), now, d.clone()));
        Ok(d)
    }

    fn view(&self, available: bool) -> Value {
        let mut cfg = self.config.lock().unwrap().clone();
        let secret_set = !cfg.client_secret.is_empty();
        cfg.client_secret.clear();
        json!({
            "config": cfg,
            "secret_set": secret_set,
            "available": available,
            "callback_path": CALLBACK_PATH,
        })
    }

    /// The URL the provider should send the browser back to, for a request
    /// that came in with these headers.
    fn redirect_uri(&self, headers: &HeaderMap) -> Result<String, String> {
        let host = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .filter(|h| {
                !h.is_empty()
                    && h.chars()
                        .all(|c| c.is_ascii_alphanumeric() || ".-:[]".contains(c))
            })
            .ok_or("request has no usable Host header")?;
        let scheme = if self.secure { "https" } else { "http" };
        Ok(format!("{scheme}://{host}{CALLBACK_PATH}"))
    }

    async fn begin(&self, headers: &HeaderMap) -> Result<(String, String), String> {
        let cfg = self.config.lock().unwrap().clone();
        if !cfg.usable() {
            return Err("OpenID Connect login is not set up".into());
        }
        let d = self.discover(&cfg.issuer).await?;
        let redirect_uri = self.redirect_uri(headers)?;
        let state = random_token();
        let nonce = random_token();
        let verifier = random_token();
        let challenge =
            b64url(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()).as_ref());
        let url = format!(
            "{}{}response_type=code&client_id={}&redirect_uri={}&scope={}&state={state}&nonce={nonce}&code_challenge={challenge}&code_challenge_method=S256",
            d.authorization_endpoint,
            if d.authorization_endpoint.contains('?') {
                '&'
            } else {
                '?'
            },
            enc(&cfg.client_id),
            enc(&redirect_uri),
            enc(&scopes(&cfg.scopes)),
        );
        let now = now_unix();
        let mut p = self.pending.lock().unwrap();
        p.retain(|_, v| now - v.created < PENDING_TTL);
        while p.len() >= MAX_PENDING {
            let oldest = p
                .iter()
                .min_by_key(|(_, v)| v.created)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => p.remove(&k),
                None => break,
            };
        }
        p.insert(
            state.clone(),
            Pending {
                verifier,
                nonce,
                redirect_uri,
                created: now,
            },
        );
        Ok((url, state))
    }

    async fn finish(&self, q: &CallbackQuery, headers: &HeaderMap) -> Result<Identity, String> {
        if let Some(e) = &q.error {
            return Err(match &q.error_description {
                Some(d) => format!("{e}: {d}"),
                None => e.clone(),
            });
        }
        let (Some(code), Some(state)) = (&q.code, &q.state) else {
            return Err("the provider sent no authorization code".into());
        };
        if self.cookie_value(headers) != Some(state.as_str()) {
            return Err("login was started in another browser or tab; try again".into());
        }
        let pending = self
            .pending
            .lock()
            .unwrap()
            .remove(state)
            .filter(|p| now_unix() - p.created < PENDING_TTL)
            .ok_or("login took too long or was already used; try again")?;
        let cfg = self.config.lock().unwrap().clone();
        if !cfg.usable() {
            return Err("OpenID Connect login is not set up".into());
        }
        let d = self.discover(&cfg.issuer).await?;

        let mut fields = vec![
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", pending.redirect_uri.as_str()),
            ("code_verifier", pending.verifier.as_str()),
        ];
        let basic;
        let mut hdrs: Vec<(&str, &str)> = Vec::new();
        let methods = &d.token_endpoint_auth_methods_supported;
        if cfg.client_secret.is_empty() {
            fields.push(("client_id", &cfg.client_id));
        } else if methods.is_empty() || methods.iter().any(|m| m == "client_secret_basic") {
            basic = format!(
                "Basic {}",
                STANDARD.encode(format!(
                    "{}:{}",
                    enc(&cfg.client_id),
                    enc(&cfg.client_secret)
                ))
            );
            hdrs.push(("authorization", &basic));
        } else {
            fields.push(("client_id", &cfg.client_id));
            fields.push(("client_secret", &cfg.client_secret));
        }
        hdrs.push(("accept", "application/json"));
        let (status, body) = self.http.form(&d.token_endpoint, &hdrs, &fields).await?;
        let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if !status.is_success() {
            let e = body.get("error").and_then(Value::as_str).unwrap_or("");
            let desc = body
                .get("error_description")
                .and_then(Value::as_str)
                .unwrap_or("");
            return Err(format!("token request failed: HTTP {status} {e} {desc}")
                .trim()
                .to_string());
        }
        let id_token = body
            .get("id_token")
            .and_then(Value::as_str)
            .ok_or("the token response has no id_token (is the openid scope allowed?)")?;
        let claims = decode_jwt_payload(id_token)?;
        check_claims(&claims, &d.issuer, &cfg.client_id, &pending.nonce)?;

        let s = |k: &str| {
            claims
                .get(k)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
        };
        let sub = s("sub").ok_or("the ID token has no sub")?.to_string();
        let name = s("preferred_username")
            .or(s("name"))
            .or(s("email"))
            .unwrap_or(&sub)
            .to_string();
        if !cfg.allowed.is_empty() {
            let mut ids: Vec<&str> = vec![&sub];
            ids.extend(s("preferred_username"));
            if claims.get("email_verified") != Some(&Value::Bool(false)) {
                ids.extend(s("email"));
            }
            if let Some(Value::Array(g)) = claims.get("groups") {
                ids.extend(g.iter().filter_map(Value::as_str));
            }
            let ok = cfg
                .allowed
                .iter()
                .any(|a| ids.iter().any(|i| i.eq_ignore_ascii_case(a)));
            if !ok {
                return Err(format!("{name} is not allowed to use this printer"));
            }
        }
        Ok(Identity { subject: sub, name })
    }
}

fn scopes(s: &str) -> String {
    let mut v: Vec<&str> = vec!["openid"];
    for x in s.split_whitespace() {
        if !v.contains(&x) {
            v.push(x);
        }
    }
    v.join(" ")
}

fn decode_jwt_payload(jwt: &str) -> Result<Value, String> {
    let payload = jwt.split('.').nth(1).ok_or("the id_token is not a JWT")?;
    let raw = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|e| format!("id_token: {e}"))?;
    serde_json::from_slice(&raw).map_err(|e| format!("id_token: {e}"))
}

fn check_claims(c: &Value, issuer: &str, client_id: &str, nonce: &str) -> Result<(), String> {
    let iss = c.get("iss").and_then(Value::as_str).unwrap_or("");
    if iss != issuer {
        return Err(format!("ID token issuer {iss:?} is not {issuer:?}"));
    }
    let aud_ok = match c.get("aud") {
        Some(Value::String(a)) => a == client_id,
        Some(Value::Array(a)) => {
            a.iter().any(|x| x.as_str() == Some(client_id))
                && (a.len() == 1
                    || c.get("azp")
                        .and_then(Value::as_str)
                        .is_none_or(|z| z == client_id))
        }
        _ => false,
    };
    if !aud_ok {
        return Err("the ID token is for a different client".into());
    }
    let exp = c
        .get("exp")
        .and_then(Value::as_i64)
        .ok_or("the ID token has no exp")?;
    if exp + LEEWAY < now_unix() {
        return Err("the ID token has expired (is the printer's clock right?)".into());
    }
    if c.get("nonce").and_then(Value::as_str) != Some(nonce) {
        return Err("the ID token's nonce does not match".into());
    }
    Ok(())
}

impl AuthProvider for Oidc {
    fn id(&self) -> &'static str {
        "oidc"
    }

    fn active(&self) -> bool {
        self.config.lock().unwrap().usable()
    }

    fn ui(&self) -> Value {
        let cfg = self.config.lock().unwrap();
        let label = if cfg.label.trim().is_empty() {
            "single sign-on"
        } else {
            cfg.label.trim()
        };
        json!({ "kind": "redirect", "label": label, "url": "api/auth/oidc/start" })
    }

    fn login<'a>(&'a self, _form: &'a Value) -> BoxFut<'a, Result<Identity, LoginError>> {
        Box::pin(async {
            Err(LoginError::Denied(
                "this provider logs in by redirect (GET /api/auth/oidc/start)".into(),
            ))
        })
    }

    /// Sessions end when the provider, client or allow list changes.
    fn binding(&self) -> Option<String> {
        let cfg = self.config.lock().unwrap();
        let mut m = cfg.issuer.trim_end_matches('/').to_string();
        for s in [&cfg.client_id].into_iter().chain(&cfg.allowed) {
            m.push('\0');
            m.push_str(s);
        }
        Some(crate::tls::hex(
            hmac::sign(&self.key, m.as_bytes()).as_ref(),
        ))
    }
}

/// Where to send the browser after a failed login: the UI shows the error.
fn back_with_error(msg: &str) -> Response {
    let loc = format!("/?login_error={}", enc(msg));
    (
        StatusCode::SEE_OTHER,
        [(
            header::LOCATION,
            HeaderValue::from_str(&loc).expect("encoded"),
        )],
    )
        .into_response()
}

/// The provider, if `--auth` includes it.
fn oidc(app: &App) -> Option<Arc<Oidc>> {
    app.auth
        .provider("oidc")
        .is_some()
        .then(|| app.oidc.clone())
}

/// `GET /api/auth/oidc/start`: redirects to the provider.
pub async fn start(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let Some(o) = oidc(&app) else {
        return back_with_error("OpenID Connect login is not enabled");
    };
    match o.begin(&headers).await {
        Ok((url, state)) => {
            let Ok(loc) = HeaderValue::from_str(&url) else {
                return back_with_error("the provider's authorization URL is invalid");
            };
            (
                StatusCode::SEE_OTHER,
                [
                    (header::LOCATION, loc),
                    (header::SET_COOKIE, o.state_cookie(&state, PENDING_TTL)),
                    (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
                ],
            )
                .into_response()
        }
        Err(e) => {
            warn!("oidc: {e}");
            back_with_error(&e)
        }
    }
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// `GET /api/auth/oidc/callback`: the provider's redirect back.
pub async fn callback(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Response {
    let Some(o) = oidc(&app) else {
        return back_with_error("OpenID Connect login is not enabled");
    };
    let mut res = match o.finish(&q, &headers).await {
        Ok(identity) => {
            info!(provider = "oidc", user = %identity.name, sub = %identity.subject, "login");
            let (_, cookie) = app.auth.start_session(o.as_ref(), identity);
            let mut res = (
                StatusCode::SEE_OTHER,
                [(header::LOCATION, HeaderValue::from_static("/"))],
            )
                .into_response();
            res.headers_mut().append(header::SET_COOKIE, cookie);
            res
        }
        Err(e) => {
            warn!("oidc login failed: {e}");
            back_with_error(&e)
        }
    };
    let h = res.headers_mut();
    h.append(header::SET_COOKIE, o.state_cookie("", 0));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET /api/oidc`: the settings (client secret redacted).
pub async fn get(State(app): State<Arc<App>>) -> Json<Value> {
    Json(app.oidc.view(oidc(&app).is_some()))
}

/// `PUT /api/oidc` with the config; an empty `client_secret` keeps the
/// saved one unless `clear_secret` is set.
pub async fn put(
    State(app): State<Arc<App>>,
    Json(body): Json<PutBody>,
) -> Result<Json<Value>, ApiError> {
    let o = &app.oidc;
    let mut cfg = body.config;
    cfg.label = cfg.label.trim().to_string();
    cfg.issuer = cfg.issuer.trim().to_string();
    cfg.client_id = cfg.client_id.trim().to_string();
    cfg.client_secret = cfg.client_secret.trim().to_string();
    cfg.scopes = scopes(&cfg.scopes);
    cfg.allowed = cfg
        .allowed
        .iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect();
    if cfg.client_secret.is_empty() && !body.clear_secret {
        cfg.client_secret = o.config.lock().unwrap().client_secret.clone();
    }
    if !cfg.issuer.is_empty() && !cfg.issuer.starts_with("https://") {
        return Err(ApiError::bad_request("the issuer must be an https:// URL"));
    }
    if cfg.enabled {
        if cfg.issuer.is_empty() || cfg.client_id.is_empty() {
            return Err(ApiError::bad_request("issuer and client ID are required"));
        }
        // Catch typos now rather than at the next login.
        *o.discovery.lock().unwrap() = None;
        o.discover(&cfg.issuer)
            .await
            .map_err(ApiError::bad_request)?;
    }
    util::write_atomic(
        &o.path,
        &serde_json::to_vec_pretty(&cfg)
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
    )?;
    *o.config.lock().unwrap() = cfg;
    Ok(Json(o.view(oidc(&app).is_some())))
}

#[derive(Deserialize)]
pub struct PutBody {
    config: OidcConfig,
    #[serde(default)]
    clear_secret: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims() {
        let now = now_unix();
        let ok = json!({"iss":"https://i/x","aud":"c","exp":now+60,"nonce":"n","sub":"u"});
        assert!(check_claims(&ok, "https://i/x", "c", "n").is_ok());
        assert!(check_claims(&ok, "https://i/y", "c", "n").is_err());
        assert!(check_claims(&ok, "https://i/x", "d", "n").is_err());
        assert!(check_claims(&ok, "https://i/x", "c", "m").is_err());
        let old = json!({"iss":"https://i/x","aud":["c"],"exp":now-LEEWAY-10,"nonce":"n"});
        assert!(check_claims(&old, "https://i/x", "c", "n").is_err());
        let multi = json!({"iss":"https://i/x","aud":["c","e"],"azp":"e","exp":now+60,"nonce":"n"});
        assert!(check_claims(&multi, "https://i/x", "c", "n").is_err());
    }

    #[test]
    fn jwt_payload() {
        let p = b64url(br#"{"sub":"x"}"#);
        let v = decode_jwt_payload(&format!("e30.{p}.sig")).unwrap();
        assert_eq!(v["sub"], "x");
        assert!(decode_jwt_payload("nodots").is_err());
    }

    #[test]
    fn scope_list() {
        assert_eq!(scopes("profile  openid groups"), "openid profile groups");
        assert_eq!(scopes(""), "openid");
    }
}
