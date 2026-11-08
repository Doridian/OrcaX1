// Editing a filament slot's or the printer's settings on top of their presets.
//
// Edits are slicer-only overrides (FilamentSlot.overrides, Selection.printerOverrides);
// nothing here is sent to the printer. They are stored like the preset stores
// the option: Bambu presets keep one value per nozzle-flow variant
// ("Direct Drive Standard" / "Direct Drive High Flow") for some options, and
// buildEngineConfig picks the active variant after applying overrides, so an
// edit changes only the variant that is active while editing (as in Orca).
//
// Machine limits keep a [normal, silent] pair per variant. The silent value of
// `key` is edited as `key#1` (shown when silent_mode is on, as Orca adds a
// "Silent" column).
//
// After an edit, Orca's value rules run: filamentRules.ts for a filament,
// printerRules.ts for the printer (which may ask, and may run the process
// rules again).
import { computed, signal } from '@preact/signals'
import { filamentChanged } from '../slicer/filamentRules'
import { printerChanged } from '../slicer/printerRules'
import {
  FILAMENT_OPTIONS_WITH_VARIANT, PRINTER_OPTIONS_WITH_VARIANT_1, PRINTER_OPTIONS_WITH_VARIANT_2, variantIndex,
  type Overrides, type Settings,
} from '../slicer/profiles'
import type { SettingsSchema } from '../slicer/schema'
import { ask } from './confirm'
import { queueProcessUpdate } from './processRules'
import { bundle, currentPrinter, processScalar, sel, updateSel } from './settings'

type Value = string | string[] | undefined

/** How text in an option editor maps to a stored value. */
interface Store {
  schema: SettingsSchema | undefined
  preset: Settings | undefined
  overrides: Overrides
  /** Array index holding the active variant's value of `key` in `list`. */
  slot(key: string, list: string[]): number
  write(overrides: Overrides): void
}

// Options whose value is a whole list (bed shape), edited as comma-separated text.
const LIST_TYPES = new Set(['coPoints', 'coPointsGroups'])
// Lists of preset names (Dependencies page), shown one per line.
const NAME_LISTS = new Set(['compatible_printers', 'compatible_prints'])

function base(st: Store, key: string): Value {
  return st.preset?.[key] ?? st.schema?.options[key]?.default
}

/** "machine_max_speed_x#1" -> the silent column of machine_max_speed_x. */
export const SILENT = '#1'
const column = (k: string) => (k.endsWith(SILENT) ? { key: k.slice(0, -SILENT.length), col: 1 } : { key: k, col: 0 })

/** Array index of `k` (with its column) in `list`, or -1 if the list has no such column. */
function index(st: Store, key: string, col: number, list: string[]) {
  const i = st.slot(key, list) + col
  return col && i >= list.length ? -1 : i
}

function read(st: Store, k: string): string {
  const { key, col } = column(k)
  const v = st.overrides[key] ?? base(st, key)
  if (!Array.isArray(v)) return col ? '' : v ?? ''
  if (NAME_LISTS.has(key)) return v.join('\n')
  if (LIST_TYPES.has(st.schema?.options[key]?.type ?? '')) return v.join(', ')
  const i = index(st, key, col, v)
  return i < 0 ? '' : v[i] ?? v[0] ?? ''
}

function write(st: Store, k: string, text: string) {
  const { key, col } = column(k)
  const def = st.schema?.options[key]
  const cur = st.overrides[key] ?? base(st, key)
  let next: string | string[] = text
  if (NAME_LISTS.has(key)) next = text.split('\n').map((s) => s.trim()).filter(Boolean)
  else if (LIST_TYPES.has(def?.type ?? '')) next = text.split(',').map((s) => s.trim()).filter(Boolean)
  else if (Array.isArray(cur)) {
    const i = index(st, key, col, cur)
    if (i < 0) return
    next = cur.length ? [...cur] : [text]
    next[i] = text
  } else if (col) return
  else if (def?.vector) next = [text]
  override(st, key, next)
}

/** Resets `k`; either value of a machine limit's [normal, silent] pair resets on its own. */
function reset(st: Store, k: string) {
  const { key, col } = column(k)
  const b = base(st, key), cur = st.overrides[key]
  if (!PRINTER_OPTIONS_WITH_VARIANT_2.has(key) || !Array.isArray(b) || !Array.isArray(cur) || b.length !== cur.length) return override(st, key, null)
  const i = index(st, key, col, cur)
  if (i >= 0) { const next = [...cur]; next[i] = b[i] ?? next[i]; override(st, key, next) }
}

/** Every key the preset stores, overrides or the tab defines (unset ones show Orca's default). */
function rawKeys(st: Store) {
  return [...new Set([...Object.keys(st.preset ?? {}), ...Object.keys(st.overrides), ...Object.keys(st.schema?.options ?? {})])].sort()
}

function override(st: Store, key: string, value: string | string[] | null) {
  const o = { ...st.overrides }
  const b = base(st, key)
  if (value === null || JSON.stringify(value) === JSON.stringify(b) || (b === undefined && value === '')) delete o[key]
  else o[key] = value
  st.write(o)
}

/** Getter/setter pair for one settings tab, as used by the option editors. */
export interface SettingsAccess {
  /** The Raw tab: every stored key, its stored value, and setting/resetting it as a whole. */
  raw: RawAccess
  schema: SettingsSchema
  value(key: string): string
  set(key: string, value: string): void
  changed(key: string): boolean
  reset(key: string): void
  /** Why an option can't be edited here, if it can't. */
  locked(key: string): string | null
  /** For "nil"-able options: the value used while unset. */
  inherited?(key: string): string
  /** Number of overridden options. */
  count: number
  resetAll(): void
}

/** Stored values as the Raw tab edits them. */
export interface RawAccess {
  keys(): string[]
  get(key: string): string | string[] | undefined
  changed(key: string): boolean
  /** Stores `value` (null resets) and runs the rules for it. */
  set(key: string, value: string | string[] | null): void
}

function access(st: Store, locked: (k: string) => string | null, inherited?: (k: string) => string): SettingsAccess {
  return {
    schema: st.schema!,
    raw: {
      keys: () => rawKeys(st),
      get: (k) => st.overrides[k] ?? base(st, k),
      changed: (k) => k in st.overrides,
      set: (k, v) => override(st, k, v),
    },
    value: (k) => read(st, k),
    set: (k, v) => write(st, k, v),
    changed: (k) => column(k).key in st.overrides,
    reset: (k) => reset(st, k),
    locked,
    inherited,
    count: Object.keys(st.overrides).length,
    resetAll: () => st.write({}),
  }
}

// ---- Printer ------------------------------------------------------------

/** Things the printer reports or that define the machine model: shown, not overridden. */
const PRINTER_LOCKED: Record<string, string> = {
  nozzle_diameter: 'Reported by the printer (change the nozzle in the Printer section)',
  nozzle_type: 'Reported by the printer (change it in the Printer section)',
  printable_area: 'Part of the printer model',
  bed_exclude_area: 'Part of the printer model',
  printable_height: 'Part of the printer model',
  extruder_printable_area: 'Part of the printer model',
  extruder_printable_height: 'Part of the printer model',
}

function printerStore(): Store {
  const p = currentPrinter.value
  const variants = p?.settings.printer_extruder_variant
  const n = Array.isArray(variants) ? variants.length : 1
  const vi = variantIndex(variants, sel.value.flow)
  return {
    schema: bundle.value?.printerSchema,
    preset: p?.settings,
    overrides: sel.value.printerOverrides,
    slot(key, list) {
      if (n > 1 && PRINTER_OPTIONS_WITH_VARIANT_1.has(key) && list.length === n) return vi
      // Machine limits: [normal, silent] per variant (the silent one is column 1).
      if (n > 1 && PRINTER_OPTIONS_WITH_VARIANT_2.has(key) && list.length === 2 * n) return vi * 2
      return 0
    },
    write: (o) => updateSel({ printerOverrides: o }),
  }
}

let printerQueue: Promise<void> = Promise.resolve()

/** Runs Orca's printer rules (printerRules.ts) after the user changed `key`, one change at a time. */
function printerRules(key: string) {
  presetNotices.value = []
  printerQueue = printerQueue.then(async () => {
    const r = await printerChanged(key, {
      get: printerScalar,
      getAll: (k) => {
        const st = printerStore(), v = st.overrides[k] ?? base(st, k)
        return Array.isArray(v) ? v : v === undefined ? [] : [v]
      },
      set: (k, v) => write(printerStore(), k, v),
      setAll: (k, v) => override(printerStore(), k, v),
      ask: (q) => ask({ title: q.title, body: q.body, confirm: q.yes, cancel: q.no }),
      notify: (text) => { if (!presetNotices.value.includes(text)) presetNotices.value = [...presetNotices.value, text] },
    })
    if (r.processUpdate) await queueProcessUpdate()
  }).catch((e) => console.error('printer rules', e))
}

/** The printer's settings (preset plus overrides) for the active nozzle-flow variant. */
export const printerAccess = computed<SettingsAccess | null>(() => {
  if (!bundle.value?.printerSchema || !currentPrinter.value) return null
  const a = access(printerStore(), (k) => PRINTER_LOCKED[column(k).key] ?? null)
  const run = (k: string, change: () => void) => {
    const before = printerScalar(k)
    change()
    if (printerScalar(k) !== before || k.endsWith(SILENT)) printerRules(column(k).key)
  }
  return {
    ...a,
    // A machine limit's normal and silent values are marked (and reset) on their own.
    changed: (k) => {
      const { key, col } = column(k)
      if (!a.changed(k) || !PRINTER_OPTIONS_WITH_VARIANT_2.has(key)) return a.changed(k)
      const st = printerStore(), o = st.overrides[key], b = base(st, key)
      if (!Array.isArray(o) || !Array.isArray(b) || o.length !== b.length) return true
      const i = index(st, key, col, o)
      return i < 0 || o[i] !== b[i]
    },
    set: (k, v) => run(k, () => a.set(k, v)),
    reset: (k) => run(k, () => a.reset(k)),
    raw: { ...a.raw, set: (k, v) => run(k, () => a.raw.set(k, v)) },
  }
})

/** Effective value of a printer option for the active variant. */
export const printerScalar = (key: string) => read(printerStore(), key)

// ---- Filaments ----------------------------------------------------------

const FILAMENT_LOCKED: Record<string, string> = {
  compatible_printers: 'Preset compatibility is fixed by the system preset',
  compatible_prints: 'Preset compatibility is fixed by the system preset',
  compatible_printers_condition: 'Preset compatibility is fixed by the system preset',
  compatible_prints_condition: 'Preset compatibility is fixed by the system preset',
}

function filamentStore(index: number): Store | null {
  const slot = sel.value.filaments[index]
  const f = slot && bundle.value?.filaments.find((x) => x.name === slot.preset)
  if (!slot || !f) return null
  const variants = f.settings.filament_extruder_variant
  const n = Array.isArray(variants) ? variants.length : 1
  const vi = variantIndex(variants, sel.value.flow)
  return {
    schema: bundle.value?.filamentSchema,
    preset: f.settings,
    overrides: slot.overrides ?? {},
    slot: (key, list) => (n > 1 && FILAMENT_OPTIONS_WITH_VARIANT.has(key) && list.length === n ? vi : 0),
    write(o) {
      // Re-read the slot: the tray sync may have replaced the list since.
      const filaments = sel.value.filaments.map((s, i) => {
        if (i !== index || s.preset !== slot.preset) return s
        const { overrides: _, ...rest } = s
        return Object.keys(o).length ? { ...rest, overrides: o } : rest
      })
      updateSel({ filaments })
    },
  }
}

/**
 * A filament slot's settings (preset plus the slot's overrides) for the
 * active nozzle-flow variant. The "Setting Overrides" options fall back to the
 * printer's retraction settings and the process's ironing settings while unset.
 */
export function filamentAccess(index: number): SettingsAccess | null {
  const st = filamentStore(index)
  if (!st?.schema) return null
  const a = access(st, (k) => FILAMENT_LOCKED[k] ?? null, (k) => {
    const raw = k.replace(/^filament_/, '')
    return k.startsWith('filament_ironing_') ? processScalar(raw) : printerScalar(raw)
  })
  // Orca's checks (filamentRules.ts) on the stored result; each write re-reads the slot.
  const run = (k: string, change: () => void) => {
    change()
    presetNotices.value = []
    filamentChanged(k, {
      get: (key) => filamentScalar(index, key),
      set: (key, value) => { const s = filamentStore(index); if (s) write(s, key, value) },
      printer: printerScalar,
      temps: bundle.value?.materialTemps,
      notify: (text) => { if (!presetNotices.value.includes(text)) presetNotices.value = [...presetNotices.value, text] },
    })
  }
  return {
    ...a,
    set: (k, v) => run(k, () => a.set(k, v)),
    reset: (k) => run(k, () => a.reset(k)),
    raw: { ...a.raw, set: (k, v) => run(k, () => a.raw.set(k, v)) },
  }
}

/** Warnings from the last filament or printer edit (Orca's message boxes), shown in the settings dialog. */
export const presetNotices = signal<string[]>([])

/** Effective value of a filament option for a slot (for toggles). */
export const filamentScalar = (index: number, key: string) => {
  const st = filamentStore(index)
  return st ? read(st, key) : ''
}
