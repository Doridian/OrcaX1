use std::net::SocketAddr;
use std::path::PathBuf;

use clap::Parser;

/// orcax1d: serves the OrcaX1 web UI and bridges it to the printer's MQTT
/// broker, camera and SD card.
#[derive(Parser, Debug, Clone)]
#[command(name = "orcax1d", version, about)]
pub struct Config {
    /// Main listen address (HTTPS unless --no-tls). Port 443 needs root
    /// (the printer's init script runs the daemon as root).
    #[arg(long, env = "ORCAX1D_LISTEN", default_value = "0.0.0.0:443")]
    pub listen: SocketAddr,

    /// Plain-HTTP listeners that 301-redirect to the HTTPS listener,
    /// comma-separated. One that cannot be bound (say, port 80 already in
    /// use) is skipped with a warning.
    #[arg(
        long,
        env = "ORCAX1D_REDIRECT_LISTEN",
        value_delimiter = ',',
        default_value = "0.0.0.0:80,0.0.0.0:8080"
    )]
    pub redirect_listen: Vec<SocketAddr>,

    /// Disable the HTTP -> HTTPS redirect listener.
    #[arg(long, env = "ORCAX1D_NO_REDIRECT")]
    pub no_redirect: bool,

    /// Serve plain HTTP on the main listener (development only: browsers
    /// only treat http://localhost as a secure context).
    #[arg(long, env = "ORCAX1D_NO_TLS")]
    pub no_tls: bool,

    /// PEM certificate chain for the HTTPS listener (default: self-signed,
    /// generated in --state-dir).
    #[arg(long, env = "ORCAX1D_TLS_CERT", requires = "tls_key")]
    pub tls_cert: Option<PathBuf>,

    /// PEM private key for --tls-cert.
    #[arg(long, env = "ORCAX1D_TLS_KEY", requires = "tls_cert")]
    pub tls_key: Option<PathBuf>,

    /// Directory holding the built web UI.
    #[arg(
        long,
        env = "ORCAX1D_WEB_ROOT",
        default_value = "/mnt/sdcard/orcax1/www"
    )]
    pub web_root: PathBuf,

    /// Directory for persistent daemon state: TLS CA and certificates,
    /// login sessions, OpenID Connect and ACME settings (with their
    /// secrets). Kept on internal flash, out of reach of the SD card's FTPS
    /// server, which anyone with the LAN access code can read.
    #[arg(
        long,
        env = "ORCAX1D_STATE_DIR",
        default_value = "/userdata/orcax1/state"
    )]
    pub state_dir: PathBuf,

    /// The release folder on the SD card that install.sh installs from
    /// (holds orcax1d, www/, install.sh, VERSION). Updates uploaded through the web UI are
    /// unpacked here; they are only offered when install.sh is present.
    #[arg(
        long,
        env = "ORCAX1D_INSTALL_DIR",
        default_value = "/mnt/sdcard/orcax1"
    )]
    pub install_dir: PathBuf,

    /// Root of the file API (the printer's SD card). Ignored with --printer.
    #[arg(long, env = "ORCAX1D_SD_DIR", default_value = "/mnt/sdcard")]
    pub sd_dir: PathBuf,

    /// URL prefix the printer uses to open files from --sd-dir.
    #[arg(
        long,
        env = "ORCAX1D_PRINT_URL_PREFIX",
        default_value = "file:///sdcard/"
    )]
    pub print_url_prefix: String,

    /// Remote (development) mode: drive the printer at this address over
    /// LAN mode. MQTT, camera and the file API (via FTPS) all go to it.
    #[arg(long, env = "ORCAX1_PRINTER")]
    pub printer: Option<String>,

    /// FTPS port used in remote mode (implicit TLS).
    #[arg(long, env = "ORCAX1D_FTPS_PORT", default_value_t = 990)]
    pub ftps_port: u16,

    /// MQTT broker host (overridden by --printer).
    #[arg(long, env = "ORCAX1D_MQTT_HOST", default_value = "127.0.0.1")]
    pub mqtt_host: String,

    /// MQTT broker port (TLS).
    #[arg(long, env = "ORCAX1D_MQTT_PORT", default_value_t = 8883)]
    pub mqtt_port: u16,

    /// LAN access code (MQTT password / RTSP password). Overrides
    /// --access-code-file.
    #[arg(long, env = "ORCAX1_ACCESS_CODE", hide_env_values = true)]
    pub access_code: Option<String>,

    /// File containing the LAN access code. Re-read on every reconnect.
    #[arg(
        long,
        env = "ORCAX1D_ACCESS_CODE_FILE",
        default_value = "/config/device/access_token"
    )]
    pub access_code_file: PathBuf,

    /// Printer serial number (default: `bbl_3dpsn`, else learned from the
    /// first MQTT report).
    #[arg(long, env = "ORCAX1D_SERIAL")]
    pub serial: Option<String>,

    /// UDP port for WebRTC camera viewers, bound on every local address
    /// (0: random per address).
    #[arg(long, env = "ORCAX1D_WEBRTC_PORT", default_value_t = 8443)]
    pub webrtc_port: u16,

    /// Login methods, comma-separated: `access-code` (the printer's LAN
    /// access code), `oidc` (OpenID Connect, offered once set up under
    /// Settings), or `none` to disable authentication.
    #[arg(
        long,
        env = "ORCAX1D_AUTH",
        value_delimiter = ',',
        default_value = "access-code,oidc"
    )]
    pub auth: Vec<String>,

    /// How long a login lasts, in days.
    #[arg(long, env = "ORCAX1D_SESSION_DAYS", default_value_t = 30)]
    pub session_days: u32,

    /// Extra PEM CA certificates to trust for outgoing HTTPS (ACME, DNS
    /// provider APIs, the OpenID Connect provider), e.g. a private step-ca,
    /// on top of the bundled Mozilla roots.
    #[arg(long = "ca-file", alias = "acme-ca-file", env = "ORCAX1D_CA_FILE")]
    pub ca_file: Option<PathBuf>,

    /// Camera URL (default: rtsps://bblp:<access code>@<mqtt host>:322/streaming/live/1).
    #[arg(long, env = "ORCAX1D_RTSP_URL", hide_env_values = true)]
    pub rtsp_url: Option<String>,
}

impl Config {
    /// The access code, read fresh from the file each call unless given
    /// on the command line.
    pub fn access_code(&self) -> Option<String> {
        if let Some(c) = &self.access_code {
            return Some(c.trim().to_string());
        }
        let s = std::fs::read_to_string(&self.access_code_file).ok()?;
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_string())
    }

    pub fn rtsp_url(&self) -> Option<String> {
        if let Some(u) = &self.rtsp_url {
            return Some(u.clone());
        }
        let code = self.access_code()?;
        let host = if self.mqtt_host.contains(':') && !self.mqtt_host.starts_with('[') {
            format!("[{}]", self.mqtt_host)
        } else {
            self.mqtt_host.clone()
        };
        let code: String =
            percent_encoding::utf8_percent_encode(&code, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        Some(format!("rtsps://bblp:{code}@{host}:322/streaming/live/1"))
    }
}
