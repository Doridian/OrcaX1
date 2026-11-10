# Printer outlet

OrcaX1 can show the printer's power outlet with its live power draw, and
switch it on and off. This works even while the printer, and so OrcaX1
itself, is off: a browser that has opened OrcaX1 before is then sent to a
small page that can switch the printer on, and comes back to OrcaX1 as soon
as the printer is up.

```
 printer on:   browser ──HTTPS──▶ orcax1d ──HTTP──▶ ESPHome device ──▶ outlet
 printer off:  browser ──(service worker: printer doesn't answer)──▶
               http://<device>/orcax1 ──▶ outlet, then back to OrcaX1
```

It needs an ESPHome device that stays powered while the printer is off (any
ESP32 or ESP8266 that isn't plugged in behind that outlet) with the
`orcax1_outlet` component. That device does the switching, either by asking
Home Assistant (for any outlet HA has: Zigbee, Z-Wave, Wi-Fi, …) or by
switching its own relay if it is the smart plug itself.

**Turning the printer off needs an OrcaX1 login.** The device only switches
off for requests carrying its `off_token`, which only orcax1d has (it is
stored on the printer and never sent to a browser). Turning the printer on
needs no login: anyone on your network can do that from the device's page.

## Outlet in Home Assistant

Add this to the ESPHome device's YAML:

```yaml
packages:
  orcax1_outlet:
    url: https://github.com/Doridian/OrcaX1
    ref: main
    files:
      - path: deploy/esphome/orcax1-outlet.yaml
        vars:
          # The outlet's entities in Home Assistant
          outlet_switch: switch.printer_plug
          outlet_power: sensor.printer_plug_power
          # The address you open OrcaX1 at: scheme://host[:port]
          printer_url: https://192.168.1.50
          # A random secret, e.g. from `openssl rand -hex 24`
          off_token: !secret orcax1_off_token
```

and `orcax1_off_token: <the secret>` to your ESPHome `secrets.yaml`. The
package ([deploy/esphome/orcax1-outlet.yaml](../deploy/esphome/orcax1-outlet.yaml))
mirrors the switch and power sensor from Home Assistant (as internal
entities, so HA doesn't get copies) and switches the outlet through Home
Assistant actions.

Then, in Home Assistant, go to Settings → Devices & services → ESPHome → the
device → Configure and turn on **Allow the device to perform Home Assistant
actions**. Without it the device can show the outlet but not switch it.

## Plug running ESPHome

If the outlet itself runs ESPHome, use the component directly, with no Home
Assistant in between:

```yaml
external_components:
  - source:
      type: git
      url: https://github.com/Doridian/OrcaX1
      ref: main
      path: deploy/esphome/components
    components: [orcax1_outlet]

binary_sensor:
  - platform: template
    id: printer_relay_state
    lambda: return id(relay).state;   # your plug's relay switch

orcax1_outlet:
  printer_url: https://192.168.1.50
  state_id: printer_relay_state
  power_id: power                     # your plug's power sensor (W)
  off_token: !secret orcax1_off_token
  turn_on_action:
    - switch.turn_on: relay
  turn_off_action:
    - switch.turn_off: relay
```

`link_id` (optional) takes a binary sensor for the link to wherever switching
goes through; when it is off, OrcaX1 warns that the values may be stale. Leave
out `off_token` and `turn_off_action` to make the outlet impossible to switch
off from OrcaX1.

The component serves on the device's HTTP port (80): `/orcax1` (the page),
`/orcax1/state`, `POST /orcax1/on`, and `POST /orcax1/off` (only with
`Authorization: Bearer <off_token>`). It needs no `web_server`. If the device
has one with `include_internal: true`, the mirrored entities show there too,
but switching only goes through `/orcax1`.

## In OrcaX1

Under Settings → Printer outlet, enter the device's address
(`http://192.168.1.60` or `http://<name>.local`) and its `off_token`. The
outlet then shows in the top bar with its power draw and an on/off switch, and
the settings show any problem reaching it.

Each browser learns the device's address when it opens OrcaX1 while the
printer is on. After that, opening OrcaX1 while the printer doesn't answer
shows a "printer isn't responding" page, which goes on to the device's page
after a few seconds. There, switch the printer on; once it answers, the
browser goes back to OrcaX1.

## Limits

- **The "printer is off" page needs a certificate your browser trusts**
  (Settings → HTTPS certificate). It is served by a service worker, and
  browsers don't install service workers for a page with a certificate
  warning. With the self-signed certificate, the outlet still works while the
  printer is on, but a browser opening OrcaX1 while the printer is off just
  gets a connection error.
- The device's page is plain HTTP. Browsers in HTTPS-only mode (a Firefox
  setting) warn before opening it.
- The device's page switches the printer back to OrcaX1 by checking
  `printer_url`, so use the address you normally open OrcaX1 at.
- Values are polled (every 2 s in OrcaX1, every second on the device's page),
  so the power draw is at most that old, plus however often the outlet itself
  reports it.
