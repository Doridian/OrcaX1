// The slicer mirrors the printer it runs on: one filament slot per physical
// tray (every AMS slot, then the external spool) and the printer preset for
// the installed nozzle. Edits in the UI are sent to the printer after a
// confirmation and only "stick" once the printer reports them back.
import { batch, computed, effect, signal } from '@preact/signals'
import { compatibleFilaments, filamentForTray, type FilamentPreset, type FilamentSlot, type ProfileBundle } from '../slicer/profiles'
import { cmd, modelId, mqttConnected, status } from './printer'
import { objects, touch } from './project'
import { bundle, sel, setPrinter, updateSel } from './settings'

export const EXTERNAL = 254
/** How long an edit is shown as pending before the UI falls back to what the printer reports. */
const PENDING_MS = 30_000

export interface Tray {
  /** Global tray id as used by ams_mapping: AMS unit * 4 + slot, or 254. */
  id: number
  amsId: number // 255 for the external spool
  slot: number // 0..3, or 254 for the external spool
  /** Raw tray report; null when no spool is in it. */
  info: Record<string, any> | null
}

export function trayColor(tray: any): string {
  const c = String(tray?.tray_color ?? '').slice(0, 6)
  return /^[0-9a-fA-F]{6}$/.test(c) ? `#${c.toUpperCase()}` : '#888888'
}

/** "AMS 1 slot 2" / "External spool". */
export function trayName(id: number | undefined): string {
  if (id === undefined) return '?'
  return id === EXTERNAL ? 'External spool' : `AMS ${Math.floor(id / 4) + 1} slot ${(id % 4) + 1}`
}

/** "A1-2" / "Ext": short enough for dropdowns. */
export function trayShort(id: number | undefined): string {
  if (id === undefined) return '?'
  return id === EXTERNAL ? 'Ext' : `A${Math.floor(id / 4) + 1}-${(id % 4) + 1}`
}

/** Every physical tray, or null until the printer has reported its AMS state. */
export const trays = computed<Tray[] | null>(() => {
  const st = status.value
  if (!st.ams && !st.vt_tray) return null
  const out: Tray[] = []
  const units = [...((st.ams?.ams ?? []) as any[])].sort((a, b) => Number(a.id) - Number(b.id))
  for (const unit of units) {
    const a = Number(unit.id)
    for (let i = 0; i < 4; i++) {
      const t = (unit.tray ?? []).find((x: any) => Number(x.id) === i)
      out.push({ id: a * 4 + i, amsId: a, slot: i, info: t?.tray_type ? t : null })
    }
  }
  if (st.vt_tray) out.push({ id: EXTERNAL, amsId: 255, slot: EXTERNAL, info: st.vt_tray.tray_type ? st.vt_tray : null })
  return out
})

/** Nozzle the printer reports, or null before it has. */
const reportedNozzle = computed(() => {
  const d = Number(status.value.nozzle_diameter)
  return d > 0 ? { diameter: d, type: String(status.value.nozzle_type ?? '') } : null
})

export const NOZZLE_TYPES: [string, string][] = [['hardened_steel', 'Hardened steel'], ['stainless_steel', 'Stainless steel']]

// ---- Pending edits ------------------------------------------------------

interface PendingTray { preset: string; color: string; filamentId: string; until: number }
export const pendingTrays = signal<Record<number, PendingTray>>({})
export const pendingNozzle = signal<{ diameter: number; type: string; until: number } | null>(null)

/** The nozzle the printer reports (the slicer follows this, not pending edits). */
export const nozzle = reportedNozzle

function expire() {
  const now = Date.now()
  const t = trays.value
  const left: Record<number, PendingTray> = {}
  for (const [id, p] of Object.entries(pendingTrays.value)) {
    const info = t?.find((x) => x.id === Number(id))?.info
    const applied = info && String(info.tray_info_idx ?? '') === p.filamentId && trayColor(info) === p.color
    if (!applied && p.until > now) left[Number(id)] = p
  }
  if (Object.keys(left).length !== Object.keys(pendingTrays.value).length) pendingTrays.value = left
  const n = pendingNozzle.value, r = reportedNozzle.value
  if (n && ((r && r.diameter === n.diameter && r.type === n.type) || n.until <= now)) pendingNozzle.value = null
}

// ---- Preferred preset per tray -----------------------------------------
// A tray only reports a Bambu filament id; several presets can share one
// (user-picked variants). Remember which preset was picked for each tray and
// keep using it while the tray still reports that id.

const PREFS_KEY = 'orcax1.trayPresets.v1'
let prefs: Record<string, string> = {}
try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {} } catch { /* storage unavailable */ }
function remember(tray: number, preset: string) {
  prefs = { ...prefs, [tray]: preset }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* ignore */ }
}

function fallbackPreset(fils: FilamentPreset[]): string {
  return (fils.find((f) => f.vendor === 'Generic' && f.type === 'PLA') ?? fils.find((f) => f.type === 'PLA') ?? fils[0])?.name ?? ''
}

/**
 * Slicer-only setting overrides belong to the tray's filament preset: they are
 * kept while the tray keeps that preset (also when its color changes or the
 * spool runs out) and dropped when the preset changes, from this UI or at the
 * printer, since values tuned for one material rarely suit another.
 */
function keepOverrides(slot: FilamentSlot, prev: FilamentSlot | undefined): FilamentSlot {
  return prev?.overrides && prev.preset === slot.preset ? { ...slot, overrides: prev.overrides } : slot
}

function slotFor(b: ProfileBundle, printer: string, fils: FilamentPreset[], t: Tray, prev: FilamentSlot | undefined): FilamentSlot {
  return keepOverrides(presetSlot(b, printer, fils, t, prev), prev)
}

function presetSlot(b: ProfileBundle, printer: string, fils: FilamentPreset[], t: Tray, prev: FilamentSlot | undefined): FilamentSlot {
  const p = pendingTrays.value[t.id]
  if (p) return { preset: p.preset, color: p.color, tray: t.id }
  if (!t.info) {
    const keep = prev && fils.some((f) => f.name === prev.preset) ? prev.preset : fallbackPreset(fils)
    return { preset: keep, color: prev?.color ?? '#888888', tray: t.id, empty: true }
  }
  const idx = String(t.info.tray_info_idx ?? '')
  const liked = fils.find((f) => f.name === prefs[t.id])
  const preset = liked && liked.filament_id === idx ? liked : filamentForTray(b, printer, idx, String(t.info.tray_type ?? ''))
  return { preset: preset?.name ?? fallbackPreset(fils), color: trayColor(t.info), tray: t.id }
}

// ---- Printer -> slicer --------------------------------------------------

/** The bundle's printer model matching what the printer announces, or null if not (yet) known. */
export const detectedModel = computed(() => {
  const id = modelId.value
  return (id && bundle.value?.models.find((m) => m.model_id === id)?.name) || null
})

function syncPrinter() {
  const b = bundle.value, n = nozzle.value
  if (!b) return
  const s = sel.value
  const cur = b.printers.find((p) => p.name === s.printer)
  const model = detectedModel.value ?? cur?.model ?? b.printers[0]?.model
  const d = n?.diameter ?? Number(cur?.nozzle)
  if (model !== cur?.model || Number(cur?.nozzle) !== d) {
    const want = b.printers.find((p) => p.model === model && Number(p.nozzle) === d)
      ?? (model !== cur?.model ? b.printers.find((p) => p.model === model) : undefined)
    if (want && want.name !== s.printer) setPrinter(want.name)
  }
  if (!n) return
  const o = { ...sel.peek().printerOverrides }
  if (NOZZLE_TYPES.some(([v]) => v === n.type)) o.nozzle_type = [n.type]
  else delete o.nozzle_type
  if (JSON.stringify(o) !== JSON.stringify(sel.peek().printerOverrides)) updateSel({ printerOverrides: o })
}

function syncFilaments() {
  const b = bundle.value, list = trays.value
  if (!b || !list || !list.length) return
  const s = sel.value
  const fils = compatibleFilaments(b, s.printer)
  const next = list.map((t) => slotFor(b, s.printer, fils, t, s.filaments.find((f) => f.tray === t.id)))
  if (JSON.stringify(next) === JSON.stringify(s.filaments)) return
  // Slots are keyed by tray, so objects follow their tray if the layout changes (AMS added or removed).
  const oldTray = s.filaments.map((f) => f.tray)
  const idx = new Map(next.map((f, i) => [f.tray, i]))
  batch(() => {
    const remapped = objects.peek().map((o) => {
      const want = idx.get(oldTray[o.filament]) ?? (o.filament < next.length ? o.filament : 0)
      return want === o.filament ? o : { ...o, filament: want, rev: o.rev + 1 }
    })
    if (remapped.some((o, i) => o !== objects.peek()[i])) { objects.value = remapped; touch() }
    updateSel({ filaments: next })
  })
}

export function initHardwareSync() {
  effect(syncPrinter)
  effect(syncFilaments)
  // Drop pending edits once the printer confirms them, or after a timeout.
  effect(() => { void trays.value; void reportedNozzle.value; expire() })
  setInterval(expire, 2000)
}

// ---- Slicer -> printer --------------------------------------------------

/** Writable from the UI: the printer is connected and has reported this tray. */
export function canEditTray(t: Tray | undefined): t is Tray {
  return !!t && mqttConnected.value && (!!t.info || t.id === EXTERNAL)
}

function first(v: string | string[] | undefined, dflt: number) {
  const n = Number(Array.isArray(v) ? v[0] : v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** Sets a tray's filament on the printer (callers confirm first). Returns false if nothing was sent. */
export function editTray(t: Pick<Tray, 'id' | 'amsId' | 'slot'>, presetName: string, color: string): boolean {
  const f = bundle.value?.filaments.find((x) => x.name === presetName)
  if (!f?.filament_id) return false
  color = color.toUpperCase()
  const sent = cmd.amsSetTray(t.amsId, t.slot, {
    tray_info_idx: f.filament_id,
    tray_color: color.slice(1) + 'FF',
    tray_type: f.type ?? 'PLA',
    nozzle_temp_min: first(f.settings.nozzle_temperature_range_low, 190),
    nozzle_temp_max: first(f.settings.nozzle_temperature_range_high, 240),
  })
  if (!sent) return false
  remember(t.id, presetName)
  pendingTrays.value = { ...pendingTrays.value, [t.id]: { preset: presetName, color, filamentId: f.filament_id, until: Date.now() + PENDING_MS } }
  return true
}

/** Tells the printer which nozzle is installed (callers confirm first). */
export function editNozzle(diameter: number, type: string): boolean {
  if (!cmd.setNozzle(diameter, type)) return false
  pendingNozzle.value = { diameter, type, until: Date.now() + PENDING_MS }
  return true
}

/** Switches the printer model by hand (only offered until the printer announces it), keeping the nozzle. */
export function setModel(model: string) {
  const b = bundle.value
  if (!b) return
  const d = nozzle.value?.diameter ?? Number(b.printers.find((p) => p.name === sel.value.printer)?.nozzle ?? 0.4)
  const p = b.printers.find((x) => x.model === model && Number(x.nozzle) === d) ?? b.printers.find((x) => x.model === model)
  if (p) setPrinter(p.name)
}
