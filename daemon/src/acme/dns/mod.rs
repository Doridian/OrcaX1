//! DNS-01 challenge providers. Each one publishes (and later removes) the
//! `_acme-challenge.<domain>` TXT record; `persist` instead stands for
//! dns-persist-01, where the user sets up a lasting record by hand. To add
//! one, write a module with a `PROVIDER: ProviderInfo` and list it in
//! [`PROVIDERS`]; the UI renders its settings form from `fields`.

mod acme_dns;
mod cloudflare;
pub mod persist;
mod rfc2136;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::http_client::Http;
use crate::util::BoxFut;

pub type Settings = Map<String, Value>;

pub trait DnsProvider: Send + Sync {
    /// Adds a TXT record `name` (fully qualified, no trailing dot) with
    /// `value`. Returns a token handed back to `cleanup`.
    fn present<'a>(&'a self, name: &'a str, value: &'a str) -> BoxFut<'a, Result<String, String>>;
    /// Removes what `present` added.
    fn cleanup<'a>(
        &'a self,
        name: &'a str,
        value: &'a str,
        token: &'a str,
    ) -> BoxFut<'a, Result<(), String>>;
}

#[derive(Serialize)]
pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    /// Never sent back to the browser once saved.
    pub secret: bool,
    pub required: bool,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub placeholder: &'static str,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub help: &'static str,
    /// Non-empty: a choice between these values (the first is the default).
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    pub options: &'static [&'static str],
}

impl Field {
    pub const fn new(key: &'static str, label: &'static str) -> Self {
        Self {
            key,
            label,
            secret: false,
            required: false,
            placeholder: "",
            help: "",
            options: &[],
        }
    }
    pub const fn secret(mut self) -> Self {
        self.secret = true;
        self
    }
    pub const fn required(mut self) -> Self {
        self.required = true;
        self
    }
    pub const fn placeholder(mut self, p: &'static str) -> Self {
        self.placeholder = p;
        self
    }
    pub const fn help(mut self, h: &'static str) -> Self {
        self.help = h;
        self
    }
    pub const fn options(mut self, o: &'static [&'static str]) -> Self {
        self.options = o;
        self
    }
}

pub type BuildFn = fn(&Settings, &Http) -> Result<Box<dyn DnsProvider>, String>;

#[derive(Serialize)]
pub struct ProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub help: &'static str,
    pub fields: &'static [Field],
    /// dns-persist-01: records are set up by hand once, not per request.
    pub persistent: bool,
    #[serde(skip)]
    pub build: BuildFn,
}

pub static PROVIDERS: &[&ProviderInfo] = &[
    &cloudflare::PROVIDER,
    &rfc2136::PROVIDER,
    &acme_dns::PROVIDER,
    &persist::PROVIDER,
];

pub fn find(id: &str) -> Option<&'static ProviderInfo> {
    PROVIDERS.iter().copied().find(|p| p.id == id)
}

/// A string setting, trimmed; "" if missing.
pub fn get<'a>(s: &'a Settings, key: &str) -> &'a str {
    s.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
}

/// A string setting that must be present.
pub fn need<'a>(s: &'a Settings, key: &str) -> Result<&'a str, String> {
    match get(s, key) {
        "" => Err(format!("{key} is required")),
        v => Ok(v),
    }
}

/// A setting with options, defaulting to the first one.
pub fn choice(s: &Settings, f: &Field) -> Result<&'static str, String> {
    let v = get(s, f.key);
    if v.is_empty() {
        return Ok(f.options[0]);
    }
    f.options
        .iter()
        .copied()
        .find(|o| o.eq_ignore_ascii_case(v))
        .ok_or_else(|| format!("{}: unsupported value {v:?}", f.key))
}
