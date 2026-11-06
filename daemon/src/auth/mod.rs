//! Authentication: pluggable login providers and cookie sessions.
//!
//! A provider turns some proof (a form the UI renders from `ui()`) into an
//! [`Identity`]; this module turns identities into sessions. Providers:
//! the LAN access code (a form POSTed to `/api/auth/login`) and OpenID
//! Connect (a redirect provider with its own start/callback routes that
//! calls [`Auth::start_session`] from the callback).
//!
//! Sessions are opaque random tokens in an HttpOnly, SameSite=Strict cookie.
//! Only their SHA-256 is kept (in memory and in `<state-dir>/sessions.json`,
//! so logins survive restarts).

pub mod access_code;
pub mod oidc;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::{info, warn};

use crate::App;
use crate::files::ApiError;
use crate::util::{self, BoxFut};

/// Who logged in, as established by a provider.
pub struct Identity {
    /// Stable id within the provider (e.g. an OIDC `sub`).
    pub subject: String,
    /// Shown in the UI.
    pub name: String,
}

pub trait AuthProvider: Send + Sync {
    /// Short machine name, e.g. `access-code`. Stored in sessions.
    fn id(&self) -> &'static str;
    /// How the UI should offer this provider:
    /// `{"kind":"secret","label":…,"field":…,"hint":…}` renders a one-field
    /// form whose value is POSTed as `secret`. A redirect provider would use
    /// `{"kind":"redirect","label":…,"url":…}`.
    fn ui(&self) -> Value;
    /// Whether the provider is set up. Inactive providers are not offered
    /// and their sessions are not accepted.
    fn active(&self) -> bool {
        true
    }
    /// Checks a login form (the JSON body of `POST /api/auth/login`).
    fn login<'a>(&'a self, form: &'a Value) -> BoxFut<'a, Result<Identity, LoginError>>;
    /// A value tied to the credential the session was created with. When it
    /// changes (e.g. the access code was regenerated on the printer), the
    /// provider's existing sessions stop working. `None` never invalidates.
    fn binding(&self) -> Option<String> {
        None
    }
}

pub enum LoginError {
    /// Wrong credentials.
    Denied(String),
    /// The provider can't check credentials right now.
    Unavailable(String),
}

/// Builds the providers named on the command line.
pub fn providers(
    names: &[String],
    cfg: &Arc<crate::config::Config>,
    key: &ring::hmac::Key,
    oidc: &Arc<oidc::Oidc>,
) -> Result<Vec<Arc<dyn AuthProvider>>, String> {
    let mut out: Vec<Arc<dyn AuthProvider>> = Vec::new();
    for n in names {
        match n.trim() {
            "none" => return Ok(Vec::new()),
            "access-code" => out.push(Arc::new(access_code::AccessCode::new(
                cfg.clone(),
                key.clone(),
            ))),
            "oidc" => out.push(oidc.clone()),
            other => {
                return Err(format!(
                    "unknown auth provider {other:?} (known: access-code, oidc, none)"
                ));
            }
        }
    }
    if out.is_empty() {
        return Err("no auth providers configured (use --auth none to disable auth)".into());
    }
    Ok(out)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Session {
    pub provider: String,
    pub subject: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<String>,
    pub created: i64,
    pub expires: i64,
}

const MAX_SESSIONS: usize = 64;

pub struct Auth {
    providers: Vec<Arc<dyn AuthProvider>>,
    /// sha256(token) hex -> session
    sessions: Mutex<HashMap<String, Session>>,
    path: PathBuf,
    ttl_secs: i64,
    secure_cookie: bool,
}

/// Per-install secret for HMACs over credentials (session bindings), kept
/// in the state dir.
pub fn load_key(state_dir: &std::path::Path) -> std::io::Result<ring::hmac::Key> {
    let p = state_dir.join("auth.key");
    let raw = match util::read_opt(&p)? {
        Some(k) if k.len() == 32 => k,
        _ => {
            let k = util::random_bytes::<32>().to_vec();
            util::write_atomic(&p, &k)?;
            k
        }
    };
    Ok(ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &raw))
}

impl Auth {
    pub fn new(
        providers: Vec<Arc<dyn AuthProvider>>,
        state_dir: &std::path::Path,
        ttl_days: u32,
        secure_cookie: bool,
    ) -> Self {
        let path = state_dir.join("sessions.json");
        let mut sessions: HashMap<String, Session> = util::read_opt(&path)
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let now = util::now_unix();
        sessions.retain(|_, s| s.expires > now);
        Self {
            providers,
            sessions: Mutex::new(sessions),
            path,
            ttl_secs: i64::from(ttl_days.max(1)) * 86400,
            secure_cookie,
        }
    }

    pub fn enabled(&self) -> bool {
        !self.providers.is_empty()
    }

    /// A provider named in `--auth`, whether or not it is set up.
    pub fn provider(&self, id: &str) -> Option<&Arc<dyn AuthProvider>> {
        self.providers.iter().find(|p| p.id() == id)
    }

    fn cookie_name(&self) -> &'static str {
        // __Host- pins the cookie to this origin's host, path / and HTTPS.
        if self.secure_cookie {
            "__Host-orcax1_session"
        } else {
            "orcax1_session"
        }
    }

    fn persist(&self, sessions: &HashMap<String, Session>) {
        let data = serde_json::to_vec(sessions).unwrap_or_default();
        if let Err(e) = util::write_atomic(&self.path, &data) {
            warn!("saving {}: {e}", self.path.display());
        }
    }

    /// Creates a session for `identity`; returns it and its Set-Cookie value.
    pub fn start_session(
        &self,
        provider: &dyn AuthProvider,
        identity: Identity,
    ) -> (Session, HeaderValue) {
        let token = crate::tls::hex(&util::random_bytes::<32>());
        let now = util::now_unix();
        let s = Session {
            provider: provider.id().to_string(),
            subject: identity.subject,
            name: identity.name,
            binding: provider.binding(),
            created: now,
            expires: now + self.ttl_secs,
        };
        let mut map = self.sessions.lock().unwrap();
        map.retain(|_, s| s.expires > now);
        while map.len() >= MAX_SESSIONS {
            let oldest = map
                .iter()
                .min_by_key(|(_, s)| s.created)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => map.remove(&k),
                None => break,
            };
        }
        map.insert(util::sha256_hex(token.as_bytes()), s.clone());
        self.persist(&map);
        (s, self.cookie(&token, self.ttl_secs))
    }

    fn cookie(&self, value: &str, max_age: i64) -> HeaderValue {
        let secure = if self.secure_cookie { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}",
            self.cookie_name()
        ))
        .expect("cookie is ASCII")
    }

    fn token<'h>(&self, headers: &'h HeaderMap) -> Option<&'h str> {
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

    /// The valid session for this request, if any.
    pub fn session(&self, headers: &HeaderMap) -> Option<Session> {
        let token = self.token(headers)?;
        let key = util::sha256_hex(token.as_bytes());
        let mut map = self.sessions.lock().unwrap();
        let s = map.get(&key)?;
        if s.expires <= util::now_unix() {
            map.remove(&key);
            self.persist(&map);
            return None;
        }
        let s = s.clone();
        drop(map);
        // Rejected, not deleted: a credential that is briefly unreadable
        // shouldn't log everyone out for good.
        self.provider(&s.provider)
            .is_some_and(|p| p.active() && p.binding() == s.binding)
            .then_some(s)
    }

    fn end_session(&self, headers: &HeaderMap) {
        if let Some(token) = self.token(headers) {
            let mut map = self.sessions.lock().unwrap();
            if map.remove(&util::sha256_hex(token.as_bytes())).is_some() {
                self.persist(&map);
            }
        }
    }

    fn status_json(&self, session: Option<&Session>) -> Value {
        json!({
            "enabled": self.enabled(),
            "authenticated": !self.enabled() || session.is_some(),
            "user": session.map(|s| json!({ "provider": s.provider, "name": s.name, "expires": s.expires })),
            "providers": self.providers.iter().filter(|p| p.active()).map(|p| {
                let mut ui = p.ui();
                ui["id"] = json!(p.id());
                ui
            }).collect::<Vec<_>>(),
        })
    }
}

/// Middleware for everything under /api except the auth endpoints.
pub async fn require(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    if !app.auth.enabled() || app.auth.session(req.headers()).is_some() {
        return next.run(req).await;
    }
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in").into_response()
}

/// `GET /api/auth/status`
pub async fn status(State(app): State<Arc<App>>, headers: HeaderMap) -> Json<Value> {
    Json(app.auth.status_json(app.auth.session(&headers).as_ref()))
}

/// `POST /api/auth/login` with `{"provider":"…", …provider fields}`.
pub async fn login(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(form): Json<Value>,
) -> Result<Response, ApiError> {
    let auth = &app.auth;
    if !auth.enabled() {
        return Err(ApiError::bad_request("authentication is disabled"));
    }
    let id = form.get("provider").and_then(Value::as_str).unwrap_or("");
    let provider = auth
        .provider(id)
        .filter(|p| p.active())
        .ok_or_else(|| ApiError::bad_request(format!("unknown provider {id:?}")))?
        .clone();
    let ip = peer.ip().to_canonical();
    match provider.login(&form).await {
        Ok(identity) => {
            info!(%ip, provider = id, user = %identity.name, "login");
            let (session, cookie) = auth.start_session(provider.as_ref(), identity);
            Ok((
                [(header::SET_COOKIE, cookie)],
                Json(auth.status_json(Some(&session))),
            )
                .into_response())
        }
        Err(LoginError::Denied(msg)) => {
            warn!(%ip, provider = id, "login failed: {msg}");
            // A token slowdown; the access code guards the printer's own
            // MQTT/FTPS/RTSPS services without any throttling anyway.
            tokio::time::sleep(Duration::from_secs(1)).await;
            Err(ApiError::new(StatusCode::UNAUTHORIZED, msg))
        }
        Err(LoginError::Unavailable(msg)) => {
            Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, msg))
        }
    }
}

/// `POST /api/auth/logout`
pub async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    app.auth.end_session(&headers);
    (
        [(header::SET_COOKIE, app.auth.cookie("", 0))],
        Json(app.auth.status_json(None)),
    )
        .into_response()
}
