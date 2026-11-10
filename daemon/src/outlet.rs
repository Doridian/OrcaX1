//! The printer's power outlet, through an ESPHome device running the
//! `orcax1_outlet` component (deploy/esphome, docs/OUTLET.md).
//!
//! The browser goes through here while the printer is on, so it needs no
//! access to the device itself (an HTTPS page can't reach a plain-HTTP device
//! in every browser) and turning the printer off needs a login: the device
//! only turns it off for requests carrying the token, which is kept here and
//! never sent to the browser. While the printer is off, the UI's service
//! worker sends the browser to the device's own page, which can only switch
//! it on.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderValue, Method, Request, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::App;
use crate::files::ApiError;
use crate::util;

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct OutletConfig {
    /// `http://host[:port]` of the ESPHome device; empty: no outlet.
    #[serde(default)]
    pub url: String,
    /// The device's `off_token`; empty: can't switch off.
    #[serde(default)]
    pub token: String,
}

pub struct Outlet {
    path: PathBuf,
    config: Mutex<OutletConfig>,
    client: Client<HttpConnector, Full<Bytes>>,
}

impl Outlet {
    pub fn new(state_dir: &std::path::Path) -> Self {
        let path = state_dir.join("outlet.json");
        let config = util::read_opt(&path)
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut conn = HttpConnector::new();
        conn.set_connect_timeout(Some(TIMEOUT));
        Self {
            path,
            config: Mutex::new(config),
            client: Client::builder(TokioExecutor::new()).build(conn),
        }
    }

    fn config(&self) -> OutletConfig {
        self.config.lock().unwrap().clone()
    }

    fn view(&self) -> Value {
        let c = self.config.lock().unwrap();
        json!({ "url": c.url, "token_set": !c.token.is_empty() })
    }

    /// Calls the device; returns its status and JSON body.
    async fn call(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
    ) -> Result<(StatusCode, Value), ApiError> {
        let c = self.config();
        if c.url.is_empty() {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "no outlet configured"));
        }
        let mut req = Request::builder()
            .method(method)
            .uri(format!("{}{path}", c.url))
            .header(header::ACCEPT, "application/json");
        if let Some(t) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        let req = req
            .body(Full::new(Bytes::new()))
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let unreachable = |e: String| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("outlet device {}: {e}", c.url),
            )
        };
        let res = tokio::time::timeout(TIMEOUT, async {
            let res = self.client.request(req).await.map_err(|e| e.to_string())?;
            let status = res.status();
            let body = res
                .into_body()
                .collect()
                .await
                .map_err(|e| e.to_string())?
                .to_bytes();
            Ok::<_, String>((status, body))
        })
        .await
        .map_err(|_| unreachable("timed out".into()))?
        .map_err(unreachable)?;
        let (status, body) = res;
        let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if status == StatusCode::NOT_FOUND {
            return Err(unreachable(
                "no /orcax1 endpoint (is the orcax1_outlet component on it?)".into(),
            ));
        }
        Ok((status, body))
    }
}

/// `http://host[:port]` with nothing after it, or an error.
fn normalize_url(s: &str) -> Result<String, String> {
    let s = s.trim().trim_end_matches('/');
    if s.is_empty() {
        return Ok(String::new());
    }
    let s = if s.contains("://") {
        s.to_string()
    } else {
        format!("http://{s}")
    };
    let uri: Uri = s.parse().map_err(|_| format!("not a URL: {s}"))?;
    if uri.scheme_str() != Some("http") {
        return Err("the outlet device is plain HTTP: use an http:// address".into());
    }
    let Some(auth) = uri.authority() else {
        return Err(format!("not a URL: {s}"));
    };
    if auth.as_str().contains('@') || uri.path_and_query().is_some_and(|p| p.as_str() != "/") {
        return Err("give only the device's address, like http://192.168.1.60".into());
    }
    Ok(format!("http://{}", auth.as_str().to_ascii_lowercase()))
}

/// `GET /api/outlet`: the settings (token redacted).
pub async fn get(State(app): State<Arc<App>>) -> Json<Value> {
    Json(app.outlet.view())
}

#[derive(Deserialize)]
pub struct PutBody {
    #[serde(default)]
    url: String,
    /// Empty: keep the saved token (only for the same device).
    #[serde(default)]
    token: String,
    #[serde(default)]
    clear_token: bool,
}

/// `PUT /api/outlet`
pub async fn put(
    State(app): State<Arc<App>>,
    Json(body): Json<PutBody>,
) -> Result<Json<Value>, ApiError> {
    let o = &app.outlet;
    let url = normalize_url(&body.url).map_err(ApiError::bad_request)?;
    let mut token = body.token.trim().to_string();
    if token.is_empty() && !body.clear_token {
        // Never hand the token to another device than it was entered for.
        let old = o.config.lock().unwrap();
        if old.url == url {
            token = old.token.clone();
        }
    }
    let cfg = OutletConfig { url, token };
    util::write_atomic(
        &o.path,
        &serde_json::to_vec_pretty(&cfg)
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
    )?;
    *o.config.lock().unwrap() = cfg;
    Ok(Json(o.view()))
}

/// `GET /api/outlet/state`: the device's `/orcax1/state`.
pub async fn state(State(app): State<Arc<App>>) -> Result<Response, ApiError> {
    let (status, body) = app.outlet.call(Method::GET, "/orcax1/state", None).await?;
    if !status.is_success() {
        return Err(device_error(status, &body));
    }
    Ok(no_store(Json(body).into_response()))
}

#[derive(Deserialize)]
pub struct SwitchBody {
    on: bool,
}

/// `POST /api/outlet/switch` with `{"on": bool}`. Accepted is not done: the
/// outlet's state changes when it reports back.
pub async fn switch(
    State(app): State<Arc<App>>,
    Json(body): Json<SwitchBody>,
) -> Result<Response, ApiError> {
    let o = &app.outlet;
    let token = o.config().token;
    let (status, res) = if body.on {
        o.call(Method::POST, "/orcax1/on", None).await?
    } else {
        if token.is_empty() {
            return Err(ApiError::bad_request(
                "no off token saved: enter the device's off_token under Settings → Printer outlet",
            ));
        }
        o.call(Method::POST, "/orcax1/off", Some(&token)).await?
    };
    if !status.is_success() {
        return Err(device_error(status, &res));
    }
    Ok(no_store(Json(res).into_response()))
}

fn device_error(status: StatusCode, body: &Value) -> ApiError {
    let msg = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("request failed");
    let msg = if status == StatusCode::UNAUTHORIZED {
        "the outlet device refused the off token: it must match the device's off_token".to_string()
    } else {
        format!("outlet device: {msg} ({status})")
    };
    ApiError::new(StatusCode::BAD_GATEWAY, msg)
}

fn no_store(mut res: Response) -> Response {
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET /api/alive`: no login, any origin. The outlet device's page polls it
/// to tell when the printer is up, from its own (http://) origin.
pub async fn alive() -> Response {
    let mut res = StatusCode::NO_CONTENT.into_response();
    let h = res.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    h.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("cross-origin"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(normalize_url("").unwrap(), "");
        assert_eq!(
            normalize_url(" 192.168.1.60/ ").unwrap(),
            "http://192.168.1.60"
        );
        assert_eq!(
            normalize_url("http://Outlet.local:8080").unwrap(),
            "http://outlet.local:8080"
        );
        assert!(normalize_url("https://192.168.1.60").is_err());
        assert!(normalize_url("http://192.168.1.60/orcax1").is_err());
        assert!(normalize_url("http://user:pw@192.168.1.60").is_err());
    }
}
