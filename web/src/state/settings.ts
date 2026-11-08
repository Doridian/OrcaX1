import { computed, effect, signal } from '@preact/signals'
import {
  bedSize, compatibleFilaments, compatibleProcesses, loadBundle, variantIndex,
  type ProfileBundle, type Selection,
} from '../slicer/profiles'
import type { Mode } from '../slicer/schema'
import { touch } from './project'

const STORAGE_KEY = 'orcax1.selection.v1'

export const bundle = signal<ProfileBundle | null>(null)
export const bundleError = signal<string | null>(null)

const DEFAULT: Selection = {
  printer: 'Bambu Lab X1 Carbon 0.4 nozzle',
  process: '0.20mm Standard @BBL X1C',
  filaments: [{ preset: 'Bambu PLA Basic @BBL X1C', color: '#F2F2F2' }],
  bedType: 'Textured PEI Plate',
  flow: 'Standard',
  processOverrides: {},
  printerOverrides: {},
}

function loadSaved(): Selection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT, ...JSON.parse(raw) }
  } catch { /* storage unavailable */ }
  return DEFAULT
}

export const sel = signal<Selection>(loadSaved())

effect(() => {
  const v = sel.value
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch { /* ignore */ }
})

export function updateSel(patch: Partial<Selection>) {
  sel.value = { ...sel.value, ...patch }
  touch()
}

export const bed = computed(() => (bundle.value ? bedSize(bundle.value, sel.value.printer) : { x: 256, y: 256, z: 250, exclude: [] as [number, number][] }))
export const processList = computed(() => (bundle.value ? compatibleProcesses(bundle.value, sel.value.printer) : []))
export const filamentList = computed(() => (bundle.value ? compatibleFilaments(bundle.value, sel.value.printer) : []))
export const currentProcess = computed(() => bundle.value?.processes.find((p) => p.name === sel.value.process) ?? null)
export const currentPrinter = computed(() => bundle.value?.printers.find((p) => p.name === sel.value.printer) ?? null)

/** Raw value of a process setting (override, else preset), as stored. */
export function processValue(key: string): string | string[] | undefined {
  return sel.value.processOverrides[key] ?? currentProcess.value?.settings[key]
}

/** Preset value, else Orca's default. */
function processBase(key: string): string | string[] | undefined {
  return currentProcess.value?.settings[key] ?? bundle.value?.processSchema.options[key]?.default
}

const isVectorOption = (key: string) => !!bundle.value?.processSchema.options[key]?.vector

/**
 * Index of the active nozzle-flow variant in a scalar option that the preset
 * stores per variant (e.g. outer_wall_speed: ["200", "200"]).
 */
function variantSlot(list: string[]): number {
  const variants = currentProcess.value?.settings.print_extruder_variant
  return Array.isArray(variants) && list.length === variants.length ? variantIndex(variants, sel.value.flow) : 0
}

/**
 * The value Orca uses for a scalar process option (override, preset or
 * default), for the active nozzle-flow variant. Vector options are joined
 * with newlines.
 */
export function processScalar(key: string): string {
  const v = sel.value.processOverrides[key] ?? processBase(key)
  if (!Array.isArray(v)) return v ?? ''
  // Orca stores some multi-line lists with a newline at the start of each entry.
  return isVectorOption(key) ? v.map((x) => x.replace(/^\n+/, '')).join('\n') : v[variantSlot(v)] ?? ''
}

/** Sets a scalar process option for the active variant (or a vector option from newline-separated text), as the user. */
export function setProcessScalar(key: string, value: string) {
  userChange(key, () => writeProcessScalar(key, value))
}

/** Sets (or with null, resets) a process override, as the user. */
export function setProcessOverride(key: string, value: string | string[] | null) {
  userChange(key, () => writeProcessOverride(key, value))
}

/** Writes a value and lets Orca's rules (configRules.ts) react to the change. */
function userChange(key: string, write: () => void) {
  const prev = processScalar(key)
  write()
  if (processScalar(key) !== prev) processRulesHook?.(key, prev)
}

let processRulesHook: ((key: string, prev: string) => void) | null = null
/** Set by state/processRules.ts. */
export function onProcessChange(fn: (key: string, prev: string) => void) { processRulesHook = fn }

/** setProcessScalar without running the rules. */
export function writeProcessScalar(key: string, value: string) {
  const cur = sel.value.processOverrides[key] ?? processBase(key)
  let next: string | string[] = value
  if (isVectorOption(key)) next = value.split('\n')
  else if (Array.isArray(cur)) {
    next = [...cur]
    next[variantSlot(cur)] = value
  }
  writeProcessOverride(key, next)
}

function writeProcessOverride(key: string, value: string | string[] | null) {
  const o = { ...sel.value.processOverrides }
  const base = processBase(key)
  if (value === null || JSON.stringify(value) === JSON.stringify(base) || (base === undefined && value === '')) delete o[key]
  else o[key] = value
  updateSel({ processOverrides: o })
}

const MODE_KEY = 'orcax1.settingsMode'
function loadMode(): Mode {
  try { const s = localStorage.getItem(MODE_KEY); const m = s === null ? NaN : Number(s); if (m === 0 || m === 1 || m === 2) return m } catch { /* storage unavailable */ }
  return 1
}
/** Orca's Simple / Advanced / Expert visibility of process settings. */
export const settingsMode = signal<Mode>(loadMode())
effect(() => {
  const m = settingsMode.value
  try { localStorage.setItem(MODE_KEY, String(m)) } catch { /* ignore */ }
})

/** The printer overrides that are the user's edits (nozzle_type mirrors the installed nozzle). */
export const printerEdits = (o: Selection['printerOverrides']) => Object.keys(o).filter((k) => k !== 'nozzle_type')

/** What the user changed that a printer switch can carry over or drop: counts of overridden options. */
export function unsavedChanges() {
  const s = sel.value
  return {
    printer: printerEdits(s.printerOverrides).length,
    process: Object.keys(s.processOverrides).length,
    filament: s.filaments.reduce((n, f) => n + Object.keys(f.overrides ?? {}).length, 0),
  }
}

/**
 * Which overrides a switch to another printer keeps. Printer edits never move
 * (Orca's printer tab offers no "Transfer"). Process and filament edits are
 * transferred when true, dropped when false, and when unset kept only where
 * the preset stays the same.
 */
export interface SwitchKeep { process?: boolean; filaments?: boolean }

/**
 * Selects printer preset `name`, keeping a compatible process and the same
 * filaments where they still fit. Re-selecting the current printer (page load)
 * keeps every override. Returns how many overridden options were dropped
 * (with `apply` false, would be dropped, without switching).
 */
export function setPrinter(name: string, keep: SwitchKeep = {}, apply = true): { printer: number; process: number; filament: number } {
  const dropped = { printer: 0, process: 0, filament: 0 }
  const b = bundle.value
  if (!b) return dropped
  const p = b.printers.find((x) => x.name === name)
  if (!p) return dropped
  const s = sel.value
  const same = name === s.printer
  const procs = compatibleProcesses(b, name)
  const process = procs.some((x) => x.name === s.process)
    ? s.process
    : (procs.find((x) => x.name === p.settings.default_print_profile)?.name ?? procs[0]?.name ?? '')
  const fils = compatibleFilaments(b, name)
  const filaments = s.filaments.map((f) => {
    let preset = f.preset
    if (!fils.some((x) => x.name === f.preset)) {
      // Same filament for the new nozzle/printer, e.g. "Bambu PLA Basic @BBL X1C 0.2 nozzle".
      const stem = f.preset.replace(/ @.*$/, '')
      preset = (fils.find((x) => x.name.startsWith(stem + ' @')) ?? fils[0])?.name ?? f.preset
    }
    const keepIt = same || (keep.filaments ?? preset === f.preset)
    if (keepIt || !f.overrides) return preset === f.preset ? f : { ...f, preset }
    dropped.filament += Object.keys(f.overrides).length
    const { overrides: _, ...rest } = f
    return { ...rest, preset }
  })
  let processOverrides = s.processOverrides
  if (!same && !(keep.process ?? process === s.process)) {
    dropped.process = Object.keys(processOverrides).length
    processOverrides = {}
  }
  let printerOverrides = s.printerOverrides
  if (!same) {
    dropped.printer = printerEdits(printerOverrides).length
    printerOverrides = printerOverrides.nozzle_type ? { nozzle_type: printerOverrides.nozzle_type } : {}
  }
  if (!apply || (same && process === s.process && JSON.stringify(filaments) === JSON.stringify(s.filaments))) return dropped
  updateSel({ printer: name, process, filaments, processOverrides, printerOverrides })
  return dropped
}

/** "3 printer settings and 1 process setting", or '' if nothing. */
export function describeChanges(c: { printer: number; process: number; filament: number }): string {
  const part = (n: number, what: string) => (n ? `${n} ${what} setting${n === 1 ? '' : 's'}` : '')
  const parts = [part(c.printer, 'printer'), part(c.process, 'process'), part(c.filament, 'filament')].filter(Boolean)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? ''
}

export async function initSettings() {
  try {
    const b = await loadBundle()
    bundle.value = b
    // Repair a stale saved selection.
    if (!b.printers.some((p) => p.name === sel.value.printer)) sel.value = { ...sel.value, printer: DEFAULT.printer }
    setPrinter(sel.value.printer)
  } catch (e) {
    bundleError.value = String(e)
  }
}
