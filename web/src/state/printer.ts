// Connection to orcax1d's /api/ws: live printer status and MQTT commands.
import { computed, signal } from '@preact/signals'
import { refreshAuth } from './auth'

export type Status = Record<string, any>

export const wsConnected = signal(false)
export const mqttConnected = signal(false)
export const serial = signal<string | null>(null)
/** Bambu model id the printer announces over SSDP (BL-P001 = X1 Carbon, BL-P002 = X1, C13 = X1E). */
export const modelId = signal<string | null>(null)
export const status = signal<Status>({})
export const lastReports = signal<{ t: number; data: any }[]>([])
export const commandLog = signal<{ t: number; text: string; ok: boolean | null }[]>([])

let ws: WebSocket | null = null
let retry = 0
let wanted = false

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
export function deepMerge(a: Status, b: Status): Status {
  const out: Status = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  return out
}

function onReport(data: any) {
  if (isObj(data.print) && data.print.command === 'push_status') {
    status.value = deepMerge(status.value, data.print)
  }
  const keep = lastReports.value.slice(-49)
  keep.push({ t: Date.now(), data })
  lastReports.value = keep
  // Command results ("result": "success"/"fail") for anything that isn't a status push.
  for (const v of Object.values(data)) {
    if (isObj(v) && v.command && v.command !== 'push_status' && 'result' in v) {
      log(`${v.command}: ${v.result}${v.reason ? ` (${v.reason})` : ''}`, String(v.result).toLowerCase() === 'success')
    }
  }
}

function log(text: string, ok: boolean | null) {
  commandLog.value = [...commandLog.value.slice(-29), { t: Date.now(), text, ok }]
}

/** Keeps the status websocket open (reconnecting) until disconnectPrinter(). */
export function connectPrinter() {
  if (wanted) return
  wanted = true
  open()
}

export function disconnectPrinter() {
  wanted = false
  ws?.close()
}

function reconnect() {
  if (!wanted) return
  // A refused upgrade looks like any other close; stop if we were logged out.
  refreshAuth()
    .then((s) => { if (s.authenticated) setTimeout(open, Math.min(10000, 500 * 2 ** retry++)) })
    .catch(() => setTimeout(reconnect, Math.min(10000, 500 * 2 ** retry++)))
}

function open() {
  if (!wanted || ws) return
  const url = new URL('api/ws', document.baseURI)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(url)
  ws.onopen = () => { wsConnected.value = true; retry = 0 }
  ws.onclose = () => {
    wsConnected.value = false
    mqttConnected.value = false
    ws = null
    reconnect()
  }
  ws.onmessage = (ev) => {
    let msg: any
    try { msg = JSON.parse(ev.data) } catch { return }
    switch (msg.type) {
      case 'hello':
        serial.value = msg.serial ?? null
        modelId.value = msg.model ?? null
        mqttConnected.value = !!msg.mqtt_connected
        break
      case 'status':
        status.value = msg.data ?? {}
        break
      case 'report':
        onReport(msg.data)
        break
      case 'mqtt':
        mqttConnected.value = !!msg.connected
        if (msg.serial) serial.value = msg.serial
        break
      case 'model':
        modelId.value = msg.model ?? null
        break
      case 'error':
        log(`daemon: ${msg.message}`, false)
        break
    }
  }
}

/** Publishes {[type]: {command, ...}} to device/<sn>/request. */
export function sendRequest(data: Record<string, any>, label?: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log(`not connected: ${label ?? JSON.stringify(data)}`, false)
    return false
  }
  ws.send(JSON.stringify({ type: 'request', data }))
  log(label ?? Object.values(data).map((v: any) => v.command).join(','), null)
  return true
}

export const cmd = {
  gcode: (line: string) => sendRequest({ print: { command: 'gcode_line', param: line + '\n' } }, `gcode: ${line.split('\n')[0]}`),
  pause: () => sendRequest({ print: { command: 'pause', param: '' } }),
  resume: () => sendRequest({ print: { command: 'resume', param: '' } }),
  stop: () => sendRequest({ print: { command: 'stop', param: '' } }),
  speed: (lvl: number) => sendRequest({ print: { command: 'print_speed', param: String(lvl) } }),
  light: (node: 'chamber_light' | 'work_light', on: boolean) => sendRequest({
    system: { command: 'ledctrl', led_node: node, led_mode: on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 },
  }),
  pushall: () => sendRequest({ pushing: { command: 'pushall', version: 1, push_target: 1 } }),
  amsLoad: (trayGlobal: number, curTemp: number, tarTemp: number) => sendRequest({
    print: { command: 'ams_change_filament', target: trayGlobal, curr_temp: curTemp, tar_temp: tarTemp },
  }, `load tray ${trayGlobal}`),
  amsUnload: () => sendRequest({ print: { command: 'ams_change_filament', target: 255, curr_temp: 0, tar_temp: 0 } }, 'unload filament'),
  amsControl: (param: 'resume' | 'reset' | 'pause') => sendRequest({ print: { command: 'ams_control', param } }),
  amsRefreshRfid: (amsId: number, slotId: number) => sendRequest({ print: { command: 'ams_get_rfid', ams_id: amsId, slot_id: slotId } }),
  amsSetTray: (amsId: number, trayId: number, p: { tray_info_idx: string; tray_color: string; tray_type: string; nozzle_temp_min: number; nozzle_temp_max: number }) =>
    sendRequest({ print: { command: 'ams_filament_setting', ams_id: amsId, tray_id: trayId, ...p } }, `set tray ${amsId}/${trayId}`),
  /** What Bambu Studio sends from "Printer parts" when the hotend is swapped. */
  setNozzle: (diameter: number, type: string) => sendRequest({
    system: { command: 'set_accessories', accessory_type: 'nozzle', nozzle_diameter: diameter, nozzle_type: type },
  }, `set nozzle ${diameter} mm ${type}`),
  timelapse: (on: boolean) => sendRequest({ camera: { command: 'ipcam_timelapse', control: on ? 'enable' : 'disable' } }),
  record: (on: boolean) => sendRequest({ camera: { command: 'ipcam_record_set', control: on ? 'enable' : 'disable' } }),
  skipObjects: (ids: number[]) => sendRequest({ print: { command: 'skip_objects', obj_list: ids } }),
  calibration: (option: number) => sendRequest({ print: { command: 'calibration', option } }),
}

// Derived values used across views.
export const gcodeState = computed(() => String(status.value.gcode_state ?? 'UNKNOWN'))
export const isPrinting = computed(() => ['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(gcodeState.value))
