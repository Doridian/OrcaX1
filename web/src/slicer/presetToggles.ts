// Which filament and printer options Orca hides or greys out for the current
// values. Ports of TabFilament::toggle_options / update_filament_overrides_page
// and TabPrinter::toggle_options from OrcaSlicer v2.4.2
// (src/slic3r/GUI/Tab.cpp), for a Bambu Lab printer with one extruder.
// toggle_line hides an option, toggle_option disables it. Orca's prompts that
// also change values (e.g. firmware retraction forcing "retract before wipe"
// to 100%) are not ported.

import type { Toggles } from './toggles'

type Get = (key: string) => string

function toggler() {
  const hidden = new Set<string>()
  const disabled = new Set<string>()
  return {
    hidden,
    disabled,
    line: (keys: string | string[], on: boolean) => { if (!on) for (const k of [keys].flat()) hidden.add(k) },
    field: (keys: string | string[], on: boolean) => { for (const k of [keys].flat()) if (on) disabled.delete(k); else disabled.add(k) },
  }
}

const isTrue = (v: string) => v === '1' || v === 'true'
const isNil = (v: string) => v === 'nil' || v === ''

/** Keys on the filament's "Setting Overrides" page that fall back to the printer's retraction settings. */
export const FILAMENT_RETRACTION_OVERRIDES = [
  'filament_retraction_length', 'filament_z_hop', 'filament_z_hop_types', 'filament_retract_lift_above',
  'filament_retract_lift_below', 'filament_retract_lift_enforce', 'filament_retraction_speed', 'filament_deretraction_speed',
  'filament_retract_restart_extra', 'filament_retraction_minimum_travel', 'filament_retract_when_changing_layer',
  'filament_wipe', 'filament_wipe_distance', 'filament_retract_before_wipe', 'filament_long_retractions_when_cut',
  'filament_retraction_distances_when_cut',
]

/**
 * @param get effective value of a filament option (active variant)
 * @param printer effective value of a printer option (active variant)
 * @returns hidden/disabled sets; `locked` holds "nil"-able options whose override checkbox Orca disables
 */
export function filamentToggles(get: Get, printer: Get): Toggles & { locked: Set<string> } {
  const { hidden, disabled, line, field } = toggler()
  const locked = new Set<string>()
  const bool = (k: string) => isTrue(get(k))

  // Cooling
  field(['overhang_fan_speed', 'overhang_fan_threshold', 'internal_bridge_fan_speed'], bool('enable_overhang_bridge_fan'))
  field('dont_slow_down_outer_wall', bool('slow_down_for_layer_cooling'))
  line('additional_cooling_fan_speed', isTrue(printer('auxiliary_fan')))
  const airFiltration = isTrue(printer('support_air_filtration'))
  // toggle_line on these hides their whole lines.
  line(['activate_air_filtration', 'activate_air_filtration_during_print', 'during_print_exhaust_fan_speed',
    'activate_air_filtration_on_completion', 'complete_print_exhaust_fan_speed'], airFiltration)
  if (airFiltration) {
    const on = bool('activate_air_filtration')
    field('activate_air_filtration_during_print', on)
    field('during_print_exhaust_fan_speed', on && bool('activate_air_filtration_during_print'))
    field('activate_air_filtration_on_completion', on)
    field('complete_print_exhaust_fan_speed', on && bool('activate_air_filtration_on_completion'))
  }

  // Filament
  const pa = bool('enable_pressure_advance')
  field(['pressure_advance', 'adaptive_pressure_advance', 'adaptive_pressure_advance_overhangs'], pa)
  const adaptivePa = bool('adaptive_pressure_advance') && pa
  line(['adaptive_pressure_advance_overhangs', 'adaptive_pressure_advance_model', 'adaptive_pressure_advance_bridges'], adaptivePa)
  // Bambu printers show every plate type's bed temperatures.
  const pellet = isTrue(printer('pellet_modded_printer'))
  line('pellet_flow_coefficient', pellet)
  line('filament_diameter', !pellet)
  line('activate_chamber_temp_control', isTrue(printer('support_chamber_temp_control')))
  field('filament_adaptive_volumetric_speed', get('volumetric_speed_coefficients') !== '0 0 0 0 0 0')

  // Setting Overrides (update_filament_overrides_page)
  const retract = get('filament_retraction_length')
  const haveRetractLength = isNil(retract) || (parseFloat(retract) || 0) > 0
  const longCut = Number(printer('enable_long_retraction_when_cut')) === 2 // LongRectrationLevel::EnableFilament
  for (const k of FILAMENT_RETRACTION_OVERRIDES) {
    if (k !== 'filament_retraction_length' && !haveRetractLength) locked.add(k)
  }
  line('filament_long_retractions_when_cut', longCut)
  line('filament_retraction_distances_when_cut', longCut && get('filament_long_retractions_when_cut') === '1')

  // Multimaterial: Orca hides the single-extruder MMU tool change settings for Bambu printers.
  field(['filament_minimal_purge_on_wipe_tower', 'filament_loading_speed_start', 'filament_loading_speed',
    'filament_unloading_speed_start', 'filament_unloading_speed', 'filament_toolchange_delay', 'filament_cooling_moves',
    'filament_cooling_initial_speed', 'filament_cooling_final_speed'], false)
  const multitool = bool('filament_multitool_ramming')
  field(['filament_multitool_ramming_volume', 'filament_multitool_ramming_flow'], multitool)
  // Only for Bambu printers with several extruders (H2D); the X1 has one.
  line(['long_retractions_when_ec', 'retraction_distances_when_ec'], false)

  return { hidden, disabled, locked }
}

/** @param get effective value of a printer option (active variant) */
export function printerToggles(get: Get): Toggles {
  const { hidden, disabled, line, field } = toggler()
  const bool = (k: string) => isTrue(get(k))
  const num = (k: string) => parseFloat(get(k)) || 0
  const flavor = get('gcode_flavor')
  const marlinLegacy = flavor === 'marlin', marlin2 = flavor === 'marlin2', klipper = flavor === 'klipper', reprap = flavor === 'reprapfirmware'

  // Basic information: Bambu printers hide settings that only apply to other firmwares.
  line(['use_firmware_retraction', 'use_relative_e_distances', 'support_multi_bed_types', 'pellet_modded_printer',
    'bed_mesh_max', 'bed_mesh_min', 'bed_mesh_probe_distance', 'adaptive_bed_mesh_margin', 'thumbnails'], false)
  line('parallel_printheads_count', bool('support_parallel_printheads'))

  // Machine G-code: clumping detection exists on printers whose device config supports it (not the X1 series).
  line('wrapping_detection_gcode', false)

  // Multimaterial (wipe tower type 2 is never used on Bambu printers)
  line('wipe_tower_type', false)
  field(['enable_filament_ramming', 'cooling_tube_retraction', 'cooling_tube_length', 'parking_pos_retraction',
    'extra_loading_move', 'high_current_on_filament_swap'], false)
  const semm = bool('single_extruder_multi_material')
  field('manual_filament_change', semm)
  field('purge_in_prime_tower', false)
  field('tool_change_on_wipe_tower', false)

  // Extruder
  line(['extruder_printable_area', 'extruder_printable_height'], false) // only for two-extruder printers
  field(['extruder_printable_area', 'extruder_printable_height'], false)
  const firmwareRetraction = bool('use_firmware_retraction')
  const retraction = num('retraction_length') > 0 || firmwareRetraction
  field('retraction_minimum_travel', retraction)
  field(['z_hop', 'retract_when_changing_layer'], retraction)
  field(['retract_lift_above', 'retract_lift_below', 'retract_lift_enforce'], retraction && num('z_hop') > 0)
  field(['retraction_speed', 'deretraction_speed', 'retract_before_wipe', 'retract_restart_extra', 'wipe_distance'], retraction && !firmwareRetraction)
  const wipe = retraction && bool('wipe')
  field(['retract_before_wipe', 'wipe_distance'], wipe)
  field('retract_restart_extra_toolchange', num('retract_length_toolchange') > 0)
  field('long_retractions_when_cut', !firmwareRetraction && num('enable_long_retraction_when_cut') !== 0)
  line('retraction_distances_when_cut', bool('long_retractions_when_cut'))
  field('travel_slope', get('z_hop_types') !== 'Normal Lift')

  // Motion ability
  line('machine_max_acceleration_travel', !marlinLegacy && !klipper)
  line('machine_max_junction_deviation', marlin2)
  const jerk = !marlin2 || num('machine_max_junction_deviation') === 0
  field(['machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_jerk_z', 'machine_max_jerk_e'], jerk)
  field('emit_machine_limits_to_gcode', marlinLegacy || marlin2 || reprap)
  field(['min_resonance_avoidance_speed', 'max_resonance_avoidance_speed'], bool('resonance_avoidance'))
  const shaping = marlin2 || reprap
  line(['input_shaping_emit', 'input_shaping_type', 'input_shaping_freq_x', 'input_shaping_freq_y',
    'input_shaping_damp_x', 'input_shaping_damp_y'], shaping)
  if (shaping) {
    const emitLimits = bool('emit_machine_limits_to_gcode')
    field('input_shaping_emit', emitLimits)
    const emit = emitLimits && bool('input_shaping_emit')
    field(['input_shaping_type', 'input_shaping_freq_x', 'input_shaping_damp_x'], emit)
    field(['input_shaping_freq_y', 'input_shaping_damp_y'], emit && !reprap)
  }
  return { hidden, disabled }
}
