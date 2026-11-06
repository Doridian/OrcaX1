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

Everything under `/api/` needs a login except `/api/auth/*` and
`/api/ca.crt`; without one it answers `401 {"error":"not logged in"}` (the
WebSocket upgrade too). Static files are public, so the login page can load.
`--auth none` turns authentication off.

## Authentication

Login methods are pluggable providers (`daemon/src/auth/`). The only one so
far is `access-code`: the printer's LAN access code, the same secret that
guards its MQTT, camera and FTPS. A successful login sets an HttpOnly,
`SameSite=Strict` session cookie (`__Host-orcax1_session` over HTTPS,
`orcax1_session` with `--no-tls`) valid for `--session-days` (default 30).
Sessions survive daemon restarts (only their SHA-256 is stored, in
`<state-dir>/sessions.json`) and stop working when the access code changes.
A wrong code is answered after a 1 s delay.

### `GET /api/auth/status`

```json
{
  "enabled": true,                // false with --auth none
  "authenticated": false,
  "user": null,                   // {"provider":"access-code","name":"LAN access code","expires":1796514134}
  "providers": [
    {"id":"access-code","kind":"secret","label":"LAN access code","field":"Access code","hint":"…"}
  ]
}
```

`kind: "secret"` means a one-field form; its value is posted as `secret`.
(A future redirect-based provider such as OIDC would use
`{"kind":"redirect","url":…}` and its own callback route.)

### `POST /api/auth/login`

Body `{"provider":"access-code","secret":"12345678"}`. → `200` with the
status object and `Set-Cookie`; `401` for a wrong code; `503` if the daemon
can't read the access code.

### `POST /api/auth/logout`

Ends the session and clears the cookie. → the status object.

Errors from `/api/*` endpoints are JSON: `{"error":"message"}` with a 4xx/5xx
status (400 bad path, 404 not found, 409 conflict such as a non-empty
directory, 502 printer FTP failure in remote mode, 503 MQTT not connected).

## Static files

`GET /<path>` serves files from the web root. To save SD card space and
writes, the build stores compressible assets only gzipped (`<path>.gz`, no
uncompressed copy; see `scripts/precompress.mjs`). When only `<path>.gz`
exists, clients that accept `gzip` get it as-is with `Content-Encoding: gzip`;
others get it decompressed on the fly (chunked, no `Content-Length`). The
`Content-Type` always comes from the requested name. Unknown paths without a
file extension fall back to `index.html`. `.wasm` is served as
`application/wasm`.

## `GET /api/info`

```json
{
  "name": "orcax1d",
  "version": "0.1.0",
  "serial": "00M00A000000000",   // null until known
  "mqtt_connected": true,
  "camera_available": true,           // false after the last upstream camera attempt failed
  "camera_error": null,               // why the last upstream camera attempt failed, if it did
  "mode": "local",                    // "local" (on the printer) or "remote" (dev PC, --printer)
  "sd_dir": "/mnt/sdcard"             // remote mode: "ftps://<printer>:990/"
}
```

## `GET /api/ca.crt`

The local CA that signed the daemon's self-signed HTTPS certificate (DER,
`application/x-x509-ca-cert`). Installing it as a trusted root removes the
browser warning. 404 when `--tls-cert` is used or in `--no-tls` mode. No
login needed.

## ACME certificates

The daemon can get a certificate from Let's Encrypt or any ACME CA using the
DNS-01 challenge, so the printer never has to be reachable from the
internet. It is served when the client's SNI matches one of its names
(exact, or `*.` for one label); connections by IP address or other names
keep the self-signed (or `--tls-cert`) certificate. With `enabled`, the
daemon checks hourly and requests a new certificate 30 days before expiry,
or when the domains or CA change (after a failure it waits 6 h).

DNS providers (`daemon/src/acme/dns/`): `cloudflare` (API token),
`rfc2136` (dynamic update with a TSIG key; BIND, Knot, PowerDNS, …),
`acme-dns` and `dyndns` (DynDNS2 `/nic/update` with `txt=`, e.g. Hurricane
Electric; the `_acme-challenge` records must already exist with dynamic DNS
enabled). Each describes its settings form in `providers[].fields`.
Providers with `single_value` hold one TXT value per name, so names that
share a record (`example.com` and `*.example.com`) are validated one after
another.

`persist` (`"persistent": true`) uses dns-persist-01 instead
(draft-ietf-acme-dns-persist): the user adds a lasting TXT record at
`_validation-persist.<domain>` once, containing
`<issuer>; accounturi=<account URL>` (plus `; policy=wildcard` when a
wildcard is among the names), and no DNS credentials are stored. The issuer
domain defaults to `letsencrypt.org` for Let's Encrypt; set `dns.issuer` for
other CAs. The CA must offer the dns-persist-01 challenge.
`--acme-ca-file` adds trusted roots for the CA and DNS APIs (e.g. a private
step-ca); otherwise the bundled Mozilla roots are used.

State lives in `<state-dir>/acme/`: `config.json` (including DNS
credentials), `account.json`, `cert.pem`, `key.pem`, `cert.json`.

### `GET /api/acme`

```json
{
  "config": {
    "enabled": true,
    "directory": "https://acme-v02.api.letsencrypt.org/directory",
    "email": "",
    "domains": ["printer.example.com"],
    "eab_kid": "", "eab_hmac": "",        // external account binding, for CAs that need it
    "dns_provider": "cloudflare",
    "dns": {"api_token": ""},             // provider settings; secrets blanked
    "propagation_seconds": 30
  },
  "secrets_set": ["dns.api_token"],      // secrets that are saved but not returned
  "providers": [{"id":"cloudflare","label":"Cloudflare","help":"…",
                 "fields":[{"key":"api_token","label":"API token","secret":true,"required":true}, …]}, …],
  "directories": [{"label":"Let's Encrypt","url":"…","eab":false}, …],
  "tls": true,                           // false with --no-tls: a certificate is saved but not served
  "cert": {"domains":[…],"directory":"…","issued_at":1793922439,"not_after":1801698438},   // or null
  "status": {"running":false,"last_attempt":…,"last_success":…,"last_error":null,
             "log":[[1793922437,"ordering a certificate for printer.example.com"], …]},
  "persist": null                        // with the persist provider saved:
                                         // {"account":"https://…/acct/123" or null,
                                         //  "records":[{"name":"_validation-persist.printer.example.com",
                                         //              "value":"letsencrypt.org; accounturi=https://…/acct/123"}],
                                         //  "error":null}   // e.g. the CA's issuer domain is unknown
}
```

### `PUT /api/acme`

Body `{"config":{…},"issue":false}`. Empty secret fields keep their saved
value (for the same provider). With `"issue":true` a request starts right
away. → `200` with the view above; `400` for an invalid config.

### `POST /api/acme/issue`

Requests a certificate now with the saved config, in the background. → `202`
with the view (poll `GET /api/acme` while `status.running`); `409` if one is
already running.

### `POST /api/acme/account`

Creates the ACME account for the saved config (or loads the saved one) so
the dns-persist-01 records can be set up before the first request. Accepts
the CA's terms of service. → `200` with the view; `502` if the CA refuses;
`409` while a request is running.

### `DELETE /api/acme/cert`

Deletes the certificate, goes back to the default certificate, and turns
off `enabled`. Does not revoke.

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

## Live camera

The daemon pulls the printer's RTSPS stream
(`rtsps://bblp:<code>@127.0.0.1:322/streaming/live/1`), depacketizes the
H.264 RTP stream, and forwards access units to WebRTC viewers. It does not
transcode. It keeps one upstream RTSP session while at least one viewer is
connected, and closes it 5 s after the last one leaves. Upstream failures are
retried with backoff while viewers stay connected; the reason is reported as
`camera_error` in `/api/info`.

### `POST /api/camera/whep`: WebRTC (WHEP, RFC 9725)

Body: an SDP offer (`application/sdp`) with a `recvonly` video m-line
offering H.264 with `packetization-mode=1`. Response `201 Created` with the
SDP answer and `Location: /api/camera/whep/<id>`. `DELETE` that location to
end the session; the daemon also drops a viewer whose ICE checks stop.

* The daemon is an ICE-lite peer. Its answer carries host candidates only:
  one UDP socket per local address, all on `--webrtc-port` (default 8443).
  No STUN/TURN, so the browser must be able to reach one of the printer's
  addresses over UDP.
* The answer picks the H.264 payload type matching the camera's profile when
  the offer has one. Media starts at the next keyframe after DTLS completes.
  The browser's NACKs are answered from the send buffer (RTX); keyframe
  requests (PLI/FIR) are ignored, since the camera's GOP can't be forced.
* Offers are accepted while the camera is failing, so the viewer's session
  keeps the upstream retrying; video starts once the camera recovers.
* Errors (JSON `{"error":"…"}`): 400 for an unusable offer, 503 when 8
  viewers are already connected or no UDP socket could be bound.

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
