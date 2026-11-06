//! TXT updates over the DynDNS2 protocol (`/nic/update` with a `txt`
//! parameter), as offered by Hurricane Electric's free DNS (dns.he.net).
//! The `_acme-challenge` TXT records must already exist with dynamic DNS
//! enabled; each update replaces the record's value, and the key can only
//! change that one record.

use super::{DnsProvider, Field, ProviderInfo, Settings, get, need};
use crate::http_client::Http;
use crate::util::BoxFut;

const HE: &str = "https://dyn.dns.he.net/nic/update";

pub static PROVIDER: ProviderInfo = ProviderInfo {
    id: "dyndns",
    label: "Dynamic DNS TXT update (Hurricane Electric)",
    help: "In dns.he.net, create a TXT record _acme-challenge.<domain> for each domain (a wildcard uses its base \
           name's record), tick \"Enable entry for dynamic dns\", and set its DDNS key. Give every record the same \
           key, or list one key per record. Names sharing a record (example.com and *.example.com) are validated \
           one after another.",
    fields: &[
        Field::new("key", "DDNS key")
            .secret()
            .help("Used for every record without its own key below."),
        Field::new("keys", "Per-record keys").secret().help(
            "Optional: name=key pairs separated by spaces or commas, \
             e.g. _acme-challenge.example.com=k1 _acme-challenge.lan.example.com=k2",
        ),
        Field::new("server", "Update URL")
            .placeholder(HE)
            .help("Any server speaking the DynDNS2 protocol with TXT support."),
    ],
    persistent: false,
    single_value: true,
    build,
};

struct DynDns {
    http: Http,
    url: String,
    key: String,
    keys: Vec<(String, String)>,
}

fn build(s: &Settings, http: &Http) -> Result<Box<dyn DnsProvider>, String> {
    Ok(Box::new(DynDns::new(s, http)?))
}

impl DynDns {
    fn new(s: &Settings, http: &Http) -> Result<Self, String> {
        let url = match get(s, "server") {
            "" => HE,
            u if u.starts_with("https://") || u.starts_with("http://") => u,
            _ => return Err("the update URL must be an http(s):// URL".into()),
        };
        let mut keys = Vec::new();
        for pair in get(s, "keys")
            .split([' ', ',', '\n'])
            .filter(|p| !p.is_empty())
        {
            let (name, key) = pair
                .split_once('=')
                .filter(|(n, k)| !n.is_empty() && !k.is_empty())
                .ok_or_else(|| format!("per-record keys: expected name=key, got {pair:?}"))?;
            keys.push((
                name.trim_end_matches('.').to_ascii_lowercase(),
                key.to_string(),
            ));
        }
        let key = get(s, "key").to_string();
        if key.is_empty() && keys.is_empty() {
            need(s, "key")?;
        }
        Ok(Self {
            http: http.clone(),
            url: url.to_string(),
            key,
            keys,
        })
    }

    fn key_for(&self, name: &str) -> Result<&str, String> {
        self.keys
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, k)| k.as_str())
            .or((!self.key.is_empty()).then_some(self.key.as_str()))
            .ok_or_else(|| format!("no DDNS key for {name}"))
    }
}

impl DnsProvider for DynDns {
    fn present<'a>(&'a self, name: &'a str, value: &'a str) -> BoxFut<'a, Result<String, String>> {
        Box::pin(async move {
            let key = self.key_for(name)?;
            let (status, body) = self
                .http
                .form(
                    &self.url,
                    &[],
                    &[("hostname", name), ("password", key), ("txt", value)],
                )
                .await?;
            let body = body.trim();
            if status.is_success() && (body.starts_with("good") || body.starts_with("nochg")) {
                return Ok(String::new());
            }
            Err(match body.split_whitespace().next().unwrap_or("") {
                "badauth" => format!("{name}: wrong DDNS key"),
                "nohost" => format!("{name}: no such record with dynamic DNS enabled"),
                "abuse" | "interval" => {
                    format!("{name}: the server is rate limiting updates ({body})")
                }
                "" => format!("{name}: HTTP {status}"),
                _ => format!("{name}: {body}"),
            })
        })
    }

    /// The record stays (it must exist for the next renewal); its stale value
    /// is harmless.
    fn cleanup<'a>(&'a self, _: &'a str, _: &'a str, _: &'a str) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dyn_dns(key: &str, keys: &str) -> Result<DynDns, String> {
        let mut s = Settings::new();
        s.insert("key".into(), key.into());
        s.insert("keys".into(), keys.into());
        DynDns::new(&s, &Http::new(None).unwrap())
    }

    #[test]
    fn keys() {
        let d = dyn_dns(
            "all",
            "_acme-challenge.A.example.com.=k1, _acme-challenge.b.example.com=k2",
        )
        .unwrap();
        assert_eq!(d.key_for("_acme-challenge.a.example.com"), Ok("k1"));
        assert_eq!(d.key_for("_acme-challenge.c.example.com"), Ok("all"));
        let d = dyn_dns("", "_acme-challenge.a.example.com=k1").unwrap();
        assert!(d.key_for("_acme-challenge.c.example.com").is_err());
        assert!(dyn_dns("", "").is_err());
        assert!(dyn_dns("x", "nokey").is_err());
    }
}
