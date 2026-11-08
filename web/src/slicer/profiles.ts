import type { ProcessSchema, SettingsSchema } from './schema'

// Bambu Lab X1 system profiles (built by scripts/build-profiles.mjs) and the
// logic that turns a printer, process and filament selection into engine
// config fragments, as desktop Orca's PresetBundle::full_config does.

export type Settings = Record<string, string | string[]>

export interface PrinterPreset {
  name: string
  model: string
  nozzle: string
  setting_id: string | null
  settings: Settings
}
export interface ProcessPreset {
  name: string
  compatible: string[]
  setting_id: string | null
  settings: Settings
}
export interface FilamentPreset extends ProcessPreset {
  filament_id: string | null
  vendor: string | null
  type: string | null
}
export interface ProfileBundle {
  /** Orca options that hold a single value (everything else is a vector). */
  scalarKeys: string[]
  source: string
  /** Orca's process settings tab: pages, groups and option definitions. */
  processSchema: ProcessSchema
  /** Orca's filament and printer settings tabs. */
  filamentSchema: SettingsSchema
  printerSchema: SettingsSchema
  models: { name: string; default_bed_type: string | null; default_materials: string[]; model_id: string | null }[]
  printers: PrinterPreset[]
  processes: ProcessPreset[]
  filaments: FilamentPreset[]
}

export async function loadBundle(): Promise<ProfileBundle> {
  const res = await fetch(new URL('profiles/bbl-x1.json', document.baseURI))
  if (!res.ok) throw new Error(`profiles: HTTP ${res.status}`)
  return res.json()
}

// Mirrors OrcaSlicer v2.4.2 src/libslic3r/PrintConfig.cpp. These options hold
// one value per extruder variant ("Direct Drive Standard",
// "Direct Drive High Flow"). The engine bridge does not collapse them, so the
// host picks the active variant's value.
const PRINT_OPTIONS_WITH_VARIANT = new Set(['print_extruder_id', 'print_extruder_variant'])
export const FILAMENT_OPTIONS_WITH_VARIANT = new Set([
  'filament_flow_ratio', 'filament_max_volumetric_speed', 'filament_extruder_variant', 'filament_retraction_length',
  'filament_z_hop', 'filament_z_hop_types', 'filament_retract_lift_above', 'filament_retract_lift_below',
  'filament_retract_lift_enforce', 'filament_retract_restart_extra', 'filament_retraction_speed',
  'filament_deretraction_speed', 'filament_retraction_minimum_travel', 'filament_retract_when_changing_layer',
  'filament_wipe', 'filament_wipe_distance', 'filament_retract_before_wipe', 'filament_long_retractions_when_cut',
  'filament_retraction_distances_when_cut', 'long_retractions_when_ec', 'retraction_distances_when_ec',
  'nozzle_temperature_initial_layer', 'nozzle_temperature', 'filament_flush_volumetric_speed', 'filament_flush_temp',
  'filament_cooling_before_tower', 'volumetric_speed_coefficients', 'filament_adaptive_volumetric_speed',
  'filament_ironing_flow', 'filament_ironing_spacing', 'filament_ironing_inset', 'filament_ironing_speed',
  'activate_air_filtration', 'activate_air_filtration_during_print', 'activate_air_filtration_on_completion',
  'during_print_exhaust_fan_speed', 'complete_print_exhaust_fan_speed',
])
export const PRINTER_OPTIONS_WITH_VARIANT_1 = new Set([
  'nozzle_volume', 'retraction_length', 'z_hop', 'travel_slope', 'retract_lift_above', 'retract_lift_below',
  'retract_lift_enforce', 'z_hop_types', 'retraction_speed', 'deretraction_speed', 'retraction_minimum_travel',
  'retract_when_changing_layer', 'wipe', 'wipe_distance', 'retract_before_wipe', 'retract_length_toolchange',
  'retract_restart_extra', 'retract_restart_extra_toolchange', 'long_retractions_when_cut',
  'retraction_distances_when_cut', 'nozzle_type', 'printer_extruder_id', 'printer_extruder_variant',
  'nozzle_flush_dataset',
])
export const PRINTER_OPTIONS_WITH_VARIANT_2 = new Set([
  'machine_max_acceleration_x', 'machine_max_acceleration_y', 'machine_max_acceleration_z',
  'machine_max_acceleration_e', 'machine_max_acceleration_extruding', 'machine_max_acceleration_retracting',
  'machine_max_acceleration_travel', 'machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z',
  'machine_max_speed_e', 'machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_jerk_z', 'machine_max_jerk_e',
])

export type NozzleFlow = 'Standard' | 'High Flow'
const variantName = (flow: NozzleFlow) => `Direct Drive ${flow}`

export function variantIndex(list: string | string[] | undefined, flow: NozzleFlow): number {
  if (!Array.isArray(list)) return 0
  const i = list.indexOf(variantName(flow))
  return i >= 0 ? i : 0
}

/** Picks the active variant's values out of a preset's variant arrays. */
function collapse(settings: Settings, keys: Set<string>, variants: string | string[] | undefined, flow: NozzleFlow, stride = 1): Settings {
  const n = Array.isArray(variants) ? variants.length : 1
  if (n <= 1) return settings
  const idx = variantIndex(variants, flow)
  const out: Settings = { ...settings }
  for (const key of keys) {
    const v = out[key]
    if (!Array.isArray(v) || v.length !== n * stride) continue
    out[key] = v.slice(idx * stride, idx * stride + stride)
  }
  return out
}

export function machineSettings(p: PrinterPreset, flow: NozzleFlow): Settings {
  let s = collapse(p.settings, PRINTER_OPTIONS_WITH_VARIANT_1, p.settings.printer_extruder_variant, flow)
  s = collapse(s, PRINTER_OPTIONS_WITH_VARIANT_2, p.settings.printer_extruder_variant, flow, 2)
  s.nozzle_volume_type = [flow]
  return s
}

export function processSettings(p: ProcessPreset, flow: NozzleFlow): Settings {
  return collapse(p.settings, PRINT_OPTIONS_WITH_VARIANT, p.settings.print_extruder_variant, flow)
}

export function filamentSettings(f: FilamentPreset, flow: NozzleFlow): Settings {
  return collapse(f.settings, FILAMENT_OPTIONS_WITH_VARIANT, f.settings.filament_extruder_variant, flow)
}

/**
 * Bambu presets store some scalar options per extruder variant
 * (e.g. outer_wall_speed: ["200", "200"]). The engine rejects arrays for
 * scalar options, so pick the active variant's value.
 */
function scalarize(settings: Settings, scalars: Set<string>, flow: NozzleFlow, variants?: string | string[]): Settings {
  const out: Settings = { ...settings }
  const idx = variantIndex(variants, flow)
  for (const [k, v] of Object.entries(out)) {
    if (!Array.isArray(v) || !scalars.has(k)) continue
    out[k] = v[Array.isArray(variants) && v.length === variants.length ? idx : 0] ?? ''
  }
  return out
}

/** Merges per-filament presets into one fragment with one array entry per filament slot. */
export function mergeFilaments(list: Settings[], scalars: Set<string> = new Set()): Settings {
  const keys = new Set(list.flatMap((s) => Object.keys(s)))
  const out: Settings = {}
  for (const key of keys) {
    const values: string[] = []
    let fallback: string | undefined
    for (const s of list) {
      const v = s[key]
      const first = Array.isArray(v) ? v[0] : v
      if (first !== undefined && fallback === undefined) fallback = first
    }
    if (fallback === undefined) continue
    if (scalars.has(key)) { out[key] = fallback; continue }
    for (const s of list) {
      const v = s[key]
      const first = Array.isArray(v) ? v[0] : v
      values.push(first ?? fallback)
    }
    // Scalars that are identical across filaments (rare: G-code templates are vectors too) stay vectors.
    out[key] = values
  }
  return out
}

/** User overrides on top of a preset: key -> value (string, or string[] for vector options). */
export type Overrides = Record<string, string | string[]>

export interface FilamentSlot {
  preset: string
  color: string // #RRGGBB
  overrides?: Overrides
  /** Printer tray this slot mirrors: AMS unit * 4 + slot, or 254 for the external spool. */
  tray?: number
  /** No spool in that tray (the preset is a placeholder). */
  empty?: boolean
}

export interface Selection {
  printer: string
  process: string
  filaments: FilamentSlot[]
  bedType: string
  flow: NozzleFlow
  processOverrides: Overrides
  printerOverrides: Overrides
  /** Orca's "Remove mixed temperature restriction" preference. */
  allowMixedTemps?: boolean
}

export const BED_TYPES = ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate', 'Supertack Plate'] as const

/**
 * Approximation of Bambu Studio's flush-volume calculator (FlushVolCalculator):
 * more purge going from dark to light colors, less from light to dark.
 */
export function flushVolume(from: string, to: string): number {
  if (from.toLowerCase() === to.toLowerCase()) return 0
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  const a = rgb(from), b = rgb(to)
  const dist = Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0)) / Math.sqrt(3)
  const darkToLight = Math.max(0, lum(b) - lum(a))
  return Math.round(Math.min(800, 107 + 280 * dist + 420 * darkToLight))
}

export interface EngineConfig {
  init: Record<string, unknown>
  fragments: { format: 'orca.profile-json' | 'orca.native-json'; data: Settings | Record<string, unknown> }[]
}

export function buildEngineConfig(b: ProfileBundle, sel: Selection): EngineConfig {
  const printer = b.printers.find((p) => p.name === sel.printer)
  const proc = b.processes.find((p) => p.name === sel.process)
  if (!printer) throw new Error(`unknown printer preset ${sel.printer}`)
  if (!proc) throw new Error(`unknown process preset ${sel.process}`)
  const fils = sel.filaments.map((slot) => {
    const f = b.filaments.find((x) => x.name === slot.preset)
    if (!f) throw new Error(`unknown filament preset ${slot.preset}`)
    // Overrides are stored like the preset (per-variant arrays), so pick the variant after applying them.
    return { slot, preset: f, settings: filamentSettings({ ...f, settings: { ...f.settings, ...slot.overrides } }, sel.flow) }
  })
  const n = fils.length
  const scalars = new Set(b.scalarKeys)
  const machine = scalarize(machineSettings({ ...printer, settings: { ...printer.settings, ...sel.printerOverrides } }, sel.flow), scalars, sel.flow, printer.settings.printer_extruder_variant)
  const process = scalarize({ ...processSettings(proc, sel.flow), ...sel.processOverrides }, scalars, sel.flow, proc.settings.print_extruder_variant)
  const filament = mergeFilaments(
    fils.map((f) => scalarize(f.settings, scalars, sel.flow, f.preset.settings.filament_extruder_variant)), scalars)

  const matrix: string[] = []
  for (const a of fils) for (const b of fils) matrix.push(String(flushVolume(a.slot.color, b.slot.color)))

  const identity: Record<string, unknown> = {
    printer_settings_id: printer.name,
    print_settings_id: proc.name,
    filament_settings_id: fils.map((f) => f.preset.name),
    filament_ids: fils.map((f) => f.preset.filament_id ?? ''),
    filament_colour: fils.map((f) => f.slot.color.toUpperCase()),
    filament_map: fils.map(() => '1'),
    curr_bed_type: sel.bedType,
    remove_mixed_temp_restriction: sel.allowMixedTemps ? 1 : 0,
    // The engine's init defaults this to 0; Orca's own default (which BBL
    // presets rely on, e.g. for the prime tower) is 1.
    use_relative_e_distances: machine.use_relative_e_distances ?? process.use_relative_e_distances ?? '1',
    flush_volumes_matrix: matrix,
    flush_volumes_vector: Array.from({ length: n * 2 }, () => '140'),
  }

  const area = printer.settings.printable_area
  const pts = (Array.isArray(area) ? area : String(area ?? '').split(','))
    .map((p) => p.split('x').map(Number)).filter((p) => p.length === 2)
  const bx = Math.max(256, ...pts.map((p) => p[0]))
  const by = Math.max(256, ...pts.map((p) => p[1]))

  return {
    init: { bed_size_x: bx, bed_size_y: by },
    fragments: [
      { format: 'orca.profile-json', data: machine },
      { format: 'orca.profile-json', data: process },
      { format: 'orca.profile-json', data: filament },
      { format: 'orca.native-json', data: identity },
    ],
  }
}

export function bedSize(bundle: ProfileBundle, printerName: string): { x: number; y: number; z: number; exclude: [number, number][] } {
  const p = bundle.printers.find((x) => x.name === printerName)
  const s = p?.settings ?? {}
  const parse = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v : String(v ?? '').split(',')).map((pt) => pt.split('x').map(Number) as [number, number]).filter((pt) => pt.length === 2 && pt.every(Number.isFinite))
  const area = parse(s.printable_area)
  return {
    x: Math.max(...area.map((a) => a[0]), 256),
    y: Math.max(...area.map((a) => a[1]), 256),
    z: Number(s.printable_height ?? 250),
    exclude: parse(s.bed_exclude_area),
  }
}

export function compatibleProcesses(bundle: ProfileBundle, printer: string) {
  return bundle.processes.filter((p) => p.compatible.includes(printer))
}
export function compatibleFilaments(bundle: ProfileBundle, printer: string) {
  return bundle.filaments.filter((f) => f.compatible.includes(printer))
}

/** Best filament preset for an AMS tray (by Bambu filament id, then by type). */
export function filamentForTray(bundle: ProfileBundle, printer: string, trayInfoIdx: string, trayType: string): FilamentPreset | undefined {
  const list = compatibleFilaments(bundle, printer)
  if (trayInfoIdx) {
    const exact = list.find((f) => f.filament_id === trayInfoIdx)
    if (exact) return exact
  }
  const type = trayType.toUpperCase()
  return list.find((f) => f.vendor === 'Generic' && f.type?.toUpperCase() === type)
    ?? list.find((f) => f.type?.toUpperCase() === type)
}
