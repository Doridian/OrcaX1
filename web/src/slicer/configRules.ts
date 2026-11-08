// What Orca does to the other process values when one changes: the
// corrections, questions and warnings of OrcaSlicer v2.4.2, as opposed to the
// show/hide logic in toggles.ts. Ported from
//   - Tab::on_value_change (src/slic3r/GUI/Tab.cpp): questions about the key
//     that just changed (prime tower vs. smooth timelapse, layer height vs. the
//     nozzle's limits, support materials, ...);
//   - ConfigManipulation::update_print_fff_config: checks of the whole config,
//     run by TabPrint::update() after every change;
//   - ConfigManipulation::toggle_print_fff_options: the few values it forces
//     while deciding what to show (run by TabPrint::toggle_options() at the end
//     of update()).
// Orca re-runs update() whenever one of these rules changes a value
// (ConfigManipulation::apply -> load_config -> update), so this repeats the
// checks until nothing changes.
//
// The config is the global (plate-wide) process config of a Bambu Lab X1
// (is_global_config = true, is_plate_config = false, is_BBL_Printer = true).
// Left out, because they cannot happen here:
//   - per-object and per-plate variants (OK-only spiral dialog for objects,
//     apply_null_fff_config, the "is_plate_config" spiral exemption);
//   - the "#if 0" prime tower vs. adaptive/independent support layer height block;
//   - printer and filament tab checks: they edit other presets and live in
//     filamentRules.ts and printerRules.ts;
//   - SLA options.
//
// Orca's modal "Reset to X" OK dialogs become a correction plus a notice that
// does not block; its Yes/No dialogs become questions.

import { gcodeWarning } from './gcodeCheck'
import type { Settings } from './profiles'
import { MULTILINE_PATTERNS } from './toggles'

export interface Question {
  title: string
  body: string
  /** Label of Orca's "Yes" button. */
  yes: string
  /** Label of Orca's "No" button. */
  no: string
}

export interface FilamentInfo {
  /** filament_type, e.g. "PLA". */
  type: string
  /** filament_is_support */
  support: boolean
  /** filament_soluble */
  soluble: boolean
}

export interface RuleHost {
  /** Effective value of a process option (override, preset or Orca default) for the active variant. */
  get(key: string): string
  /** Writes a process option without running the rules again. */
  set(key: string, value: string): void
  /** The printer preset. */
  printer: Settings
  /** Filament slots in order (support_filament 1 is the first). */
  filaments: FilamentInfo[]
  /** filament_type of every filament an object on the plate uses (Orca's has_filaments). */
  usedFilamentTypes: () => string[]
  /** Orca's Simple mode. */
  simpleMode: boolean
  /** Yes/No dialog; resolves true for Yes. */
  ask(q: Question): Promise<boolean>
  /** Non-blocking warning. */
  notify(text: string): void
}

/** State Orca keeps in ConfigManipulation between updates. */
export interface RuleState {
  /** m_support_material_overhangs_queried */
  overhangsQueried: boolean
}
export const newRuleState = (): RuleState => ({ overhangsQueried: false })

const EPSILON = 1e-4

class Cfg {
  changes = 0
  readonly h: RuleHost
  constructor(h: RuleHost) { this.h = h }
  str(k: string) { return this.h.get(k) }
  num(k: string) { return parseFloat(this.h.get(k)) || 0 }
  int(k: string) { return Math.trunc(this.num(k)) }
  bool(k: string) { const v = this.h.get(k); return v === '1' || v === 'true' }
  /** ConfigBase::get_abs_value for a float-or-percent option. */
  abs(k: string, over: string) {
    const v = this.h.get(k).trim()
    return v.endsWith('%') ? (parseFloat(v) || 0) * this.num(over) / 100 : parseFloat(v) || 0
  }
  set(k: string, v: string | number | boolean) {
    const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v)
    if (this.h.get(k) === s) return
    this.h.set(k, s)
    this.changes++
  }
  printer(k: string): string[] {
    const v = this.h.printer[k]
    return v === undefined ? [] : Array.isArray(v) ? v : [v]
  }
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000)

/**
 * Runs Orca's reaction to the user changing `key` (its previous value was `prev`).
 * Call after the new value is written.
 */
export async function processChanged(key: string, prev: string, host: RuleHost, state: RuleState): Promise<void> {
  const c = new Cfg(host)
  await onValueChange(c, key, prev)
  await update(c, state)
}

/**
 * TabPrint::update() on its own, as Orca runs it when a preset is loaded
 * (Tab::load_current_preset, also after a printer switch) and when filaments
 * are added or removed (Sidebar::add_filament / delete_filament).
 */
export async function processUpdate(host: RuleHost, state: RuleState): Promise<void> {
  await update(new Cfg(host), state)
}

async function update(c: Cfg, state: RuleState) {
  // update() runs again after every apply(); a handful of passes always settles.
  for (let i = 0; i < 5; i++) {
    const before = c.changes
    await updatePrintFffConfig(c, state)
    toggleSideEffects(c)
    if (c.changes === before) break
  }
}

/** Tab::on_value_change: questions about the key that just changed. */
async function onValueChange(c: Cfg, key: string, prev: string) {
  const h = c.h
  const value = c.str(key)
  const on = value === '1' || value === 'true'

  // The option group's validate_custom_gcode_cb, before on_value_change.
  const gcode = gcodeWarning(key, value)
  if (gcode) h.notify(gcode)

  if (key === 'enable_prime_tower') {
    if (!on && c.str('timelapse_type') === '1') {
      let reenabled = false
      if (!await h.ask({
        title: 'Disable prime tower?',
        body: 'A prime tower is required for smooth timelapse. There may be flaws on the model without prime tower. Are you sure you want to disable prime tower?',
        yes: 'Disable', no: 'Keep prime tower',
      })) { c.set('enable_prime_tower', true); reenabled = true }
      if (c.bool('enable_wrapping_detection') && !reenabled && !await h.ask({
        title: 'Disable prime tower?',
        body: 'A prime tower is required for clumping detection. There may be flaws on the model without prime tower. Are you sure you want to disable prime tower?',
        yes: 'Disable', no: 'Keep prime tower',
      })) c.set('enable_prime_tower', true)
    }
    if (on && c.bool('precise_z_height') && !await h.ask({
      title: 'Enable prime tower?',
      body: 'Enabling both precise Z height and the prime tower may cause slicing errors. Do you still want to enable?',
      yes: 'Enable', no: 'Cancel',
    })) c.set('enable_prime_tower', false)
  }

  if (key === 'enable_wrapping_detection' && on && !c.bool('enable_prime_tower') && !await h.ask({
    title: 'Enable clumping detection?',
    body: 'A prime tower is required for clumping detection. There may be flaws on the model without prime tower. Do you still want to enable clumping detection?',
    yes: 'Enable', no: 'Cancel',
  })) c.set('enable_wrapping_detection', false)

  if (key === 'precise_z_height' && on && c.bool('enable_prime_tower') && !await h.ask({
    title: 'Enable precise Z height?',
    body: 'Enabling both precise Z height and the prime tower may cause slicing errors. Do you still want to enable precise Z height?',
    yes: 'Enable', no: 'Cancel',
  })) c.set('precise_z_height', false)

  if (key === 'timelapse_type' && value === '1' && !c.bool('enable_prime_tower') && await h.ask({
    title: 'Enable prime tower?',
    body: 'A prime tower is required for smooth timelapse. There may be flaws on the model without prime tower. Do you want to enable prime tower?',
    yes: 'Enable prime tower', no: 'No',
  })) c.set('enable_prime_tower', true)

  // Bed slingers only; the X1 is CoreXY.
  if (key === 'print_sequence' && value === 'by object' && c.printer('printer_structure')[0] === 'i3' && !await h.ask({
    title: 'Print by object?',
    body: 'The current printer does not support timelapse in Traditional Mode when printing By-Object.\n\nStill print by object?',
    yes: 'Print by object', no: 'Print by layer',
  })) c.set('print_sequence', 'by layer')

  // Orca resets the style when the support type changes, in Simple mode only.
  if (key === 'support_type' && h.simpleMode) c.set('support_style', 'default')

  const fil = (id: number) => (id >= 0 ? h.filaments[id] : undefined)
  const hasFilaments = (types: string[]) => h.usedFilamentTypes().some((t) => types.includes(t))
  const isSoluble = (id: number) => !!fil(id)?.soluble
  // is_support_filament(id, strict_check = false)
  const isSupport = (id: number) => {
    const f = fil(id)
    if (!f) return false
    if (f.type === 'PETG' && hasFilaments(['PLA'])) return true
    if (f.type === 'PLA' && hasFilaments(['PETG', 'TPU', 'TPU-AMS'])) return true
    return f.support
  }

  if (key === 'support_filament') {
    const id = c.int('support_filament') - 1
    if (isSupport(id) && !isSoluble(id) && !hasFilaments(['TPU', 'TPU-AMS']) && !await h.ask({
      title: 'Support base material',
      body: 'Non-soluble support materials are not recommended for support base.\nAre you sure to use them for support base?',
      yes: 'Use it', no: 'Default',
    })) c.set('support_filament', 0)
  }

  if (key === 'support_interface_filament') {
    const base = c.int('support_filament') - 1
    const iface = c.int('support_interface_filament') - 1
    const recommended = c.num('support_top_z_distance') === 0 && c.num('support_interface_spacing') === 0 &&
      c.str('support_interface_pattern') === 'rectilinear_interlaced'
    if ((isSupport(iface) && !recommended) || (isSoluble(iface) && !isSoluble(base))) {
      const body = !isSoluble(iface)
        ? 'When using support material for the support interface, we recommend the following settings:\n' +
          '0 top Z distance, 0 interface spacing, interlaced rectilinear pattern and disable independent support layer height.'
        : 'When using soluble material for the support interface, we recommend the following settings:\n' +
          '0 top Z distance, 0 interface spacing, interlaced rectilinear pattern, disable independent support layer height\n' +
          'and use soluble materials for both support interface and support base.'
      if (await h.ask({ title: 'Suggestion', body: body + '\n\nChange these settings automatically?', yes: 'Change them', no: "Don't change" })) {
        c.set('support_top_z_distance', 0)
        c.set('support_interface_spacing', 0)
        c.set('support_interface_pattern', 'rectilinear_interlaced')
        c.set('independent_support_layer_height', false)
        if ((fil(iface)?.type === 'PLA' && hasFilaments(['TPU', 'TPU-AMS'])) || (isSoluble(iface) && !isSoluble(base)))
          c.set('support_filament', iface + 1)
      }
    }
  }

  if (key === 'make_overhang_printable' && on && !await h.ask({
    title: 'Make overhangs printable?',
    body: "Enabling this option will modify the model's shape. If your print requires precise dimensions or is part of an " +
      "assembly, it's important to double-check whether this change in geometry impacts the functionality of your print.\n\n" +
      'Are you sure you want to enable this option?',
    yes: 'Enable', no: 'Cancel',
  })) c.set('make_overhang_printable', false)

  if (key === 'sparse_infill_rotate_template') {
    const safe = ['rectilinear', 'line', 'zigzag', 'crosszag', 'lockedzag'].includes(c.str('sparse_infill_pattern')) || value === ''
    if (!safe && prev === '' && !await h.ask({
      title: 'Rotate sparse infill?',
      body: 'Infill patterns are typically designed to handle rotation automatically to ensure proper printing and achieve their ' +
        'intended effects (e.g., Gyroid, Cubic). Rotating the current sparse infill pattern may lead to insufficient support. ' +
        'Please proceed with caution and thoroughly check for any potential printing issues.\n\n' +
        'Are you sure you want to enable this option?',
      yes: 'Enable', no: 'Cancel',
    })) c.set('sparse_infill_rotate_template', '')
  }

  if (key === 'layer_height') {
    const mins = c.printer('min_layer_height').map(parseFloat).filter((x) => !isNaN(x))
    const maxs = c.printer('max_layer_height').map(parseFloat).filter((x) => !isNaN(x))
    if (mins.length && maxs.length) {
      const floor = Math.min(...mins)
      const ceil = Math.max(...maxs)
      const lh = c.num('layer_height')
      const tooLow = lh < floor
      const tooHigh = lh > ceil
      if (lh < EPSILON) {
        h.notify(`Layer height is too small. It was set to the nozzle's minimum layer height (${fmt(floor)} mm).`)
        c.set('layer_height', floor)
      } else if ((tooLow || tooHigh) && await h.ask({
        title: 'Layer height out of range',
        body: 'Layer height exceeds the limit in Printer Settings -> Extruder -> Layer height limits, this may cause printing quality issues.\n\n' +
          `Adjust to the set range (${fmt(floor)} to ${fmt(ceil)} mm) automatically?`,
        yes: 'Adjust', no: 'Ignore',
      })) c.set('layer_height', tooHigh ? ceil : floor)
    }
  }
}

/** ConfigManipulation::update_print_fff_config (global config, Bambu Lab printer). */
async function updatePrintFffConfig(c: Cfg, state: RuleState) {
  const h = c.h
  if (c.num('layer_height') < EPSILON) {
    h.notify('Too small layer height. Reset to 0.2.')
    c.set('layer_height', 0.2)
  }
  const maxLh = parseFloat(c.printer('max_layer_height')[0] ?? '') || 0
  if (maxLh > 0.2 && c.num('layer_height') > maxLh + EPSILON) {
    h.notify(`Too large layer height. Reset to ${maxLh.toFixed(3)}.`)
    c.set('layer_height', maxLh)
  }
  const layerHeight = c.num('layer_height')

  for (const k of ['ironing_spacing', 'support_ironing_spacing']) {
    if (c.num(k) < 0.05) {
      h.notify('Too small ironing spacing. Reset to 0.1.')
      c.set(k, 0.1)
    }
  }
  if (c.num('initial_layer_print_height') < EPSILON) {
    h.notify('Zero initial layer height is invalid. The first layer height will be reset to 0.2.')
    c.set('initial_layer_print_height', 0.2)
  }
  for (const k of ['xy_hole_compensation', 'xy_contour_compensation']) {
    if (Math.abs(c.num(k)) > 2) {
      h.notify('X-Y compensation is only for small corrections, e.g. when a model is slightly off and hard to assemble. ' +
        'For large size tuning, please use model scale function. The value was reset to 0.')
      c.set(k, 0)
    }
  }
  if (c.num('elefant_foot_compensation') > 1) {
    h.notify('Too large elephant foot compensation is unreasonable. If really have serious elephant foot effect, please check other settings, ' +
      'for example whether bed temperature is too high. The value was reset to 0.')
    c.set('elefant_foot_compensation', 0)
  }
  // Clumping detection needs an H2D-class printer; the X1 has none (silent).
  if (c.bool('enable_wrapping_detection')) c.set('enable_wrapping_detection', false)

  if (c.bool('spiral_mode') && !(c.int('wall_loops') === 1 && c.int('top_shell_layers') === 0 && c.num('sparse_infill_density') === 0 &&
    !c.bool('enable_support') && c.int('enforce_support_layers') === 0 && !c.bool('detect_thin_wall') && !c.bool('overhang_reverse') &&
    c.str('timelapse_type') === '0' && !c.bool('enable_wrapping_detection'))) {
    if (await h.ask({
      title: 'Spiral vase',
      body: 'Spiral mode only works when wall loops is 1, support is disabled, clumping detection by probing is disabled, top shell layers is 0, ' +
        'sparse infill density is 0 and timelapse type is traditional.\n\nChange these settings automatically?',
      yes: 'Change and enable spiral mode', no: 'Give up spiral mode',
    })) {
      c.set('wall_loops', 1)
      c.set('top_shell_layers', 0)
      c.set('sparse_infill_density', '0%')
      c.set('enable_support', false)
      if (c.int('enforce_support_layers') !== 0) c.set('enforce_support_layers', 0)
      c.set('detect_thin_wall', false)
      c.set('overhang_reverse', false)
      c.set('timelapse_type', '0')
      c.set('enable_wrapping_detection', false)
    } else c.set('spiral_mode', false)
  }

  if (c.bool('alternate_extra_wall') && c.str('ensure_vertical_shell_thickness') === 'ensure_all') {
    if (await h.ask({
      title: 'Alternate extra wall',
      body: "Alternate extra wall doesn't work well when ensure vertical shell thickness is set to All.\n\n" +
        'Change these settings automatically?\n' +
        'Yes - Change ensure vertical shell thickness to Moderate and enable alternate extra wall\n' +
        "No - Don't use alternate extra wall",
      yes: 'Yes', no: 'No',
    })) {
      c.set('ensure_vertical_shell_thickness', 'ensure_moderate')
      c.set('alternate_extra_wall', true)
    } else {
      c.set('ensure_vertical_shell_thickness', 'ensure_all')
      c.set('alternate_extra_wall', false)
    }
  }

  // Bambu Lab printers have no cone wipe tower (silent).
  if (c.bool('enable_prime_tower') && c.str('wipe_tower_wall_type') === 'cone') c.set('wipe_tower_wall_type', 'rectangle')

  // Turning support on turns overhang detection on, once per enabling (silent).
  if (c.bool('enable_support')) {
    if (!state.overhangsQueried) {
      state.overhangsQueried = true
      if (!c.bool('detect_overhang_wall')) c.set('detect_overhang_wall', true)
    }
  } else state.overhangsQueried = false

  if (c.bool('enable_support')) {
    const tree = c.str('support_type').startsWith('tree')
    const styles = tree ? ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'organic'] : ['default', 'grid', 'snug']
    if (!styles.includes(c.str('support_style'))) c.set('support_style', 'default')
  }

  // A support filament past the last slot falls back to Default (Orca uses
  // the plater's value, which is this same config) (silent). Runs when the
  // filament count changes too (processUpdate).
  for (const k of ['support_filament', 'support_interface_filament'])
    if (c.int(k) > h.filaments.length) c.set(k, 0)

  if (c.str('seam_slope_type') !== 'none' && c.abs('seam_slope_start_height', 'layer_height') >= layerHeight) {
    h.notify('Scarf joint start height must be smaller than the layer height. Reset to 0.')
    c.set('seam_slope_start_height', 0)
  }

  const skinDepth = c.num('skin_infill_depth')
  if (c.num('infill_lock_depth') > skinDepth) {
    h.notify('Lock depth should be smaller than skin depth. Reset to 50% of skin depth.')
    c.set('infill_lock_depth', skinDepth / 2)
  }

  if (c.str('fuzzy_skin_mode') !== 'displacement' && c.str('wall_generator') !== 'arachne') {
    if (await h.ask({
      title: 'Fuzzy skin',
      body: 'Both [Extrusion] and [Combined] modes of Fuzzy Skin require the Arachne Wall Generator to be enabled.\n\n' +
        'Change these settings automatically?\n' +
        'Yes - Enable Arachne Wall Generator\n' +
        'No - Disable Arachne Wall Generator and set [Displacement] mode of the Fuzzy Skin',
      yes: 'Enable Arachne', no: 'Use Displacement',
    })) c.set('wall_generator', 'arachne')
    else c.set('fuzzy_skin_mode', 'displacement')
  }
}

/** The values ConfigManipulation::toggle_print_fff_options forces (all silent). */
function toggleSideEffects(c: Cfg) {
  if (c.num('max_volumetric_extrusion_rate_slope') > 0 && c.bool('enable_arc_fitting')) c.set('enable_arc_fitting', false)
  if (c.num('max_volumetric_extrusion_rate_slope_segment_length') < 0.5) c.set('max_volumetric_extrusion_rate_slope_segment_length', 1)
  if (c.num('sparse_infill_density') > 0 && !MULTILINE_PATTERNS.has(c.str('sparse_infill_pattern')) && c.int('fill_multiline') !== 1)
    c.set('fill_multiline', 1)
  if (c.bool('overhang_reverse_internal_only')) c.set('overhang_reverse_threshold', '0%')
}
