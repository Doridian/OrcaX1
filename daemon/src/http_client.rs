//! Outbound HTTPS client (ACME directory, DNS provider APIs). Trusts the
//! bundled Mozilla roots (webpki-roots), since the printer has no usable
//! system CA store.

use std::time::Duration;

use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use instant_acme::{BodyWrapper, BytesResponse};
use serde_json::Value;

use crate::util::BoxFut;

const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Http(Client<HttpsConnector<HttpConnector>, BodyWrapper<Bytes>>);

impl Http {
    /// `extra_roots`: PEM CA certificates trusted on top of webpki-roots.
    pub fn new(extra_roots: Option<&std::path::Path>) -> std::io::Result<Self> {
        let mut roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        if let Some(p) = extra_roots {
            use rustls::pki_types::{CertificateDer, pem::PemObject};
            for c in CertificateDer::pem_file_iter(p).map_err(std::io::Error::other)? {
                roots
                    .add(c.map_err(std::io::Error::other)?)
                    .map_err(std::io::Error::other)?;
            }
        }
        let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("ring supports default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
        let conn = hyper_rustls::HttpsConnectorBuilder::new()
            .with_tls_config(tls)
            .https_or_http()
            .enable_http1()
            .build();
        Ok(Self(Client::builder(TokioExecutor::new()).build(conn)))
    }

    /// Sends a request with an optional JSON body and returns the status and
    /// the response body parsed as JSON (Null if empty or not JSON).
    pub async fn json(
        &self,
        method: Method,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<(StatusCode, Value), String> {
        let body = match body {
            Some(b) => Some((
                "application/json",
                serde_json::to_vec(b).map_err(|e| e.to_string())?,
            )),
            None => None,
        };
        let (status, bytes) = self
            .send(method, url, "application/json", headers, body)
            .await?;
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        ))
    }

    /// POSTs `fields` as `application/x-www-form-urlencoded` and returns the
    /// status and the response body as text.
    pub async fn form(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        fields: &[(&str, &str)],
    ) -> Result<(StatusCode, String), String> {
        use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
        let body = fields
            .iter()
            .map(|(k, v)| {
                format!(
                    "{}={}",
                    utf8_percent_encode(k, NON_ALPHANUMERIC),
                    utf8_percent_encode(v, NON_ALPHANUMERIC)
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        let (status, bytes) = self
            .send(
                Method::POST,
                url,
                "text/plain, */*",
                headers,
                Some(("application/x-www-form-urlencoded", body.into_bytes())),
            )
            .await?;
        Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// Sends a request with an optional `(content type, body)`.
    async fn send(
        &self,
        method: Method,
        url: &str,
        accept: &str,
        headers: &[(&str, &str)],
        body: Option<(&str, Vec<u8>)>,
    ) -> Result<(StatusCode, Bytes), String> {
        let mut req = Request::builder()
            .method(method)
            .uri(url)
            .header(header::ACCEPT, accept)
            .header(
                header::USER_AGENT,
                concat!("orcax1d/", env!("CARGO_PKG_VERSION")),
            );
        for (k, v) in headers {
            let v = HeaderValue::from_str(v).map_err(|_| format!("invalid {k} header value"))?;
            req = req.header(*k, v);
        }
        let body = match body {
            Some((ct, b)) => {
                req = req.header(header::CONTENT_TYPE, ct);
                BodyWrapper::from(b)
            }
            None => BodyWrapper::default(),
        };
        let req = req.body(body).map_err(|e| format!("{url}: {e}"))?;
        let fut = async {
            let res = self
                .0
                .request(req)
                .await
                .map_err(|e| format!("{url}: {e:#}"))?;
            let status = res.status();
            let bytes = res
                .into_body()
                .collect()
                .await
                .map_err(|e| format!("{url}: {e}"))?
                .to_bytes();
            Ok((status, bytes))
        };
        tokio::time::timeout(TIMEOUT, fut)
            .await
            .map_err(|_| format!("{url}: timed out"))?
    }
}

impl instant_acme::HttpClient for Http {
    fn request(
        &self,
        req: Request<BodyWrapper<Bytes>>,
    ) -> BoxFut<'static, Result<BytesResponse, instant_acme::Error>> {
        let fut = self.0.request(req);
        Box::pin(async move {
            match tokio::time::timeout(TIMEOUT, fut).await {
                Ok(Ok(res)) => Ok(BytesResponse::from(res)),
                Ok(Err(e)) => Err(instant_acme::Error::Other(Box::new(e))),
                Err(_) => Err(instant_acme::Error::Other("ACME request timed out".into())),
            }
        })
    }
}
