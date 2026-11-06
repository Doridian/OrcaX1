mod acme;
mod auth;
mod camera;
mod config;
mod files;
mod ftps;
mod http_client;
mod mqtt;
mod printer;
mod static_files;
mod store;
mod tls;
mod util;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post, put};
use clap::Parser;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::json;
use tokio::net::TcpListener;
use tower_service::Service;
use tracing::{error, info, warn};

use camera::CameraHub;
use config::Config;
use printer::Printer;

pub struct App {
    pub cfg: Arc<Config>,
    pub printer: Arc<Printer>,
    pub camera: Arc<CameraHub>,
    pub webrtc: camera::webrtc::Handle,
    pub ca_der: Option<Vec<u8>>,
    pub store: Arc<dyn store::FileStore>,
    /// Where the file API points: the SD dir, or ftps://<printer>/.
    pub store_desc: String,
    pub auth: auth::Auth,
    pub acme: Arc<acme::Acme>,
}

fn init_logging() {
    use tracing_subscriber::filter::Targets;
    use tracing_subscriber::prelude::*;
    let spec = std::env::var("ORCAX1D_LOG")
        .or_else(|_| std::env::var("RUST_LOG"))
        .unwrap_or_default();
    let filter: Targets = spec
        .parse()
        .ok()
        .filter(|_| !spec.trim().is_empty())
        .unwrap_or_else(|| Targets::new().with_default(tracing::Level::INFO));
    let ansi = std::io::IsTerminal::is_terminal(&std::io::stderr());
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(ansi)
                .with_target(false),
        )
        .with(filter)
        .init();
}

/// Serial from X1Plus's `bbl_3dpsn` helper, if present.
async fn serial_from_bbl_3dpsn() -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("bbl_3dpsn")
            .stderr(std::process::Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric()))
        .then_some(s)
}

async fn security_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "cross-origin-embedder-policy",
        HeaderValue::from_static("require-corp"),
    );
    h.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    res
}

async fn info_handler(State(app): State<Arc<App>>) -> impl IntoResponse {
    axum::Json(json!({
        "name": "orcax1d",
        "version": env!("CARGO_PKG_VERSION"),
        "serial": app.printer.serial(),
        "mqtt_connected": app.printer.connected(),
        "camera_available": app.camera.available(),
        "camera_error": app.camera.last_error(),
        "mode": if app.cfg.printer.is_some() { "remote" } else { "local" },
        "sd_dir": app.store_desc,
    }))
}

async fn ca_handler(State(app): State<Arc<App>>) -> Response {
    match &app.ca_der {
        Some(der) => (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/x-x509-ca-cert"),
                ),
                (
                    header::CONTENT_DISPOSITION,
                    HeaderValue::from_static("attachment; filename=\"orcax1d-ca.crt\""),
                ),
            ],
            der.clone(),
        )
            .into_response(),
        None => files::ApiError::new(
            StatusCode::NOT_FOUND,
            "no generated CA (custom certificate in use)",
        )
        .into_response(),
    }
}

async fn api_not_found() -> files::ApiError {
    files::ApiError::new(StatusCode::NOT_FOUND, "no such endpoint")
}

fn router(app: Arc<App>) -> Router {
    // Everything here needs a login (when auth is enabled).
    let protected = Router::new()
        .route("/api/info", get(info_handler))
        .route("/api/ws", get(printer::ws_handler))
        .route("/api/camera/whep", post(camera::whep_offer))
        .route("/api/camera/whep/{id}", delete(camera::whep_delete))
        .route("/api/files", get(files::list).delete(files::delete))
        .route("/api/files/download", get(files::download))
        .route(
            "/api/files/upload",
            put(files::upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/print", post(printer::print))
        .route("/api/acme", get(acme::get).put(acme::put))
        .route("/api/acme/issue", post(acme::issue))
        .route("/api/acme/account", post(acme::account))
        .route("/api/acme/cert", delete(acme::delete_cert))
        .route_layer(axum::middleware::from_fn_with_state(
            app.clone(),
            auth::require,
        ));
    Router::new()
        .merge(protected)
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/ca.crt", get(ca_handler))
        .route("/api", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .fallback(static_files::serve)
        .with_state(app)
        .layer(axum::middleware::map_response(security_headers))
}

async fn redirect_handler(State(https_port): State<u16>, headers: HeaderMap, uri: Uri) -> Response {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    let host = if host.starts_with('[') {
        host.split_inclusive(']').next().unwrap_or(host)
    } else {
        host.split(':').next().unwrap_or(host)
    };
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._[]:".contains(c))
    {
        return (StatusCode::BAD_REQUEST, "bad Host header\n").into_response();
    }
    let pq = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let loc = if https_port == 443 {
        format!("https://{host}{pq}")
    } else {
        format!("https://{host}:{https_port}{pq}")
    };
    match HeaderValue::from_str(&loc) {
        Ok(v) => (StatusCode::MOVED_PERMANENTLY, [(header::LOCATION, v)]).into_response(),
        Err(_) => (StatusCode::BAD_REQUEST, "bad request\n").into_response(),
    }
}

async fn bind(addr: SocketAddr) -> std::io::Result<TcpListener> {
    TcpListener::bind(addr)
        .await
        .map_err(|e| std::io::Error::new(e.kind(), format!("bind {addr}: {e}")))
}

/// Accept loop shared by the TLS and plain listeners.
async fn serve(listener: TcpListener, app: Router, tls: Option<tokio_rustls::TlsAcceptor>) {
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                warn!("accept: {e}");
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
        };
        let _ = tcp.set_nodelay(true);
        let app = app.clone();
        let tls = tls.clone();
        tokio::spawn(async move {
            let svc = hyper::service::service_fn(move |mut req: Request<hyper::body::Incoming>| {
                let mut app = app.clone();
                req.extensions_mut()
                    .insert(axum::extract::ConnectInfo(peer));
                async move { app.call(req.map(axum::body::Body::new)).await }
            });
            let mut builder = hyper::server::conn::http1::Builder::new();
            builder
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(30));
            let res =
                match tls {
                    Some(acc) => {
                        let stream =
                            match tokio::time::timeout(Duration::from_secs(10), acc.accept(tcp))
                                .await
                            {
                                Ok(Ok(s)) => s,
                                Ok(Err(e)) => {
                                    tracing::debug!(%peer, "TLS handshake failed: {e}");
                                    return;
                                }
                                Err(_) => return,
                            };
                        builder
                            .serve_connection(TokioIo::new(stream), svc)
                            .with_upgrades()
                            .await
                    }
                    None => {
                        builder
                            .serve_connection(TokioIo::new(tcp), svc)
                            .with_upgrades()
                            .await
                    }
                };
            if let Err(e) = res {
                tracing::debug!(%peer, "connection error: {e}");
            }
        });
    }
}

async fn shutdown_signal() {
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term => {}
    }
}

fn main() {
    let cfg = Config::parse();
    init_logging();
    tls::install_crypto_provider();
    str0m::crypto::from_feature_flags().install_process_default();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()
        .expect("tokio runtime");
    if let Err(e) = rt.block_on(run(cfg)) {
        error!("{e}");
        std::process::exit(1);
    }
}

async fn run(mut cfg: Config) -> Result<(), String> {
    if let Some(p) = &cfg.printer {
        // Remote mode: everything goes to the printer over the LAN.
        cfg.mqtt_host = p.clone();
    } else if cfg.serial.is_none() {
        cfg.serial = serial_from_bbl_3dpsn().await;
    }
    let cfg = Arc::new(cfg);
    info!(
        version = env!("CARGO_PKG_VERSION"),
        web_root = %cfg.web_root.display(),
        sd_dir = %cfg.sd_dir.display(),
        serial = ?cfg.serial,
        "starting orcax1d"
    );
    if !cfg.web_root.join("index.html").exists() {
        warn!("{} has no index.html", cfg.web_root.display());
    }

    let (printer, outbox) = Printer::new(cfg.serial.clone());
    let camera = CameraHub::new();

    let server_tls = if cfg.no_tls {
        None
    } else {
        Some(
            tls::server_config(
                cfg.tls_cert.as_deref(),
                cfg.tls_key.as_deref(),
                &cfg.state_dir,
            )
            .map_err(|e| format!("TLS setup: {e}"))?,
        )
    };
    let (store, store_desc): (Arc<dyn store::FileStore>, String) = match &cfg.printer {
        Some(p) => {
            let host = if p.contains(':') && !p.starts_with('[') {
                format!("[{p}]")
            } else {
                p.clone()
            };
            (
                Arc::new(ftps::FtpsStore::new(p.clone(), cfg.ftps_port, cfg.clone())),
                format!("ftps://{host}:{}/", cfg.ftps_port),
            )
        }
        None => (
            Arc::new(store::LocalStore {
                root: cfg.sd_dir.clone(),
            }),
            cfg.sd_dir.display().to_string(),
        ),
    };
    info!(mode = if cfg.printer.is_some() { "remote" } else { "local" }, files = %store_desc, mqtt = %cfg.mqtt_host, "file store");
    let webrtc = camera::webrtc::start(camera.clone(), cfg.webrtc_port);

    std::fs::create_dir_all(&cfg.state_dir)
        .map_err(|e| format!("state dir {}: {e}", cfg.state_dir.display()))?;
    let auth_key = auth::load_key(&cfg.state_dir).map_err(|e| format!("auth key: {e}"))?;
    let providers = auth::providers(&cfg.auth, &cfg, &auth_key)?;
    if providers.is_empty() {
        warn!(
            "authentication is disabled (--auth none): anyone who can reach the daemon can control the printer"
        );
    }
    let auth = auth::Auth::new(
        providers,
        &cfg.state_dir,
        cfg.session_days,
        server_tls.is_some(),
    );
    let http = http_client::Http::new(cfg.acme_ca_file.as_deref())
        .map_err(|e| format!("--acme-ca-file: {e}"))?;
    let acme = acme::Acme::start(
        &cfg.state_dir,
        server_tls.as_ref().map(|t| t.resolver.clone()),
        http,
    );

    let app = Arc::new(App {
        auth,
        acme,
        store,
        store_desc,
        cfg: cfg.clone(),
        printer: printer.clone(),
        camera: camera.clone(),
        webrtc,
        ca_der: server_tls.as_ref().and_then(|t| t.ca_der.clone()),
    });

    tokio::spawn(mqtt::run(printer, cfg.clone(), outbox));
    tokio::spawn(camera::run(camera, cfg.clone()));

    let main_listener = bind(cfg.listen).await.map_err(|e| e.to_string())?;
    let scheme = if server_tls.is_some() {
        "https"
    } else {
        "http"
    };
    info!("listening on {scheme}://{}", cfg.listen);
    let acceptor = server_tls.map(|t| tokio_rustls::TlsAcceptor::from(t.config));
    tokio::spawn(serve(main_listener, router(app), acceptor.clone()));

    if acceptor.is_some() && !cfg.no_redirect {
        match bind(cfg.redirect_listen).await {
            Ok(l) => {
                info!("redirecting http://{} to https", cfg.redirect_listen);
                let r = Router::new()
                    .fallback(redirect_handler)
                    .with_state(cfg.listen.port())
                    .layer(axum::middleware::map_response(security_headers));
                tokio::spawn(serve(l, r, None));
            }
            // Not fatal: the main listener is what matters.
            Err(e) => warn!("redirect listener disabled: {e}"),
        }
    }

    shutdown_signal().await;
    info!("shutting down");
    Ok(())
}
