//! [acme-dns](https://github.com/joohoi/acme-dns): a tiny DNS server made
//! only for answering challenges. `_acme-challenge.<domain>` is a CNAME to
//! `<subdomain>.<acme-dns zone>`, so the credentials here can't touch any
//! other record.

use axum::http::Method;
use serde_json::json;

use super::{DnsProvider, Field, ProviderInfo, Settings, need};
use crate::http_client::Http;
use crate::util::BoxFut;

pub static PROVIDER: ProviderInfo = ProviderInfo {
    id: "acme-dns",
    label: "acme-dns",
    help: "Point _acme-challenge.<domain> at the account's fulldomain with a CNAME. One account serves up to two names \
           (acme-dns keeps the two newest TXT values), e.g. example.com and *.example.com.",
    fields: &[
        Field::new("server", "Server URL")
            .required()
            .placeholder("https://auth.acme-dns.io"),
        Field::new("username", "Username").required(),
        Field::new("password", "Password").secret().required(),
        Field::new("subdomain", "Subdomain").required(),
    ],
    persistent: false,
    single_value: false,
    build,
};

struct AcmeDns {
    http: Http,
    url: String,
    username: String,
    password: String,
    subdomain: String,
}

fn build(s: &Settings, http: &Http) -> Result<Box<dyn DnsProvider>, String> {
    let server = need(s, "server")?.trim_end_matches('/');
    if !server.starts_with("https://") && !server.starts_with("http://") {
        return Err("server must be an http(s):// URL".into());
    }
    Ok(Box::new(AcmeDns {
        http: http.clone(),
        url: format!("{server}/update"),
        username: need(s, "username")?.to_string(),
        password: need(s, "password")?.to_string(),
        subdomain: need(s, "subdomain")?.to_string(),
    }))
}

impl DnsProvider for AcmeDns {
    fn present<'a>(&'a self, _name: &'a str, value: &'a str) -> BoxFut<'a, Result<String, String>> {
        Box::pin(async move {
            let (status, v) = self
                .http
                .json(
                    Method::POST,
                    &self.url,
                    &[
                        ("x-api-user", &self.username),
                        ("x-api-key", &self.password),
                    ],
                    Some(&json!({ "subdomain": self.subdomain, "txt": value })),
                )
                .await?;
            if !status.is_success() {
                let msg = v["error"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("HTTP {status}"));
                return Err(format!("acme-dns: {msg}"));
            }
            Ok(String::new())
        })
    }

    /// acme-dns replaces values on its own; nothing to remove.
    fn cleanup<'a>(&'a self, _: &'a str, _: &'a str, _: &'a str) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
