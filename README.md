# OrcaX1

OrcaSlicer in the browser, served by a Bambu Lab X1 / X1C / X1E running
[X1Plus](https://github.com/X1Plus/X1Plus).

* **Slicing runs entirely in your browser.** The engine is OrcaSlicer 2.4.2
  compiled to WebAssembly ([OrcaWasm](https://github.com/Hiosdra/OrcaWasm)),
  with OrcaSlicer's own Bambu Lab system profiles for the X1 series.
* **The printer runs only `orcax1d`**, a small static Rust binary. It serves
  the page and bridges the browser to the printer's local services: MQTT
  (status and commands), the RTSPS camera (H.264 passed through as-is over
  WebRTC), and the SD card (upload, list, print). It does no slicing,
  transcoding or compression at runtime; static assets are stored gzipped
  (decompressed on the fly only for the rare client without gzip).

```
 browser ───────────────────────────────┐        printer (X1Plus)
 │ UI (Preact + three.js)               │  HTTPS  ┌──────────────┐  MQTT 8883 ─▶ printer
 │ slicer-worker → OrcaSlicer WASM ─────┼────────▶│   orcax1d    │  RTSPS 322 ─▶ camera
 │ G-code preview, 3MF export           │ WS, RTC │ (static ARM) │  /mnt/sdcard (FTPS 990 when remote)
 └──────────────────────────────────────┘         └──────────────┘
```

## What works

* Import STL / 3MF / OBJ / STEP, duplicate, multiple plates, Orca arrange
  and auto-orient, undo/redo (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y).
* Orca-style tools (left strip or M / R / S / F): move arrows, rotation rings
  with snap zones (drag out past the ring for 5° steps, further for 15°, or
  hold Shift), per-axis and uniform scale handles, lay on face, and
  numeric entry for position, move-by, rotation, rotate-by, scale % and size.
* Printer / process / filament presets from OrcaSlicer's BBL profiles
  (X1, X1C, X1E, all nozzle sizes). Every process setting of Orca's settings
  tab, with Orca's pages, groups, labels, tooltips, Simple / Advanced / Expert
  modes and rules for hiding or greying out options that don't apply,
  generated at build time from the OrcaSlicer sources the engine is built from;
  plus search and a raw editor for every key. Orca's Filament and Printer
  settings tabs are there too (the gear next to each filament, "Settings…"
  next to the printer), as slicer-only changes on top of the presets: they
  are never sent to the printer, and a tray's changes are dropped when its
  filament preset changes. Changes persist in the browser.
* The slicer mirrors the printer: the filament list is the AMS trays and
  external spool (one slot per tray, matched by Bambu filament id), and the
  printer model (from its discovery broadcast) and nozzle size and type are
  the ones the printer reports. Changing a filament
  or the nozzle in the slicer writes it to the printer after a confirmation.
* Multi-filament: per-object filament, flush volumes computed from the
  colors.
* Slicing with progress and cancel; toolpath preview by line type or
  filament, with a layer range slider; time, weight and cost stats.
* Printing: exports a Bambu `.gcode.3mf` (plate G-code, thumbnails, and the
  slice_info the firmware reads), uploads it to the SD card, and starts it
  with each filament printed from its own tray, bed leveling, flow calibration and timelapse options.
* Login with the printer's LAN access code or single sign-on through an
  OpenID Connect provider (Kanidm, Authelia, Keycloak, …), and an optional browser-trusted certificate from
  Let's Encrypt or any ACME CA via DNS-01 (Cloudflare, RFC 2136 / TSIG,
  acme-dns, DynDNS-style TXT updates such as Hurricane Electric), or dns-persist-01 with a TXT record you set up once by hand, so
  the printer never needs to be reachable from the internet.
* Device page: live camera, job progress (pause, resume, stop, speed), temps
  and fans, AMS trays (edit, load, unload, re-read RFID), jog, home, extrude,
  G-code console, SD card browser, HMS errors.

## Installing

Download the latest `orcax1-<version>.zip` from
[Releases](https://github.com/Doridian/OrcaX1/releases), unpack it to the
root of the printer's SD card (in a PC, or over the printer's FTPS server),
then over SSH run:

```sh
sh /mnt/sdcard/orcax1/install.sh
```

and open the `https://<printer-ip>/` address it prints. To upgrade, upload
a newer zip under Settings → Update (or unpack it and run `install.sh` the same
way). See [deploy/README.md](deploy/README.md) for details, including the
certificate warning.

## Building

Needs Node ≥ 20 and docker or podman (for the ARM cross build).

```sh
./scripts/build-all.sh     # engine + profiles + web/dist + dist/orcax1d-armv7
./scripts/deploy.sh <printer-ip>   # copy the build to the printer and run install.sh
./scripts/package.sh               # or: make the release zip in dist/
```

Then open `https://<printer-ip>/`, sign in with the printer's LAN access code, and
accept the self-signed certificate (or get a real one from Settings → HTTPS
certificate).
See [deploy/README.md](deploy/README.md) for the details. The browser needs
HTTPS (or `localhost`): the multithreaded engine requires
`SharedArrayBuffer`, which is only available in a secure context. The camera
uses WebRTC, which needs UDP port 8443 on the printer to be reachable from
the browser.

## Development against a real printer over LAN

You don't have to deploy to the printer while iterating. Run the daemon on
your PC in remote mode. It talks to the printer's LAN-mode services directly
(MQTT, RTSPS camera, FTPS for the SD card):

```sh
./scripts/fetch-engine.sh && node scripts/build-profiles.mjs
cd daemon && cargo run -- --no-tls --listen 127.0.0.1:8443 --state-dir ./state --printer 192.168.1.50 --access-code 12345678
# second terminal:
cd web && npm install && npm run dev      # http://localhost:5173 proxies /api → daemon
```

`ORCAX1_DAEMON=http://host:port npm run dev` points Vite at a daemon running
elsewhere, such as one already on the printer. The access code is shown on the
printer screen under Settings → Network (LAN mode).

In dev mode the browser console has `window.__orcax1` (project, settings and
slice state) for poking around.

## Layout

```
daemon/     orcax1d (Rust): static files, /api/ws MQTT bridge, /api/camera/whep, SD card files, /api/print,
            auth/ (login providers, sessions), acme/ (DNS-01 certificates)
web/        UI (Vite + Preact + three.js); public/slicer-worker.js hosts the WASM engine
scripts/    fetch-engine.sh, build-profiles.mjs (Orca BBL profiles → bundle), precompress, builds, deploy
deploy/     init script and install notes for X1Plus
docs/API.md daemon HTTP/WebSocket contract
```

## Notes and limitations

* The engine's C bridge does not collapse Bambu's per-nozzle-variant profile
  arrays, so the UI does that, using Orca's own option lists (`web/src/slicer/profiles.ts`).
* Flush volumes use a color-based approximation of Bambu Studio's calculator.
* Not yet implemented: paint-on supports/seams/colors, modifiers, cut,
  per-object setting overrides, sequential print-order editing, and
  calibration wizards.

## License

OrcaX1 is licensed under the [GNU Affero General Public License v3.0](LICENSE)
(`AGPL-3.0-only`), the same license as OrcaSlicer, whose engine (via OrcaWasm)
and profiles it ships. Because the daemon serves the app over a network, the
AGPL requires that anyone you let use a modified version be able to get its
source.
