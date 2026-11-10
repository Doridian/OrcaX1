"""OrcaX1 printer outlet.

Lets OrcaX1 show and switch the printer's power outlet, including while the
printer (and so OrcaX1's daemon) is off. Serves on the device's HTTP port:

- GET  /orcax1        a small page to switch the printer on. OrcaX1's
                      service worker sends the browser here when the printer
                      doesn't answer; the page is plain HTTP like the device,
                      so unlike the HTTPS OrcaX1 page it may talk to the
                      device in every browser. It goes back to OrcaX1 once
                      the printer is up.
- GET  /orcax1/state  {"printer", "on", "power", "linked", "can_turn_off"}
- POST /orcax1/on     runs turn_on_action. Open to the LAN: harmless.
- POST /orcax1/off    runs turn_off_action, only with
                      "Authorization: Bearer <off_token>". Only orcax1d has
                      the token, so turning the printer off needs an OrcaX1
                      login. Without off_token, the outlet can't be switched
                      off from here at all.

Needs no web_server (and none of the device's entities have to be exposed).
"""

import gzip
from pathlib import Path

import esphome.codegen as cg
from esphome import automation
from esphome.components import binary_sensor, sensor, web_server_base
from esphome.components.web_server_base import CONF_WEB_SERVER_BASE_ID
import esphome.config_validation as cv
from esphome.const import (
    CONF_ID,
    CONF_RAW_DATA_ID,
    CONF_TURN_OFF_ACTION,
    CONF_TURN_ON_ACTION,
)
from esphome.core import CORE

CODEOWNERS = ["@Doridian"]
DEPENDENCIES = ["network"]
AUTO_LOAD = ["web_server_base"]

CONF_PRINTER_URL = "printer_url"
CONF_STATE_ID = "state_id"
CONF_POWER_ID = "power_id"
CONF_LINK_ID = "link_id"
CONF_OFF_TOKEN = "off_token"

orcax1_outlet_ns = cg.esphome_ns.namespace("orcax1_outlet")
OrcaX1Outlet = orcax1_outlet_ns.class_("OrcaX1Outlet", cg.Component)


def validate_printer_url(value):
    value = cv.url(value).rstrip("/")
    if not value.startswith(("https://", "http://")):
        raise cv.Invalid("printer_url must be an http(s):// URL")
    return value


def validate_token(value):
    value = cv.string_strict(value)
    if len(value) < 16:
        raise cv.Invalid("off_token must be at least 16 characters")
    if not all(33 <= ord(c) < 127 for c in value):
        raise cv.Invalid("off_token must be printable ASCII without spaces")
    return value


def _consume_sockets(config):
    from esphome.components import socket

    # The page's polling plus orcax1d's.
    socket.consume_sockets(2, "orcax1_outlet")(config)
    return config


CONFIG_SCHEMA = cv.All(
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(OrcaX1Outlet),
            cv.GenerateID(CONF_WEB_SERVER_BASE_ID): cv.use_id(
                web_server_base.WebServerBase
            ),
            cv.GenerateID(CONF_RAW_DATA_ID): cv.declare_id(cg.uint8),
            # Where OrcaX1 is opened, e.g. https://192.168.1.50. The page
            # checks it to see when the printer is up, then goes back there.
            cv.Required(CONF_PRINTER_URL): validate_printer_url,
            # Whether the outlet is on (no state: unknown).
            cv.Required(CONF_STATE_ID): cv.use_id(binary_sensor.BinarySensor),
            # Its power draw in W.
            cv.Required(CONF_POWER_ID): cv.use_id(sensor.Sensor),
            # Optional link to wherever state and switching go through (e.g.
            # Home Assistant): when off, the UI warns that values are stale.
            cv.Optional(CONF_LINK_ID): cv.use_id(binary_sensor.BinarySensor),
            cv.Required(CONF_TURN_ON_ACTION): automation.validate_automation(
                single=True
            ),
            cv.Optional(CONF_TURN_OFF_ACTION): automation.validate_automation(
                single=True
            ),
            cv.Optional(CONF_OFF_TOKEN): cv.sensitive(validate_token),
        }
    ).extend(cv.COMPONENT_SCHEMA),
    cv.has_none_or_all_keys(CONF_TURN_OFF_ACTION, CONF_OFF_TOKEN),
    _consume_sockets,
)


async def to_code(config):
    base = await cg.get_variable(config[CONF_WEB_SERVER_BASE_ID])
    var = cg.new_Pvariable(config[CONF_ID], base)
    await cg.register_component(var, config)

    html = (Path(__file__).parent / "page.html").read_bytes()
    # mtime=0: the same input gives the same bytes, so builds are reproducible.
    data = gzip.compress(html, compresslevel=9, mtime=0)
    page = cg.progmem_array(config[CONF_RAW_DATA_ID], list(data))
    cg.add(var.set_page(page, len(data)))

    cg.add(var.set_printer_url(config[CONF_PRINTER_URL]))
    cg.add(var.set_state(await cg.get_variable(config[CONF_STATE_ID])))
    cg.add(var.set_power(await cg.get_variable(config[CONF_POWER_ID])))
    if CONF_LINK_ID in config:
        cg.add(var.set_link(await cg.get_variable(config[CONF_LINK_ID])))
    await automation.build_automation(
        var.get_turn_on_trigger(), [], config[CONF_TURN_ON_ACTION]
    )
    if CONF_TURN_OFF_ACTION in config:
        await automation.build_automation(
            var.get_turn_off_trigger(), [], config[CONF_TURN_OFF_ACTION]
        )
        cg.add(var.set_off_token(config[CONF_OFF_TOKEN]))
    if CORE.is_esp8266:
        cg.add_define("USE_ORCAX1_OUTLET_PROGMEM")
