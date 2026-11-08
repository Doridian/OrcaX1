// Editing a filament slot's or the printer's settings on top of their presets.
//
// Edits are slicer-only overrides (FilamentSlot.overrides, Selection.printerOverrides);
// nothing here is sent to the printer. They are stored like the preset stores
// the option: Bambu presets keep one value per nozzle-flow variant
// ("Direct Drive Standard" / "Direct Drive High Flow") for some options, and
// buildEngineConfig picks the active variant after applying overrides, so an
// edit changes only the variant that is active while editing (as in Orca).
import { computed, signal } from '@preact/signals'
import { filamentChanged } from '../slicer/filamentRules'
import {
  FILAMENT_OPTIONS_WITH_VARIANT, PRINTER_OPTIONS_WITH_VARIANT_1, PRINTER_OPTIONS_WITH_VARIANT_2, variantIndex,
  type Overrides, type Settings,
} from '../slicer/profiles'
import type { SettingsSchema } from '../slicer/schema'
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

function read(st: Store, key: string): string {
  const v = st.overrides[key] ?? base(st, key)
  if (!Array.isArray(v)) return v ?? ''
  if (NAME_LISTS.has(key)) return v.join('\n')
  if (LIST_TYPES.has(st.schema?.options[key]?.type ?? '')) return v.join(', ')
  return v[st.slot(key, v)] ?? v[0] ?? ''
}

function write(st: Store, key: string, text: string) {
  const def = st.schema?.options[key]
  const cur = st.overrides[key] ?? base(st, key)
  let next: string | string[] = text
  if (NAME_LISTS.has(key)) next = text.split('\n').map((s) => s.trim()).filter(Boolean)
  else if (LIST_TYPES.has(def?.type ?? '')) next = text.split(',').map((s) => s.trim()).filter(Boolean)
  else if (Array.isArray(cur)) {
    next = cur.length ? [...cur] : [text]
    next[st.slot(key, cur)] = text
  } else if (def?.vector) next = [text]
  override(st, key, next)
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

function access(st: Store, locked: (k: string) => string | null, inherited?: (k: string) => string): SettingsAccess {
  return {
    schema: st.schema!,
    value: (k) => read(st, k),
    set: (k, v) => write(st, k, v),
    changed: (k) => k in st.overrides,
    reset: (k) => override(st, k, null),
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
      // Machine limits: [normal, silent] per variant; the X1 presets don't use silent mode.
      if (n > 1 && PRINTER_OPTIONS_WITH_VARIANT_2.has(key) && list.length === 2 * n) return vi * 2
      return 0
    },
    write: (o) => updateSel({ printerOverrides: o }),
  }
}

/** The printer's settings (preset plus overrides) for the active nozzle-flow variant. */
export const printerAccess = computed<SettingsAccess | null>(() => {
  if (!bundle.value?.printerSchema || !currentPrinter.value) return null
  return access(printerStore(), (k) => PRINTER_LOCKED[k] ?? null)
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
  return {
    ...a,
    set(k, v) {
      a.set(k, v)
      // Orca's checks (filamentRules.ts) on the stored result; each write re-reads the slot.
      presetNotices.value = []
      filamentChanged(k, {
        get: (key) => filamentScalar(index, key),
        set: (key, value) => { const s = filamentStore(index); if (s) write(s, key, value) },
        printer: printerScalar,
        temps: bundle.value?.materialTemps,
        notify: (text) => { presetNotices.value = [...presetNotices.value, text] },
      })
    },
  }
}

/** Warnings from the last filament edit (Orca's message boxes), shown in the settings dialog. */
export const presetNotices = signal<string[]>([])

/** Effective value of a filament option for a slot (for toggles). */
export const filamentScalar = (index: number, key: string) => {
  const st = filamentStore(index)
  return st ? read(st, key) : ''
}
