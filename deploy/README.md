# Deploying orcax1d

`orcax1d` is a single static ARMv7 binary (`dist/orcax1d-armv7`, about 2 MB)
that runs on the printer's application processor under
[X1Plus](https://github.com/X1Plus/X1Plus). It serves the web UI over HTTPS
on port **8443** and redirects plain HTTP on port **8080** to it. Neither port
is used by Bambu's firmware (MQTT 8883, RTSPS 322, FTPS 990, ...) or by
X1Plus (its own HTTP server is on port 80).

## Layout on the printer

```
/mnt/sdcard/orcax1/orcax1d        the binary (copied to /tmp at start: the SD card is mounted noexec-style)
/mnt/sdcard/orcax1/www/           the web UI (contents of web/dist)
/mnt/sdcard/orcax1/state/         generated TLS CA + certificate
/mnt/sdcard/orcax1/orcax1d.conf   optional ORCAX1D_* overrides (shell syntax)
/etc/init.d/S99orcax1d            init script (persists in X1Plus's overlay)
/tmp/orcax1d.log                  log (previous run: /tmp/orcax1d.log.old)
```

## Build

```sh
scripts/build-daemon.sh        # cross-builds in podman/docker -> dist/orcax1d-armv7
(cd web && npm ci && npm run build)   # -> web/dist
```

## Install

With SSH enabled in X1Plus (root login):

```sh
scripts/deploy.sh 192.168.1.50
```

This copies the binary, `web/dist` and the init script, then restarts the
service. To do it by hand, copy the files to the layout above (for example by
putting the SD card in a PC: create `orcax1/`, copy `dist/orcax1d-armv7` to
`orcax1/orcax1d` and `web/dist/*` to `orcax1/www/`), then on the printer:

```sh
cat > /etc/init.d/S99orcax1d    # paste deploy/S99orcax1d, or copy it over ssh
chmod 755 /etc/init.d/S99orcax1d
/etc/init.d/S99orcax1d start
```

### Start at boot

X1Plus runs every `/etc/init.d/S??*` script at boot, and `/etc` lives in
X1Plus's persistent overlay, so installing `S99orcax1d` there is all that is
needed. Control it with `/etc/init.d/S99orcax1d {start|stop|restart}`.

The init script copies the binary from the SD card to `/tmp` and runs it at
nice level 10 with the defaults for the printer (MQTT on 127.0.0.1:8883,
access code from `/config/device/access_token`, serial from `bbl_3dpsn`, SD
card at `/mnt/sdcard`). Upgrading is just replacing the files on the SD card
and restarting.

## The certificate warning

The browser needs a secure context (HTTPS) for the slicer's
`SharedArrayBuffer` and for WebCodecs. On first start the daemon creates a
small local CA and a certificate for the printer's hostname and IPv4
addresses in `state/` (re-issued automatically if the IP changes).

Either:

* **Accept the warning once.** Open `https://<printer-ip>:8443/`, then
  "Advanced" → "Proceed" (Chrome/Edge) or "Accept the Risk and Continue"
  (Firefox). Safari: "Show Details" → "visit this website".
* **Or trust the CA** to get a clean padlock that survives IP changes:
  download `https://<printer-ip>:8443/api/ca.crt` and import it as a trusted
  root (Windows: double-click → Install → "Trusted Root Certification
  Authorities"; macOS: Keychain Access → System → set to "Always Trust";
  Firefox: Settings → Certificates → Authorities → Import; Android/iOS: install
  as a CA profile). The CA is unique to your printer; delete `state/` to
  regenerate it.

To use your own certificate instead, set `ORCAX1D_TLS_CERT` and
`ORCAX1D_TLS_KEY` in `orcax1d.conf`.

## Development: remote mode

For UI work the daemon can run on a PC and drive a real printer over LAN
mode, so you don't have to deploy to the printer on every change:

```sh
cd daemon
cargo run -- --printer 192.168.1.50 --access-code 12345678 --no-tls --web-root ../web/dist
# or: ORCAX1_PRINTER=192.168.1.50 ORCAX1_ACCESS_CODE=12345678 cargo run -- --no-tls --web-root ../web/dist
```

In remote mode MQTT goes to `<printer>:8883`, the camera to
`rtsps://<printer>:322/streaming/live/1`, the serial is learned from the first
MQTT report, and the file API (`/api/files*`, upload, and the md5 that
`/api/print` sends) uses the printer's FTPS server (implicit TLS on port 990,
user `bblp`, password = access code) instead of a local directory.
`/api/print` sends the same `project_file` command with
`url = file:///sdcard/<path>`; set `--print-url-prefix ftp:///` if your
firmware prefers that. `/api/info` reports `"mode":"remote"`.

The access code is shown on the printer's screen in the network settings.

Then either open `http://localhost:8443/` (localhost counts as a secure
context, so `--no-tls` is fine) or run the Vite dev server, which proxies
`/api` (including WebSockets) to `ORCAX1_DAEMON`, default
`http://127.0.0.1:8443`:

```sh
cd web && npm run dev      # or: ORCAX1_DAEMON=http://other-host:8443 npm run dev
```

Drop `--no-tls` to test HTTPS from other devices; the certificate then lives
in `--state-dir` (default `/mnt/sdcard/orcax1/state`, so pass e.g.
`--state-dir ./state` on a PC).

## Options

All flags have env var fallbacks; see `orcax1d --help`. Logging is controlled
by `ORCAX1D_LOG` (or `RUST_LOG`), e.g. `ORCAX1D_LOG=debug` or
`ORCAX1D_LOG=info,orcax1d=debug`.
