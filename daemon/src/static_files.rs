//! Static web root: precompressed variants, MIME types, SPA fallback,
//! ETag / Last-Modified revalidation.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use tokio_util::io::ReaderStream;

use crate::App;
use crate::files::sanitize_rel;

pub fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "ini" | "cfg" | "gcode" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "3mf" => "model/3mf",
        "stl" => "model/stl",
        "step" | "stp" => "model/step",
        "obj" => "model/obj",
        _ => "application/octet-stream",
    }
}

/// Which precompressed encodings the client accepts (br, gzip).
fn accepted(headers: &HeaderMap) -> (bool, bool) {
    let Some(v) = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
    else {
        return (false, false);
    };
    let mut br = false;
    let mut gz = false;
    for part in v.split(',') {
        let mut it = part.split(';');
        let coding = it.next().unwrap_or("").trim().to_ascii_lowercase();
        let q_zero = it.any(|p| {
            let p = p.trim();
            p.strip_prefix("q=")
                .and_then(|q| q.trim().parse::<f32>().ok())
                == Some(0.0)
        });
        if q_zero {
            continue;
        }
        match coding.as_str() {
            "br" => br = true,
            "gzip" | "x-gzip" => gz = true,
            "*" => {
                br = true;
                gz = true
            }
            _ => {}
        }
    }
    (br, gz)
}

async fn file_meta(p: &Path) -> Option<std::fs::Metadata> {
    tokio::fs::metadata(p).await.ok().filter(|m| m.is_file())
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found\n").into_response()
}

pub async fn serve(State(app): State<Arc<App>>, headers: HeaderMap, uri: Uri) -> Response {
    let Ok(decoded) = percent_encoding::percent_decode_str(uri.path()).decode_utf8() else {
        return (StatusCode::BAD_REQUEST, "bad path\n").into_response();
    };
    let Ok(rel) = sanitize_rel(decoded.trim_start_matches('/')) else {
        return (StatusCode::BAD_REQUEST, "bad path\n").into_response();
    };
    let root = &app.cfg.web_root;
    let index = root.join("index.html");

    let mut path: PathBuf = root.join(&rel);
    let mut meta = tokio::fs::metadata(&path).await.ok();
    if meta.as_ref().is_some_and(|m| m.is_dir()) {
        path = path.join("index.html");
        meta = file_meta(&path).await;
    }
    if !meta.as_ref().is_some_and(|m| m.is_file()) {
        // SPA fallback: extension-less paths get index.html.
        let has_ext = rel
            .file_name()
            .map(|n| n.to_string_lossy().contains('.'))
            .unwrap_or(false);
        if has_ext {
            return not_found();
        }
        path = index;
        meta = file_meta(&path).await;
    }
    let Some(mut meta) = meta else {
        return not_found();
    };
    // The content type comes from the requested file, not a .br/.gz sibling.
    let ctype = mime_for(&path);
    let is_html = ctype.starts_with("text/html");
    let immutable = rel.starts_with("assets");

    let (br, gz) = accepted(&headers);
    let mut encoding = None;
    let mut serve_path = path.clone();
    for (ok, ext, name) in [(br, "br", "br"), (gz, "gz", "gzip")] {
        if !ok {
            continue;
        }
        let mut p = path.clone().into_os_string();
        p.push(".");
        p.push(ext);
        let p = PathBuf::from(p);
        if let Some(m) = file_meta(&p).await {
            serve_path = p;
            meta = m;
            encoding = Some(name);
            break;
        }
    }

    let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
    let mtime_ns = mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let etag = format!(
        "\"{:x}-{:x}{}\"",
        meta.len(),
        mtime_ns,
        encoding.map(|e| format!("-{e}")).unwrap_or_default()
    );
    let last_modified = httpdate::fmt_http_date(mtime);
    let cache_control = if immutable && !is_html {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };

    let mut h = HeaderMap::new();
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    h.insert(
        header::LAST_MODIFIED,
        HeaderValue::from_str(&last_modified).unwrap(),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    h.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));

    if not_modified(&headers, &etag, mtime) {
        return (StatusCode::NOT_MODIFIED, h).into_response();
    }

    let file = match tokio::fs::File::open(&serve_path).await {
        Ok(f) => f,
        Err(_) => return not_found(),
    };
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(ctype));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(meta.len()));
    if let Some(e) = encoding {
        h.insert(header::CONTENT_ENCODING, HeaderValue::from_static(e));
    }
    let body = Body::from_stream(ReaderStream::with_capacity(file, 64 * 1024));
    (StatusCode::OK, h, body).into_response()
}

fn not_modified(headers: &HeaderMap, etag: &str, mtime: SystemTime) -> bool {
    if let Some(inm) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    {
        return inm.split(',').any(|t| {
            let t = t.trim();
            t == "*" || t.trim_start_matches("W/") == etag
        });
    }
    if let Some(ims) = headers
        .get(header::IF_MODIFIED_SINCE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| httpdate::parse_http_date(v).ok())
    {
        let secs = |t: SystemTime| {
            t.duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        };
        return secs(mtime) <= secs(ims);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_types() {
        assert_eq!(mime_for(Path::new("a/b.wasm")), "application/wasm");
        assert_eq!(
            mime_for(Path::new("index.HTML")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            mime_for(Path::new("x.mjs")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(mime_for(Path::new("noext")), "application/octet-stream");
    }

    #[test]
    fn accept_encoding() {
        let mut h = HeaderMap::new();
        h.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("gzip, deflate, br;q=0"),
        );
        assert_eq!(accepted(&h), (false, true));
        h.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("br, gzip;q=0.5"),
        );
        assert_eq!(accepted(&h), (true, true));
    }
}
