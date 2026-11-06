//! Cloudflare DNS via its v4 API and an API token.

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};

use super::{DnsProvider, Field, ProviderInfo, Settings, get, need};
use crate::http_client::Http;
use crate::util::BoxFut;

const API: &str = "https://api.cloudflare.com/client/v4";

pub static PROVIDER: ProviderInfo = ProviderInfo {
    id: "cloudflare",
    label: "Cloudflare",
    help: "Uses an API token with Zone → DNS → Edit permission for the zone.",
    fields: &[
        Field::new("api_token", "API token").secret().required(),
        Field::new("zone_id", "Zone ID")
            .help("Optional. Found automatically from the domain if the token can list zones (Zone → Zone → Read)."),
    ],
    persistent: false,
    single_value: false,
    build,
};

struct Cloudflare {
    http: Http,
    token: String,
    zone_id: String,
}

fn build(s: &Settings, http: &Http) -> Result<Box<dyn DnsProvider>, String> {
    Ok(Box::new(Cloudflare {
        http: http.clone(),
        token: need(s, "api_token")?.to_string(),
        zone_id: get(s, "zone_id").to_string(),
    }))
}

impl Cloudflare {
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, String> {
        let auth = format!("Bearer {}", self.token);
        let (status, v) = self
            .http
            .json(
                method,
                &format!("{API}{path}"),
                &[("authorization", &auth)],
                body,
            )
            .await?;
        if v["success"].as_bool() == Some(true) {
            return Ok(v["result"].clone());
        }
        let msgs: Vec<String> = v["errors"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|e| format!("{} ({})", e["message"].as_str().unwrap_or("?"), e["code"]))
                    .collect()
            })
            .unwrap_or_default();
        Err(if msgs.is_empty() {
            format!("Cloudflare API: HTTP {status}")
        } else if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
            format!(
                "Cloudflare API: {} (check the token's permissions)",
                msgs.join("; ")
            )
        } else {
            format!("Cloudflare API: {}", msgs.join("; "))
        })
    }

    /// The zone holding `name`: the configured one, or the longest
    /// matching suffix the token can see.
    async fn zone_for(&self, name: &str) -> Result<String, String> {
        if !self.zone_id.is_empty() {
            return Ok(self.zone_id.clone());
        }
        let labels: Vec<&str> = name.split('.').collect();
        for i in 0..labels.len().saturating_sub(1) {
            let cand = labels[i..].join(".");
            let q: String =
                percent_encoding::utf8_percent_encode(&cand, percent_encoding::NON_ALPHANUMERIC)
                    .to_string();
            let r = self
                .call(Method::GET, &format!("/zones?name={q}"), None)
                .await?;
            if let Some(id) = r.get(0).and_then(|z| z["id"].as_str()) {
                return Ok(id.to_string());
            }
        }
        Err(format!(
            "no Cloudflare zone found for {name} (set the zone ID, or let the token read zones)"
        ))
    }
}

impl DnsProvider for Cloudflare {
    fn present<'a>(&'a self, name: &'a str, value: &'a str) -> BoxFut<'a, Result<String, String>> {
        Box::pin(async move {
            let zone = self.zone_for(name).await?;
            let r = self
                .call(
                    Method::POST,
                    &format!("/zones/{zone}/dns_records"),
                    Some(&json!({ "type": "TXT", "name": name, "content": value, "ttl": 60 })),
                )
                .await?;
            let id = r["id"]
                .as_str()
                .ok_or("Cloudflare API: no record id in response")?;
            Ok(format!("{zone}/{id}"))
        })
    }

    fn cleanup<'a>(
        &'a self,
        _name: &'a str,
        _value: &'a str,
        token: &'a str,
    ) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let (zone, id) = token.split_once('/').ok_or("bad cleanup token")?;
            self.call(
                Method::DELETE,
                &format!("/zones/{zone}/dns_records/{id}"),
                None,
            )
            .await
            .map(|_| ())
        })
    }
}
