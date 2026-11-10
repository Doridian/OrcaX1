#pragma once

#include <string>

#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/components/web_server_base/web_server_base.h"
#include "esphome/core/automation.h"
#include "esphome/core/component.h"

namespace esphome::orcax1_outlet {

/// HTTP endpoints under /orcax1 (see __init__.py).
class OrcaX1Outlet : public Component, public AsyncWebHandler {
 public:
  explicit OrcaX1Outlet(web_server_base::WebServerBase *base) : base_(base) {}

  void set_page(const uint8_t *data, size_t len) {
    this->page_ = data;
    this->page_len_ = len;
  }
  void set_printer_url(const char *url) { this->printer_url_ = url; }
  void set_state(binary_sensor::BinarySensor *s) { this->state_ = s; }
  void set_power(sensor::Sensor *s) { this->power_ = s; }
  void set_link(binary_sensor::BinarySensor *s) { this->link_ = s; }
  void set_off_token(const char *token) { this->off_token_ = token; }
  Trigger<> *get_turn_on_trigger() { return &this->turn_on_trigger_; }
  Trigger<> *get_turn_off_trigger() { return &this->turn_off_trigger_; }

  void setup() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::WIFI - 1.0f; }

  bool canHandle(AsyncWebServerRequest *request) const override;
  void handleRequest(AsyncWebServerRequest *request) override;

 protected:
  std::string state_json_() const;
  bool same_origin_(AsyncWebServerRequest *request) const;
  bool token_ok_(AsyncWebServerRequest *request) const;
  void send_status_(AsyncWebServerRequest *request, int code, const char *error);

  web_server_base::WebServerBase *base_;
  const uint8_t *page_{nullptr};
  size_t page_len_{0};
  const char *printer_url_{""};
  binary_sensor::BinarySensor *state_{nullptr};
  sensor::Sensor *power_{nullptr};
  binary_sensor::BinarySensor *link_{nullptr};
  const char *off_token_{nullptr};
  Trigger<> turn_on_trigger_;
  Trigger<> turn_off_trigger_;
};

}  // namespace esphome::orcax1_outlet
