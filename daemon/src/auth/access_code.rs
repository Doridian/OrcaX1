//! Login with the printer's LAN access code, the same secret that guards
//! its MQTT, camera and FTPS services.

use std::sync::Arc;

use ring::hmac;
use serde_json::{Value, json};

use super::{AuthProvider, Identity, LoginError};
use crate::config::Config;
use crate::util::BoxFut;

pub struct AccessCode {
    cfg: Arc<Config>,
    key: hmac::Key,
}

impl AccessCode {
    pub fn new(cfg: Arc<Config>, key: hmac::Key) -> Self {
        Self { cfg, key }
    }
}

impl AuthProvider for AccessCode {
    fn id(&self) -> &'static str {
        "access-code"
    }

    fn ui(&self) -> Value {
        json!({
            "kind": "secret",
            "label": "LAN access code",
            "field": "Access code",
            "hint": "Shown on the printer's screen under Settings → Network (LAN mode).",
        })
    }

    fn login<'a>(&'a self, form: &'a Value) -> BoxFut<'a, Result<Identity, LoginError>> {
        Box::pin(async move {
            let given = form
                .get("secret")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let Some(code) = self.cfg.access_code() else {
                return Err(LoginError::Unavailable(
                    "the printer's access code is not available to the daemon".into(),
                ));
            };
            // Constant-time: compare MACs rather than the strings.
            let tag = hmac::sign(&self.key, code.as_bytes());
            if given.is_empty() || hmac::verify(&self.key, given.as_bytes(), tag.as_ref()).is_err()
            {
                return Err(LoginError::Denied("wrong access code".into()));
            }
            Ok(Identity {
                subject: "lan".into(),
                name: "LAN access code".into(),
            })
        })
    }

    fn binding(&self) -> Option<String> {
        let code = self.cfg.access_code()?;
        Some(crate::tls::hex(
            hmac::sign(&self.key, code.as_bytes()).as_ref(),
        ))
    }
}
