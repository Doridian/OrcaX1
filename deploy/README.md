# Deploying orcax1d

`orcax1d` is a single static ARMv7 binary (`dist/orcax1d-armv7`, about 6 MB)
that runs on the printer's application processor under
[X1Plus](https://github.com/X1Plus/X1Plus). It serves the web UI over HTTPS
on port **443** and redirects plain HTTP on ports **80** and **8080** to it. The WebRTC
camera uses **UDP 8443** (`ORCAX1D_WEBRTC_PORT`). None of these ports is
used by Bambu's firmware (MQTT 8883, RTSPS 322, FTPS 990, ...) or by
X1Plus (its own HTTP server is on port 80). If port 80 is already taken,
the daemon logs a warning and only redirects 8080. `ORCAX1D_REDIRECT_LISTEN`
(comma-separated) changes the list.

## Layout on the printer

```
/mnt/sdcard/orcax1/orcax1d        the release's binary (install.sh copies it to /userdata/orcax1)
/mnt/sdcard/orcax1/www/           the web UI (contents of web/dist)
/mnt/sdcard/orcax1/install.sh     installs/upgrades/uninstalls (run over SSH)
/mnt/sdcard/orcax1/S99orcax1d     init script (install.sh copies it to /etc/init.d)
/userdata/orcax1/orcax1d          the binary that runs (internal flash)
/userdata/orcax1/state/           generated TLS CA + certificate, login sessions, OIDC and ACME settings with their secrets
/userdata/orcax1/orcax1d.conf     optional ORCAX1D_* overrides (shell syntax)
/etc/init.d/S99orcax1d            init script (persists in X1Plus's overlay)
/tmp/orcax1d.log                  log (previous run: /tmp/orcax1d.log.old)
```

Everything on the SD card can be read and replaced by anyone with the LAN
access code, through the printer's FTPS server. That is why the binary that
runs as root, its configuration and every secret it keeps (certificate
keys, sessions, OIDC client secret, DNS API credentials) live on internal
flash under `/userdata/orcax1` instead.

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

To upgrade, open Settings → Update in the web UI and upload the new zip. The
daemon unpacks it into `orcax1/`, checks that the new binary runs, runs
`install.sh` and restarts (log: `/tmp/orcax1d-update.log`).
`/userdata/orcax1/state/` and `orcax1d.conf` are kept. Or do it by hand: unpack a newer zip over the old folder and run `install.sh`
again; it also deletes web files left over from the previous release (those
not in `www.manifest`). To remove OrcaX1, run
`sh /mnt/sdcard/orcax1/install.sh uninstall`, then delete
`/mnt/sdcard/orcax1` and `/userdata/orcax1`.

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

The init script runs `/userdata/orcax1/orcax1d` (put there by `install.sh`)
at nice level 10 with the defaults for the printer (MQTT on 127.0.0.1:8883,
access code from `/config/device/access_token`, serial from `bbl_3dpsn`, SD
card at `/mnt/sdcard`). It never runs anything from the SD card itself, so
replacing files there has no effect until `install.sh` is run (over SSH, or
by an update uploaded in the web UI).

## Logging in

The UI asks for the printer's **LAN access code** (printer screen → Settings
→ Network), the same code that protects the printer's MQTT, camera and FTPS
services. A login lasts 30 days (`ORCAX1D_SESSION_DAYS`) and ends early if
the access code is changed on the printer. `ORCAX1D_AUTH=none` disables
login (only do that on a network you fully trust).

### Single sign-on (OpenID Connect)

Settings → Single sign-on adds a "Sign in with …" button for an OpenID
Connect provider (Kanidm, Authelia, Keycloak, authentik, …). Register a
client whose redirect URL is `https://<printer address>/api/auth/oidc/callback`
(one per address you open the printer by; the settings page shows the one
for the current address), then enter the issuer, client ID and secret. With
Kanidm, for example:

```sh
kanidm system oauth2 create orcax1 "OrcaX1" https://printer.example.com
kanidm system oauth2 add-redirect-url orcax1 https://printer.example.com/api/auth/oidc/callback
kanidm system oauth2 update-scope-map orcax1 printer_users openid profile email groups
kanidm system oauth2 show-basic-secret orcax1
```

and use `https://<idm>/oauth2/openid/orcax1` as the issuer. Kanidm only
issues tokens to members of scope-mapped groups; the allowed users and
groups on the settings page can narrow it further. The claims used for the
user id, username and groups are configurable (defaults `sub`,
`preferred_username`, `groups`); pick a username claim users cannot change
themselves. With no allowed users or groups, anyone who can get a token for
the client gets in, so never leave both empty with a provider that hands
out tokens to anyone (Google, GitHub, …).
The access code login stays available unless you start the daemon with
`ORCAX1D_AUTH=oidc`. If the provider uses a private CA, point
`ORCAX1D_CA_FILE` at its PEM certificate.

## The certificate warning

The browser needs a secure context (HTTPS) for the slicer's
`SharedArrayBuffer`. On first start the daemon creates a
small local CA and a certificate for the printer's hostname and IPv4
addresses in `/userdata/orcax1/state/` (re-issued automatically if the IP
changes). The CA exists only to sign that certificate and is deliberately
not offered for download: **never install it as a trusted root** on your
devices. It is not limited to the printer's names, so anyone who got hold
of its key could impersonate any website to every device that trusts it.

Either:

* **Accept the warning once.** Open `https://<printer-ip>/`, then
  "Advanced" → "Proceed" (Chrome/Edge) or "Accept the Risk and Continue"
  (Firefox). Safari: "Show Details" → "visit this website".

* **Or get a real certificate** from Let's Encrypt (or another ACME CA) under
  Settings → HTTPS certificate, using a domain you control. Validation is
  by DNS TXT record (DNS-01) through Cloudflare, an RFC 2136 server (BIND,
  Knot, PowerDNS, … with a TSIG key), acme-dns or Hurricane Electric's
  dynamic TXT records, or with a persistent
  dns-persist-01 record you add by hand once (no DNS credentials on the
  printer; the CA must support it), so the printer stays off the internet.
  Point the name at the printer's LAN IP in your DNS and open
  `https://<name>/`. The certificate renews itself; opening the printer by
  IP still uses the self-signed one.

Whatever credentials you give the printer for DNS-01, **create a token
limited to exactly what it needs, never an account-wide key**: a Cloudflare
API token with only *Zone → DNS → Edit* on the one zone (better: a zone you
delegate `_acme-challenge` to), an RFC 2136 TSIG key whose update policy
only allows TXT records at `_acme-challenge.<name>`, an acme-dns account
(which can only ever set its own TXT record), or a dynamic TXT record's own
key. The same goes for the OpenID Connect client: register a client for
the printer alone. They are kept on internal flash, but anyone who gets
root on the printer can read them.

To use your own certificate instead, set `ORCAX1D_TLS_CERT` and
`ORCAX1D_TLS_KEY` in `/userdata/orcax1/orcax1d.conf` (keep the key on
`/userdata` too, not on the SD card).

## Development: remote mode

For UI work the daemon can run on a PC and drive a real printer over LAN
mode, so you don't have to deploy to the printer on every change:

```sh
cd daemon
cargo run -- --printer 192.168.1.50 --access-code 12345678 --no-tls --listen 127.0.0.1:8443 --state-dir ./state --web-root ../web/dist
# or: ORCAX1_PRINTER=192.168.1.50 ORCAX1_ACCESS_CODE=12345678 cargo run -- --no-tls --listen 127.0.0.1:8443 --state-dir ./state --web-root ../web/dist
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
in `--state-dir` (default `/userdata/orcax1/state`, so pass e.g.
`--state-dir ./state` on a PC).

## Port 443

The daemon runs as root from the init script, so it binds 443 directly (no
`setcap` needed). To use another port, set `ORCAX1D_LISTEN` in
`/userdata/orcax1/orcax1d.conf`, e.g. `ORCAX1D_LISTEN=0.0.0.0:8443`.

## Options

All flags have env var fallbacks; see `orcax1d --help`. Logging is controlled
by `ORCAX1D_LOG` (or `RUST_LOG`), e.g. `ORCAX1D_LOG=debug` or
`ORCAX1D_LOG=info,orcax1d=debug`.
