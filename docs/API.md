# orcax1d HTTP API

`orcax1d` is the daemon that runs on the printer. It serves the web UI and
bridges the UI to the printer's local services. All slicing happens in the
browser. The daemon only moves bytes.

The UI needs `SharedArrayBuffer`, which in turn needs a secure context, so the
daemon serves HTTPS by default. It uses a self-signed certificate unless one is
supplied. Every response carries:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

No authentication (for now).

Errors from `/api/*` endpoints are JSON: `{"error":"message"}` with a 4xx/5xx
status (400 bad path, 404 not found, 409 conflict such as a non-empty
directory, 502 printer FTP failure in remote mode, 503 MQTT not connected).

## Static files

`GET /<path>` serves files from the web root. If the client accepts `br` or
`gzip` and `<path>.br` / `<path>.gz` exists, the daemon serves that file with
`Content-Encoding` set and the original file's `Content-Type`. Unknown paths
without a file extension fall back to `index.html`. `.wasm` is served as
`application/wasm`.

## `GET /api/info`

```json
{
  "name": "orcax1d",
  "version": "0.1.0",
  "serial": "00M00A000000000",   // null until known
  "mqtt_connected": true,
  "camera_available": true,           // false after the last upstream camera attempt failed
  "mode": "local",                    // "local" (on the printer) or "remote" (dev PC, --printer)
  "sd_dir": "/mnt/sdcard"             // remote mode: "ftps://<printer>:990/"
}
```

## `GET /api/ca.crt`

The local CA that signed the daemon's self-signed HTTPS certificate (DER,
`application/x-x509-ca-cert`). Installing it as a trusted root removes the
browser warning. 404 when `--tls-cert` is used or in `--no-tls` mode.

## `GET /api/ws`: printer state and commands (WebSocket, JSON text frames)

Server → client:

| message | when |
|---|---|
| `{"type":"hello","serial":"…","mqtt_connected":bool}` | first message |
| `{"type":"status","data":{…}}` | right after `hello` if a status is cached: the last merged `print` object (`push_status`) |
| `{"type":"report","data":{…}}` | each message the printer publishes on `device/<sn>/report`, verbatim |
| `{"type":"mqtt","connected":bool}` | MQTT connection state changes |
| `{"type":"error","message":"…"}` | client sent something invalid |

The daemon keeps a merged copy of the last `print.push_status` (deep-merge,
so partial pushes don't drop `ams`, `vt_tray`, `ipcam` and so on) and sends a
`pushall` request when MQTT connects.

Client → server:

```json
{"type":"request","data":{"print":{"command":"pause","param":""}}}
```

`data` is published to `device/<sn>/request`. If the inner object (the single
top-level key, e.g. `print`, `system`, `pushing`) has no `sequence_id`, the
daemon fills one in.

## `GET /api/camera`: live camera (WebSocket)

The daemon pulls the printer's RTSPS stream
(`rtsps://bblp:<code>@127.0.0.1:322/streaming/live/1`), depacketizes the
H.264 RTP stream, and forwards access units. It does not transcode. It keeps
one upstream RTSP session while at least one client is connected, and closes it
when the last one leaves.

* First a text frame: `{"type":"config","codec":"avc1.PPCCLL"}`, with the
  codec string built from the SPS profile, constraint and level bytes. It is
  sent again if the SPS changes.
* Then binary frames, one per access unit:
  * byte 0: flags, bit 0 = keyframe (IDR)
  * bytes 1..9: u64 big-endian timestamp in microseconds (from the RTP clock)
  * rest: Annex-B access unit (`00 00 00 01` start codes). Keyframes are
    always prefixed with the current SPS and PPS.
* A new client receives nothing until the next keyframe.
* `{"type":"error","message":"…"}` text frames report upstream problems. The
  daemon retries, and the socket stays open.

## Files on the SD card

All `path` parameters are relative to the SD root (`--sd-dir`, default
`/mnt/sdcard`). `..` and absolute escapes are rejected with 400.

In remote mode (`--printer <ip>`, for development on a PC) the same endpoints
are served from the printer's FTPS server (implicit TLS on port 990, whose
root is the SD card root) instead of the local filesystem. Behaviour is the
same, except that `mtime` has only minute precision when the server lacks
MLSD and `download` may omit `Content-Length` if the server doesn't support
`SIZE`.

* `GET /api/files?path=<dir>` →
  `[{"name":"a.3mf","is_dir":false,"size":123,"mtime":1730000000}]`
* `GET /api/files/download?path=<file>` → file bytes (`Content-Disposition: attachment`)
* `DELETE /api/files?path=<file-or-empty-dir>` → `204`
* `PUT /api/files/upload?path=<file>`: raw request body (no multipart),
  streamed to `<file>.part` and then renamed. Creates parent dirs. →
  `{"path":"…","size":123,"md5":"hex"}`

## `POST /api/print`

Starts printing a sliced Bambu project (`.gcode.3mf` / `.3mf` with
`Metadata/plate_N.gcode`) that is already on the SD card.

```json
{
  "path": "orcax1/model.gcode.3mf",   // relative to the SD root
  "plate": 1,                          // 1-based
  "use_ams": true,
  "ams_mapping": [0, 2],               // per project filament: global tray id (ams*4+slot), 254 = external spool, -1 = unused
  "timelapse": false,
  "bed_leveling": true,
  "flow_cali": false,
  "vibration_cali": false,
  "layer_inspect": false,
  "bed_type": "auto"
}
```

Only `path` is required. Defaults: `plate` 1, `use_ams` true iff
`ams_mapping` is non-empty, `ams_mapping` `[]`, `bed_leveling` true,
`bed_type` `"auto"`, everything else false.

The daemon computes the md5 (in remote mode by reading the file back over
FTPS) and publishes:

```json
{"print":{"command":"project_file","sequence_id":"…","param":"Metadata/plate_1.gcode",
 "url":"file:///sdcard/orcax1/model.gcode.3mf","md5":"…","file":"","subtask_name":"model",
 "project_id":"0","profile_id":"0","task_id":"0","subtask_id":"0",
 "timelapse":false,"bed_type":"auto","bed_levelling":true,"flow_cali":false,
 "vibration_cali":false,"layer_inspect":false,"use_ams":true,
 "ams_mapping":[0,2],"ams_mapping2":[{"ams_id":0,"slot_id":0},{"ams_id":0,"slot_id":2}]}}
```

The URL prefix is configurable (`--print-url-prefix`, default
`file:///sdcard/`). In `ams_mapping2`, tray 254 maps to
`{"ams_id":255,"slot_id":0}` and -1 maps to `{"ams_id":255,"slot_id":255}`.

→ `{"ok":true,"request":{…published payload…}}`
