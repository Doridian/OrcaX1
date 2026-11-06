//! dns-persist-01 (draft-ietf-acme-dns-persist): one TXT record at
//! `_validation-persist.<domain>` naming the CA and the ACME account, put up
//! by hand once and left there. Nothing to publish per request, so no DNS
//! credentials live on the printer.

use super::{DnsProvider, Field, ProviderInfo, Settings, get};
use crate::http_client::Http;
use crate::util::BoxFut;

pub const ID: &str = "persist";

pub static PROVIDER: ProviderInfo = ProviderInfo {
    id: ID,
    label: "Persistent record, set once by hand (dns-persist-01)",
    help: "No DNS credentials needed: add the TXT records shown below with your DNS provider once and leave them. \
           They name the ACME account, so they change if the account does (another CA, email or EAB key). \
           Needs a CA that supports dns-persist-01.",
    fields: &[Field::new("issuer", "CA issuer domain")
        .placeholder("letsencrypt.org")
        .help("The CA's issuer domain name for dns-persist-01. Leave empty for Let's Encrypt.")],
    persistent: true,
    build,
};

/// The issuer domain name for a CA directory, if known or configured.
pub fn issuer(s: &Settings, directory: &str) -> Option<String> {
    match get(s, "issuer") {
        "" if directory.contains(".api.letsencrypt.org/") => Some("letsencrypt.org".into()),
        "" => None,
        v => Some(v.to_ascii_lowercase()),
    }
}

/// The `(name, value)` TXT records authorizing `account_uri` for `domains`.
/// A wildcard among the names adds `policy=wildcard` to its base's record.
pub fn records(domains: &[String], issuer: &str, account_uri: &str) -> Vec<(String, String)> {
    let mut bases: Vec<(&str, bool)> = Vec::new();
    for d in domains {
        let (base, wild) = match d.strip_prefix("*.") {
            Some(b) => (b, true),
            None => (d.as_str(), false),
        };
        match bases.iter_mut().find(|(b, _)| *b == base) {
            Some(e) => e.1 |= wild,
            None => bases.push((base, wild)),
        }
    }
    bases
        .into_iter()
        .map(|(base, wild)| {
            let mut v = format!("{issuer}; accounturi={account_uri}");
            if wild {
                v.push_str("; policy=wildcard");
            }
            (format!("_validation-persist.{base}"), v)
        })
        .collect()
}

struct Manual;

fn build(_: &Settings, _: &Http) -> Result<Box<dyn DnsProvider>, String> {
    Ok(Box::new(Manual))
}

/// Never called: dns-persist-01 publishes nothing per request.
impl DnsProvider for Manual {
    fn present<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFut<'a, Result<String, String>> {
        Box::pin(async { Ok(String::new()) })
    }
    fn cleanup<'a>(&'a self, _: &'a str, _: &'a str, _: &'a str) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_merges_into_base() {
        let d = vec![
            "example.com".to_string(),
            "*.example.com".to_string(),
            "p.lan.example.org".to_string(),
        ];
        let r = records(&d, "letsencrypt.org", "https://ca/acct/1");
        assert_eq!(
            r,
            [
                (
                    "_validation-persist.example.com".to_string(),
                    "letsencrypt.org; accounturi=https://ca/acct/1; policy=wildcard".to_string()
                ),
                (
                    "_validation-persist.p.lan.example.org".to_string(),
                    "letsencrypt.org; accounturi=https://ca/acct/1".to_string()
                ),
            ]
        );
    }
}
