//! Printer state (merged push_status), the /api/ws bridge and /api/print.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use axum::Json;
use axum::extract::State;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, warn};

use crate::App;
use crate::files::{ApiError, rel_to_string, sanitize_rel};

pub struct Printer {
    serial: RwLock<Option<String>>,
    /// Bambu model id from SSDP (BL-P001 = X1 Carbon, BL-P002 = X1, C13 = X1E).
    model: RwLock<Option<String>>,
    connected: AtomicBool,
    status: Mutex<Option<Value>>,
    events: broadcast::Sender<Utf8Bytes>,
    outbox: mpsc::Sender<Vec<u8>>,
    seq: AtomicU64,
}

impl Printer {
    pub fn new(serial: Option<String>) -> (Arc<Self>, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel(64);
        let (events, _) = broadcast::channel(256);
        let p = Arc::new(Self {
            serial: RwLock::new(serial),
            model: RwLock::new(None),
            connected: AtomicBool::new(false),
            status: Mutex::new(None),
            events,
            outbox: tx,
            seq: AtomicU64::new(1),
        });
        (p, rx)
    }

    pub fn serial(&self) -> Option<String> {
        self.serial.read().unwrap().clone()
    }

    pub fn set_serial(&self, sn: String) {
        *self.serial.write().unwrap() = Some(sn);
    }

    pub fn model(&self) -> Option<String> {
        self.model.read().unwrap().clone()
    }

    pub fn set_model(&self, model: String) {
        *self.model.write().unwrap() = Some(model.clone());
        let _ = self
            .events
            .send(json!({"type": "model", "model": model}).to_string().into());
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn set_connected(&self, c: bool) {
        if self.connected.swap(c, Ordering::Relaxed) != c {
            let _ = self
                .events
                .send(json!({"type": "mqtt", "connected": c}).to_string().into());
        }
    }

    /// Handles one message from device/<sn>/report.
    pub fn handle_report(&self, payload: &[u8]) {
        let trimmed = trim_payload(payload);
        let Ok(text) = std::str::from_utf8(trimmed) else {
            warn!("MQTT report is not UTF-8; dropped");
            return;
        };
        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                warn!("unparseable MQTT report: {e}");
                return;
            }
        };
        if let Some(print) = value.get("print")
            && print.get("command").and_then(Value::as_str) == Some("push_status")
        {
            let mut st = self.status.lock().unwrap();
            match st.as_mut() {
                Some(cur) => deep_merge(cur, print),
                None => *st = Some(print.clone()),
            }
        }
        // Forward verbatim (the payload is already valid JSON).
        let msg = format!("{{\"type\":\"report\",\"data\":{text}}}");
        let _ = self.events.send(msg.into());
    }

    fn status_message(&self) -> Option<String> {
        let st = self.status.lock().unwrap();
        st.as_ref()
            .map(|s| json!({"type": "status", "data": s}).to_string())
    }

    /// Publishes `data` to device/<sn>/request, filling in sequence_id.
    pub fn publish(&self, mut data: Value) -> Result<Value, String> {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        fill_sequence_id(&mut data, seq)?;
        if !self.connected() {
            return Err("MQTT not connected".into());
        }
        if self.serial().is_none() {
            return Err("printer serial not known yet".into());
        }
        let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
        self.outbox
            .try_send(bytes)
            .map_err(|_| "MQTT outbox full".to_string())?;
        Ok(data)
    }
}

fn trim_payload(p: &[u8]) -> &[u8] {
    let end = p
        .iter()
        .rposition(|&b| !matches!(b, 0 | b' ' | b'\n' | b'\r' | b'\t'))
        .map_or(0, |i| i + 1);
    &p[..end]
}

/// Recursively merges `src` into `dst`: objects merge key by key; anything
/// else (arrays included) replaces.
pub fn deep_merge(dst: &mut Value, src: &Value) {
    match (dst, src) {
        (Value::Object(d), Value::Object(s)) => {
            for (k, v) in s {
                match d.get_mut(k) {
                    Some(dv) if dv.is_object() && v.is_object() => deep_merge(dv, v),
                    _ => {
                        d.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (d, s) => *d = s.clone(),
    }
}

pub fn fill_sequence_id(data: &mut Value, seq: u64) -> Result<(), String> {
    let Value::Object(outer) = data else {
        return Err("request data must be a JSON object".into());
    };
    if outer.is_empty() {
        return Err("request data is empty".into());
    }
    for inner in outer.values_mut() {
        if let Value::Object(o) = inner
            && !o.contains_key("sequence_id")
        {
            o.insert("sequence_id".into(), Value::String(seq.to_string()));
        }
    }
    Ok(())
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    ws.max_message_size(1024 * 1024)
        .on_upgrade(move |s| ws_client(s, app))
}

async fn ws_client(mut ws: WebSocket, app: Arc<App>) {
    let p = &app.printer;
    let mut rx = p.events.subscribe();
    let hello = json!({
        "type": "hello",
        "serial": p.serial(),
        "model": p.model(),
        "mqtt_connected": p.connected(),
    });
    if ws.send(Message::text(hello.to_string())).await.is_err() {
        return;
    }
    if let Some(st) = p.status_message()
        && ws.send(Message::text(st)).await.is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(text) => {
                    if ws.send(Message::Text(text)).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    debug!("ws client lagged by {n} messages; resending status");
                    if let Some(st) = p.status_message()
                        && ws.send(Message::text(st)).await.is_err() {
                            return;
                        }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            msg = ws.recv() => match msg {
                Some(Ok(Message::Text(t))) => {
                    if let Err(e) = handle_client_message(p, &t) {
                        let err = json!({"type": "error", "message": e});
                        if ws.send(Message::text(err.to_string())).await.is_err() {
                            return;
                        }
                    }
                }
                Some(Ok(Message::Binary(_))) => {
                    let err = json!({"type": "error", "message": "binary frames are not supported"});
                    if ws.send(Message::text(err.to_string())).await.is_err() {
                        return;
                    }
                }
                Some(Ok(_)) => {}
                None | Some(Err(_)) => return,
            },
        }
    }
}

fn handle_client_message(p: &Printer, text: &str) -> Result<(), String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;
    match v.get("type").and_then(Value::as_str) {
        Some("request") => {
            let data = v.get("data").cloned().ok_or("request without data")?;
            p.publish(data).map(|_| ())
        }
        Some(t) => Err(format!("unknown message type {t:?}")),
        None => Err("message without type".into()),
    }
}

fn default_plate() -> u32 {
    1
}
fn default_true() -> bool {
    true
}
fn default_bed_type() -> String {
    "auto".into()
}

#[derive(Deserialize)]
pub struct PrintRequest {
    path: String,
    #[serde(default = "default_plate")]
    plate: u32,
    use_ams: Option<bool>,
    #[serde(default)]
    ams_mapping: Vec<i64>,
    #[serde(default)]
    timelapse: bool,
    #[serde(default = "default_true")]
    bed_leveling: bool,
    #[serde(default)]
    flow_cali: bool,
    #[serde(default)]
    vibration_cali: bool,
    #[serde(default = "default_true")]
    layer_inspect: bool,
    #[serde(default = "default_bed_type")]
    bed_type: String,
    /// 0 off, 1 on, 2 auto (printer decides). Defaults to `bed_leveling`.
    auto_bed_leveling: Option<i64>,
    /// 0 off, 1 on, 2 auto. Defaults to `flow_cali`.
    extrude_cali_flag: Option<i64>,
    /// 0 off, 1 on, 2 auto. Only dual-nozzle printers act on it; Orca sends auto.
    #[serde(default = "default_auto")]
    nozzle_offset_cali: i64,
}

fn default_auto() -> i64 {
    2
}

/// The calibration / inspection options of `project_file`, as OrcaSlicer's
/// network plugin sends them: the booleans plus their integer modes, under
/// both spellings of bed leveling (older firmware reads `bed_levelling`).
fn print_options(req: &PrintRequest, p: &mut Map<String, Value>) {
    p.insert("timelapse".into(), req.timelapse.into());
    p.insert("bed_type".into(), req.bed_type.clone().into());
    p.insert("bed_leveling".into(), req.bed_leveling.into());
    p.insert("bed_levelling".into(), req.bed_leveling.into());
    p.insert(
        "auto_bed_leveling".into(),
        req.auto_bed_leveling
            .unwrap_or(req.bed_leveling as i64)
            .into(),
    );
    p.insert("flow_cali".into(), req.flow_cali.into());
    p.insert(
        "extrude_cali_flag".into(),
        req.extrude_cali_flag.unwrap_or(req.flow_cali as i64).into(),
    );
    p.insert("nozzle_offset_cali".into(), req.nozzle_offset_cali.into());
    p.insert("vibration_cali".into(), req.vibration_cali.into());
    p.insert("layer_inspect".into(), req.layer_inspect.into());
    // Bit 2 is "timelapse to internal storage"; the X1 has none.
    p.insert("cfg".into(), "0".into());
}

/// Global tray id -> {"ams_id","slot_id"} as used by `ams_mapping2`.
pub fn ams_mapping2(mapping: &[i64]) -> Vec<Value> {
    mapping
        .iter()
        .map(|&t| {
            let (ams, slot) = match t {
                0..=127 => (t / 4, t % 4),
                // AMS HT units use ids 128.. with a single slot.
                128..=253 => (t, 0),
                254 => (255, 0),
                _ => (255, 255),
            };
            json!({"ams_id": ams, "slot_id": slot})
        })
        .collect()
}

pub fn subtask_name(file_name: &str) -> String {
    let lower = file_name.to_ascii_lowercase();
    for suffix in [".gcode.3mf", ".3mf", ".gcode"] {
        if lower.ends_with(suffix) && lower.len() > suffix.len() {
            return file_name[..file_name.len() - suffix.len()].to_string();
        }
    }
    file_name.to_string()
}

pub async fn print(
    State(app): State<Arc<App>>,
    Json(req): Json<PrintRequest>,
) -> Result<Json<Value>, ApiError> {
    let rel = sanitize_rel(&req.path).map_err(ApiError::bad_request)?;
    if rel.as_os_str().is_empty() {
        return Err(ApiError::bad_request("path must name a file"));
    }
    if req.plate < 1 {
        return Err(ApiError::bad_request("plate is 1-based"));
    }
    if !app.printer.connected() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "MQTT not connected",
        ));
    }
    let md5 = app.store.md5(&rel).await?;
    let rel_s = rel_to_string(&rel);
    let name = rel
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let use_ams = req.use_ams.unwrap_or(!req.ams_mapping.is_empty());

    let mut p = Map::new();
    p.insert("command".into(), "project_file".into());
    p.insert(
        "param".into(),
        format!("Metadata/plate_{}.gcode", req.plate).into(),
    );
    p.insert(
        "url".into(),
        format!("{}{}", app.cfg.print_url_prefix, rel_s).into(),
    );
    p.insert("md5".into(), md5.into());
    p.insert("file".into(), "".into());
    p.insert("subtask_name".into(), subtask_name(&name).into());
    for k in ["project_id", "profile_id", "task_id", "subtask_id"] {
        p.insert(k.into(), "0".into());
    }
    print_options(&req, &mut p);
    p.insert("use_ams".into(), use_ams.into());
    p.insert("ams_mapping2".into(), ams_mapping2(&req.ams_mapping).into());
    p.insert("ams_mapping".into(), json!(req.ams_mapping));

    let published = app
        .printer
        .publish(json!({ "print": p }))
        .map_err(|e| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, e))?;
    tracing::info!(path = %rel_s, plate = req.plate, "print started");
    Ok(Json(json!({"ok": true, "request": published})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_unmentioned_keys() {
        let mut a = json!({"ams": {"ams": [1], "tray_now": "1"}, "nozzle_temper": 20, "ipcam": {"rtsp_url": "x"}});
        let b = json!({"ams": {"tray_now": "2"}, "nozzle_temper": 210.5, "mc_percent": 3});
        deep_merge(&mut a, &b);
        assert_eq!(
            a,
            json!({"ams": {"ams": [1], "tray_now": "2"}, "nozzle_temper": 210.5, "ipcam": {"rtsp_url": "x"}, "mc_percent": 3})
        );
    }

    #[test]
    fn merge_replaces_arrays_and_type_changes() {
        let mut a = json!({"x": [1, 2, 3], "y": {"z": 1}});
        deep_merge(&mut a, &json!({"x": [9], "y": 5}));
        assert_eq!(a, json!({"x": [9], "y": 5}));
    }

    #[test]
    fn sequence_id_filled_only_when_missing() {
        let mut a = json!({"print": {"command": "pause", "param": ""}});
        fill_sequence_id(&mut a, 7).unwrap();
        assert_eq!(a["print"]["sequence_id"], "7");
        let mut b = json!({"system": {"sequence_id": "abc", "command": "ledctrl"}});
        fill_sequence_id(&mut b, 8).unwrap();
        assert_eq!(b["system"]["sequence_id"], "abc");
        assert!(fill_sequence_id(&mut json!([1]), 1).is_err());
        assert!(fill_sequence_id(&mut json!({}), 1).is_err());
    }

    #[test]
    fn ams_mapping2_construction() {
        assert_eq!(
            ams_mapping2(&[0, 2, 5, 15, 254, -1, 128]),
            vec![
                json!({"ams_id": 0, "slot_id": 0}),
                json!({"ams_id": 0, "slot_id": 2}),
                json!({"ams_id": 1, "slot_id": 1}),
                json!({"ams_id": 3, "slot_id": 3}),
                json!({"ams_id": 255, "slot_id": 0}),
                json!({"ams_id": 255, "slot_id": 255}),
                json!({"ams_id": 128, "slot_id": 0}),
            ]
        );
    }

    #[test]
    fn print_options_like_orca() {
        let req: PrintRequest =
            serde_json::from_value(json!({"path": "a.3mf", "flow_cali": true})).unwrap();
        let mut p = Map::new();
        print_options(&req, &mut p);
        assert_eq!(
            Value::Object(p),
            json!({"timelapse": false, "bed_type": "auto", "bed_leveling": true, "bed_levelling": true,
                   "auto_bed_leveling": 1, "flow_cali": true, "extrude_cali_flag": 1, "nozzle_offset_cali": 2,
                   "vibration_cali": false, "layer_inspect": true, "cfg": "0"})
        );
        let req: PrintRequest =
            serde_json::from_value(json!({"path": "a.3mf", "bed_leveling": false,
            "auto_bed_leveling": 2, "layer_inspect": false}))
            .unwrap();
        let mut p = Map::new();
        print_options(&req, &mut p);
        assert_eq!(
            (
                &p["auto_bed_leveling"],
                &p["extrude_cali_flag"],
                &p["layer_inspect"]
            ),
            (&json!(2), &json!(0), &json!(false))
        );
    }

    #[test]
    fn subtask_names() {
        assert_eq!(subtask_name("model.gcode.3mf"), "model");
        assert_eq!(subtask_name("Model.3MF"), "Model");
        assert_eq!(subtask_name("x.gcode"), "x");
        assert_eq!(subtask_name("plain"), "plain");
    }

    #[test]
    fn payload_trim() {
        assert_eq!(trim_payload(b"{}\0\n"), b"{}");
        assert_eq!(trim_payload(b"\0"), b"");
    }

    #[test]
    fn report_merges_and_forwards() {
        let (p, _rx) = Printer::new(Some("SN".into()));
        let mut ev = p.events.subscribe();
        p.handle_report(br#"{"print":{"command":"push_status","ams":{"ams":[]},"a":1}}"#);
        p.handle_report(br#"{"print":{"command":"push_status","a":2}}"#);
        p.handle_report(br#"{"info":{"command":"get_version"}}"#);
        let st = p.status.lock().unwrap().clone().unwrap();
        assert_eq!(st, json!({"command":"push_status","ams":{"ams":[]},"a":2}));
        let first: Value = serde_json::from_str(ev.try_recv().unwrap().as_str()).unwrap();
        assert_eq!(first["type"], "report");
        assert_eq!(first["data"]["print"]["a"], 1);
    }
}
