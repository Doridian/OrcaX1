#include "orcax1_outlet.h"

#include <cmath>
#include <cstring>

#include "esphome/core/log.h"

namespace esphome::orcax1_outlet {

static const char *const TAG = "orcax1_outlet";

// The URL without query string, as a std::string on every platform.
static std::string request_url(AsyncWebServerRequest *request) {
#ifdef USE_ESP32
  char url_buf[AsyncWebServerRequest::URL_BUF_SIZE];
  StringRef url = request->url_to(url_buf);
  return std::string(url.c_str(), url.size());
#else
  return std::string(request->url().c_str());
#endif
}

static std::string request_header(AsyncWebServerRequest *request, const char *name) {
#ifdef USE_ESP32
  auto value = request->get_header(name);
  return value.has_value() ? *value : std::string();
#else
  const AsyncWebHeader *header = request->getHeader(name);
  return header != nullptr ? std::string(header->value().c_str()) : std::string();
#endif
}

void OrcaX1Outlet::setup() {
  this->base_->init();
  this->base_->add_handler(this);
}

void OrcaX1Outlet::dump_config() {
  ESP_LOGCONFIG(TAG,
                "OrcaX1 outlet: /orcax1\n"
                "  Printer: %s\n"
                "  Turning off: %s",
                this->printer_url_, this->off_token_ != nullptr ? "with token" : "disabled");
}

bool OrcaX1Outlet::canHandle(AsyncWebServerRequest *request) const {
  const std::string url = request_url(request);
  if (request->method() == HTTP_GET)
    return url == "/orcax1" || url == "/orcax1/" || url == "/orcax1/state";
  if (request->method() == HTTP_POST)
    return url == "/orcax1/on" || url == "/orcax1/off";
  return false;
}

static void append_json_string(std::string &out, const char *s) {
  out += '"';
  for (; *s != '\0'; s++) {
    const char c = *s;
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      char buf[8];
      snprintf(buf, sizeof(buf), "\\u%04x", c);
      out += buf;
    } else {
      out += c;
    }
  }
  out += '"';
}

std::string OrcaX1Outlet::state_json_() const {
  std::string out = "{\"printer\":";
  append_json_string(out, this->printer_url_);
  out += ",\"on\":";
  out += this->state_->has_state() ? (this->state_->state ? "true" : "false") : "null";
  out += ",\"power\":";
  const float w = this->power_->state;
  if (std::isfinite(w)) {
    char buf[24];
    snprintf(buf, sizeof(buf), "%.1f", w);
    out += buf;
  } else {
    out += "null";
  }
  out += ",\"linked\":";
  if (this->link_ != nullptr && this->link_->has_state()) {
    out += this->link_->state ? "true" : "false";
  } else {
    out += "null";
  }
  out += ",\"can_turn_off\":";
  out += this->off_token_ != nullptr ? "true" : "false";
  out += '}';
  return out;
}

// Browsers send Origin on cross-origin POSTs. Refuse those, so another web
// page can't switch the printer on through a visitor's browser. orcax1d
// sends no Origin; this device's own page sends its own.
bool OrcaX1Outlet::same_origin_(AsyncWebServerRequest *request) const {
  const std::string origin = request_header(request, "Origin");
  if (origin.empty())
    return true;
  const std::string host = request_header(request, "Host");
  return !host.empty() && origin == "http://" + host;
}

bool OrcaX1Outlet::token_ok_(AsyncWebServerRequest *request) const {
  if (this->off_token_ == nullptr)
    return false;
  const std::string auth = request_header(request, "Authorization");
  static const char PREFIX[] = "Bearer ";
  const size_t prefix_len = sizeof(PREFIX) - 1;
  const size_t token_len = strlen(this->off_token_);
  if (auth.size() != prefix_len + token_len || auth.compare(0, prefix_len, PREFIX) != 0)
    return false;
  // Constant time over the token.
  uint8_t diff = 0;
  for (size_t i = 0; i < token_len; i++)
    diff |= static_cast<uint8_t>(auth[prefix_len + i] ^ this->off_token_[i]);
  return diff == 0;
}

void OrcaX1Outlet::send_status_(AsyncWebServerRequest *request, int code, const char *error) {
  std::string body;
  if (error != nullptr) {
    body = "{\"error\":";
    append_json_string(body, error);
    body += '}';
  } else {
    body = this->state_json_();
  }
  auto *response = request->beginResponse(code, "application/json", body.c_str());
  response->addHeader("Cache-Control", "no-store");
  request->send(response);
}

void OrcaX1Outlet::handleRequest(AsyncWebServerRequest *request) {
  const std::string url = request_url(request);
  if (url == "/orcax1/state") {
    this->send_status_(request, 200, nullptr);
    return;
  }
  if (url == "/orcax1/on" || url == "/orcax1/off") {
    if (!this->same_origin_(request)) {
      this->send_status_(request, 403, "cross-origin request refused");
      return;
    }
    if (url == "/orcax1/on") {
      ESP_LOGI(TAG, "Turning the printer outlet on");
      this->turn_on_trigger_.trigger();
    } else if (this->off_token_ == nullptr) {
      this->send_status_(request, 403, "turning off is disabled on this device");
      return;
    } else if (!this->token_ok_(request)) {
      ESP_LOGW(TAG, "Refused to turn the printer outlet off: bad or missing token");
      this->send_status_(request, 401, "turning off needs orcax1d's token");
      return;
    } else {
      ESP_LOGI(TAG, "Turning the printer outlet off");
      this->turn_off_trigger_.trigger();
    }
    // Accepted: the state changes once the outlet reports it.
    this->send_status_(request, 202, nullptr);
    return;
  }
#ifdef USE_ORCAX1_OUTLET_PROGMEM
  auto *response = request->beginResponse_P(200, "text/html", this->page_, this->page_len_);
#else
  auto *response = request->beginResponse(200, "text/html", this->page_, this->page_len_);
#endif
  response->addHeader("Content-Encoding", "gzip");
  response->addHeader("Cache-Control", "no-cache");
  request->send(response);
}

}  // namespace esphome::orcax1_outlet
