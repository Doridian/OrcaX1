# Deploying orcax1d

`orcax1d` is a single static ARMv7 binary (`dist/orcax1d-armv7`, about 6 MB)
that runs on the printer's application processor under
[X1Plus](https://github.com/X1Plus/X1Plus). It serves the web UI over HTTPS
on port **8443** and redirects plain HTTP on port **8080** to it. The WebRTC
camera uses **UDP 8443** (`ORCAX1D_WEBRTC_PORT`). None of these ports is
used by Bambu's firmware (MQTT 8883, RTSPS 322, FTPS 990, ...) or by
X1Plus (its own HTTP server is on port 80).

## Layout on the printer

```
/mnt/sdcard/orcax1/orcax1d        the binary (copied to /userdata/bin at start: the SD card is mounted noexec-style)
/userdata/bin/orcax1d             the copy that runs (internal flash; refreshed only when it differs)
/mnt/sdcard/orcax1/www/           the web UI (contents of web/dist)
/mnt/sdcard/orcax1/install.sh     installs/upgrades/uninstalls (run over SSH)
/mnt/sdcard/orcax1/S99orcax1d     init script (install.sh copies it to /etc/init.d)
/mnt/sdcard/orcax1/state/         generated TLS CA + certificate
/mnt/sdcard/orcax1/orcax1d.conf   optional ORCAX1D_* overrides (shell syntax)
/etc/init.d/S99orcax1d            init script (persists in X1Plus's overlay)
/tmp/orcax1d.log                  log (previous run: /tmp/orcax1d.log.old)
```

## Install from a release

You need X1Plus with SSH enabled (root login).

1. Download `orcax1-<version>.zip` from
   [Releases](https://github.com/Doridian/OrcaX1/releases) and unpack it to
   the root of the SD card, giving the `orcax1/` folder above. Either put the
   card in a PC, or upload the unpacked `orcax1` folder with an FTP client:
   FTPS with implicit TLS on port 990, user `bblp`, password = the LAN access
   code (printer screen, Settings → Network).
2. Over SSH:

   ```sh
   sh /mnt/sdcard/orcax1/install.sh
   ```

   This installs the init script into `/etc/init.d`, (re)starts the daemon,
   checks that it stayed up (printing the log if not), and prints the URL.

To upgrade, unpack a newer zip over the old folder and run `install.sh`
again; it also deletes web files left over from the previous release (those
not in `www.manifest`). To remove OrcaX1, run
`sh /mnt/sdcard/orcax1/install.sh uninstall`, then delete the folder.

## Install from a local build

```sh
scripts/build-all.sh           # -> dist/orcax1d-armv7 + web/dist
scripts/deploy.sh 192.168.1.50
```

`deploy.sh` copies the binary, `web/dist`, the init script and `install.sh`
to the SD card over SSH and runs `install.sh`. `scripts/package.sh` builds
the same zip CI attaches to releases (`dist/orcax1-<version>.zip`).

### Start at boot

X1Plus runs every `/etc/init.d/S??*` script at boot, and `/etc` lives in
X1Plus's persistent overlay, so installing `S99orcax1d` there is all that is
needed. Control it with `/etc/init.d/S99orcax1d {start|stop|restart}`.

The init script copies the binary from the SD card to `/userdata/bin`
(internal flash, created if missing; skipped when already identical) and runs it at
nice level 10 with the defaults for the printer (MQTT on 127.0.0.1:8883,
access code from `/config/device/access_token`, serial from `bbl_3dpsn`, SD
card at `/mnt/sdcard`). Upgrading is just replacing the files on the SD card
and restarting.

## The certificate warning

The browser needs a secure context (HTTPS) for the slicer's
`SharedArrayBuffer`. On first start the daemon creates a
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
