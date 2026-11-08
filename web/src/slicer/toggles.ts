// Which process options Orca hides or greys out for the current values.
// A port of ConfigManipulation::toggle_print_fff_options from OrcaSlicer
// v2.4.2 (src/slic3r/GUI/ConfigManipulation.cpp): toggle_line hides an
// option, toggle_field disables it. The printer is always a Bambu Lab X1.
// The values that function also forces are in configRules.ts, which runs when
// a value changes.

import type { Settings } from './profiles'

export interface Toggles { hidden: Set<string>; disabled: Set<string> }

/** Sparse infill patterns that support fill_multiline. */
export const MULTILINE_PATTERNS = new Set([
  'gyroid', 'grid', 'rectilinear', 'tpmsd', 'tpmsfk', 'crosshatch', 'honeycomb', 'lateral-lattice', 'lateral-honeycomb',
  'concentric', 'cubic', 'stars', 'alignedrectilinear', 'lightning', '3dhoneycomb', 'adaptivecubic', 'supportcubic',
  'triangles', 'quartercubic', 'archimedeanchords', 'hilbertcurve', 'octagramspiral',
])

/**
 * @param get effective value of a process option (preset, override or Orca default)
 * @param printer the printer preset's settings
 */
export function processToggles(get: (key: string) => string, printer: Settings): Toggles {
  const hidden = new Set<string>()
  const disabled = new Set<string>()
  const line = (k: string, on: boolean) => { if (!on) hidden.add(k) }
  const field = (k: string, on: boolean) => { if (on) disabled.delete(k); else disabled.add(k) }
  const num = (k: string) => parseFloat(get(k)) || 0
  const bool = (k: string) => get(k) === '1' || get(k) === 'true'
  const str = (k: string) => get(k)
  const pv = (k: string) => { const v = printer[k]; return Array.isArray(v) ? v[0] : v }

  const gcfMarlin = pv('gcode_flavor') === 'marlin2'
  const gcfKlipper = pv('gcode_flavor') === 'klipper'
  const isBBL = true

  const slope = num('max_volumetric_extrusion_rate_slope') > 0
  field('enable_arc_fitting', !slope)
  line('max_volumetric_extrusion_rate_slope_segment_length', slope)
  line('extrusion_rate_smoothing_external_perimeter_only', slope)

  const havePerimeters = num('wall_loops') > 0
  for (const el of ['extra_perimeters_on_overhangs', 'ensure_vertical_shell_thickness', 'detect_thin_wall', 'detect_overhang_wall',
    'seam_position', 'staggered_inner_seams', 'wall_sequence', 'outer_wall_line_width',
    'inner_wall_speed', 'outer_wall_speed', 'small_perimeter_speed', 'small_perimeter_threshold']) field(el, havePerimeters)

  const haveInfill = num('sparse_infill_density') > 0
  for (const el of ['sparse_infill_pattern', 'infill_combination', 'fill_multiline', 'infill_direction',
    'minimum_sparse_infill_area', 'sparse_infill_filament_id', 'infill_anchor', 'infill_anchor_max', 'infill_shift_step',
    'sparse_infill_rotate_template', 'symmetric_infill_y_axis']) line(el, haveInfill)
  line('infill_combination_max_layer_height', bool('infill_combination') && haveInfill)

  const pattern = str('sparse_infill_pattern')
  line('gyroid_optimized', haveInfill && pattern === 'gyroid')
  if (haveInfill) {
    field('fill_multiline', MULTILINE_PATTERNS.has(pattern))
    const anchor = pattern !== 'line'
    field('infill_anchor_max', anchor)
    field('infill_anchor', anchor && num('infill_anchor_max') > 0)
  }

  const crossZag = pattern === 'crosszag'
  const lockedZag = pattern === 'lockedzag'
  line('infill_shift_step', crossZag || lockedZag)
  for (const el of ['skeleton_infill_density', 'skin_infill_density', 'infill_lock_depth', 'skin_infill_depth', 'skin_infill_line_width', 'skeleton_infill_line_width'])
    line(el, lockedZag)
  line('symmetric_infill_y_axis', pattern === 'zigzag' || crossZag || lockedZag)

  const spiral = bool('spiral_mode')
  line('spiral_mode_smooth', spiral)
  line('spiral_mode_max_xy_smoothing', spiral && bool('spiral_mode_smooth'))
  line('spiral_starting_flow_ratio', spiral)
  line('spiral_finishing_flow_ratio', spiral)
  const hasTopShell = num('top_shell_layers') > 0 || (spiral && num('bottom_shell_layers') > 1)
  const hasBottomShell = num('bottom_shell_layers') > 0
  const hasSolidInfill = hasTopShell || hasBottomShell
  field('top_surface_pattern', hasTopShell)
  field('bottom_surface_pattern', hasBottomShell)
  field('top_surface_density', hasTopShell)
  field('bottom_surface_density', hasBottomShell)
  for (const el of ['infill_direction', 'sparse_infill_line_width', 'gap_fill_target', 'filter_out_gap_fill', 'infill_wall_overlap',
    'sparse_infill_speed', 'bridge_speed', 'internal_bridge_speed', 'bridge_angle', 'internal_bridge_angle', 'relative_bridge_angle',
    'solid_infill_direction', 'solid_infill_rotate_template', 'internal_solid_infill_pattern', 'internal_solid_filament_id',
    'top_surface_filament_id', 'bottom_surface_filament_id']) field(el, haveInfill || hasSolidInfill)
  field('top_shell_thickness', !spiral && hasTopShell)
  field('bottom_shell_thickness', !spiral && hasBottomShell)
  field('gap_infill_speed', havePerimeters)
  for (const el of ['top_surface_line_width', 'top_surface_speed']) field(el, hasTopShell)

  const haveAccel = num('default_acceleration') > 0
  for (const el of ['outer_wall_acceleration', 'inner_wall_acceleration', 'initial_layer_acceleration', 'initial_layer_travel_acceleration',
    'top_surface_acceleration', 'travel_acceleration', 'bridge_acceleration', 'sparse_infill_acceleration', 'internal_solid_infill_acceleration'])
    field(el, haveAccel)

  const jd = gcfMarlin && (parseFloat(pv('machine_max_junction_deviation') ?? '') || 0) > 0
  line('default_junction_deviation', gcfMarlin)
  field('default_junction_deviation', jd)
  field('default_jerk', !jd)
  const jerks = ['outer_wall_jerk', 'inner_wall_jerk', 'initial_layer_jerk', 'initial_layer_travel_jerk', 'top_surface_jerk', 'travel_jerk', 'infill_jerk']
  if (jd) for (const el of jerks) line(el, false)
  else for (const el of jerks) field(el, num('default_jerk') > 0)

  const haveSkirt = num('skirt_loops') > 0
  field('skirt_height', haveSkirt && str('draft_shield') !== 'enabled')
  line('single_loop_draft_shield', haveSkirt)
  for (const el of ['skirt_type', 'min_skirt_length', 'skirt_distance', 'skirt_start_angle', 'skirt_speed', 'draft_shield']) field(el, haveSkirt)

  const brim = str('brim_type')
  const haveBrim = brim !== 'no_brim'
  field('brim_object_gap', haveBrim)
  field('brim_use_efc_outline', haveBrim)
  field('combine_brims', haveBrim)
  field('brim_width', haveBrim && brim !== 'auto_brim' && brim !== 'painted')
  field('brim_flow_ratio', haveBrim)
  field('outer_wall_filament_id', havePerimeters || haveBrim)
  field('inner_wall_filament_id', havePerimeters || haveBrim)
  const brimEar = brim === 'brim_ears'
  field('brim_ears_max_angle', num('brim_width') > 0)
  field('brim_ears_detection_length', num('brim_width') > 0)
  line('brim_ears_max_angle', brimEar)
  line('brim_ears_detection_length', brimEar)

  const efcDensity = str('elefant_foot_layers_density')
  line('elefant_foot_compensation_layers', num('elefant_foot_compensation') > 0 || (efcDensity !== '' && parseFloat(efcDensity) < 100))

  const haveRaft = num('raft_layers') > 0
  const haveSupport = bool('enable_support') || haveRaft
  const supportType = str('support_type')
  const isAuto = supportType === 'normal(auto)' || supportType === 'tree(auto)'
  const isTree = supportType === 'tree(auto)' || supportType === 'tree(manual)'
  const haveInterface = num('support_interface_top_layers') > 0 || num('support_interface_bottom_layers') > 0
  const soluble = haveSupport && num('support_top_z_distance') === 0
  const style = str('support_style')
  for (const el of ['support_style', 'support_base_pattern', 'support_base_pattern_spacing', 'support_expansion', 'support_angle',
    'support_interface_pattern', 'support_interface_top_layers', 'support_interface_bottom_layers',
    'bridge_no_support', 'max_bridge_length', 'support_top_z_distance', 'support_bottom_z_distance',
    'support_type', 'support_on_build_plate_only', 'support_critical_regions_only', 'support_interface_not_for_body',
    'support_object_xy_distance', 'support_object_first_layer_gap', 'independent_support_layer_height']) field(el, haveSupport)
  field('support_threshold_angle', haveSupport && isAuto)
  field('support_threshold_overlap', num('support_threshold_angle') === 0 && haveSupport && isAuto)

  const tree = bool('enable_support') && isTree
  const organic = tree && (style === 'organic' || style === 'default')
  const normalTree = tree && !organic
  line('support_threshold_overlap', !tree)
  for (const el of ['tree_support_branch_angle', 'tree_support_branch_distance', 'tree_support_branch_diameter', 'tree_support_auto_brim', 'tree_support_brim_width'])
    line(el, normalTree)
  for (const el of ['tree_support_branch_angle_organic', 'tree_support_branch_distance_organic', 'tree_support_branch_diameter_organic',
    'tree_support_angle_slow', 'tree_support_tip_diameter', 'tree_support_top_rate', 'tree_support_branch_diameter_angle'])
    line(el, organic)
  line('independent_support_layer_height', haveSupport && !organic)
  field('tree_support_brim_width', tree && !bool('tree_support_auto_brim'))
  line('max_bridge_length', tree)
  line('bridge_no_support', !tree)
  line('support_critical_regions_only', isAuto && tree)
  for (const el of ['support_interface_filament', 'support_interface_loop_pattern', 'support_bottom_interface_spacing'])
    field(el, haveSupport && haveInterface)

  const canIronSupport = haveRaft || (haveSupport && num('support_interface_top_layers') > 0)
  field('support_ironing', canIronSupport)
  const supportIroning = canIronSupport && bool('support_ironing')
  for (const el of ['support_ironing_pattern', 'support_ironing_flow', 'support_ironing_spacing']) line(el, supportIroning)
  field('support_interface_spacing', haveSupport && haveInterface && !supportIroning)

  field('inner_wall_line_width', havePerimeters || haveSkirt || haveBrim)
  field('support_filament', haveSupport || haveSkirt)
  line('raft_contact_distance', haveRaft && !soluble)
  field('raft_first_layer_density', haveSupport)
  field('raft_first_layer_expansion', haveSupport && ((!normalTree || style === 'tree_hybrid') || haveRaft))

  const ironing = str('ironing_type') !== 'no ironing'
  for (const el of ['ironing_pattern', 'ironing_flow', 'ironing_spacing', 'ironing_angle', 'ironing_inset', 'ironing_angle_fixed']) line(el, ironing)
  for (const el of ['ironing_angle', 'ironing_angle_fixed']) field(el, ironing && str('ironing_pattern') === 'rectilinear')
  line('ironing_speed', ironing || supportIroning)

  const zaa = bool('zaa_enabled')
  for (const el of ['zaa_minimize_perimeter_height', 'zaa_min_z', 'zaa_dont_alternate_fill_direction', 'ironing_expansion']) line(el, zaa)

  field('print_order', str('print_sequence') !== 'by object')
  field('single_extruder_multi_material', !isBBL)

  const semm = pv('single_extruder_multi_material') === '1'
  const wipeTower2 = !isBBL && pv('wipe_tower_type') === 'type2'
  field('ooze_prevention', !semm)
  const ooze = bool('ooze_prevention')
  line('standby_temperature_delta', ooze)
  line('preheat_time', ooze)
  line('preheat_steps', ooze && num('preheat_steps') > 0)

  const tower = bool('enable_prime_tower')
  for (const el of ['prime_tower_width', 'prime_tower_brim_width', 'prime_tower_skip_points', 'wipe_tower_wall_type', 'prime_tower_infill_gap',
    'prime_tower_enable_framework', 'enable_tower_interface_features']) line(el, tower)
  line('enable_tower_interface_cooldown_during_tower', tower && bool('enable_tower_interface_features'))
  for (const el of ['wipe_tower_rotation_angle', 'wipe_tower_cone_angle', 'wipe_tower_extra_spacing', 'wipe_tower_max_purge_speed',
    'wipe_tower_bridging', 'wipe_tower_extra_flow', 'wipe_tower_no_sparse_layers']) line(el, tower && wipeTower2)
  const wallType = str('wipe_tower_wall_type')
  const rib = wallType === 'rib' && tower
  line('wipe_tower_cone_angle', tower && wipeTower2 && wallType === 'cone')
  line('wipe_tower_extra_rib_length', rib)
  line('wipe_tower_rib_width', rib)
  line('wipe_tower_fillet_wall', rib)
  field('prime_tower_width', tower && (wipeTower2 || rib))
  line('single_extruder_multi_material_priming', !semm && tower && wipeTower2)
  line('prime_volume', tower && (pv('purge_in_prime_tower') !== '1' || !semm))
  for (const el of ['flush_into_infill', 'flush_into_support', 'flush_into_objects']) field(el, tower)

  line('max_travel_detour_distance', bool('reduce_crossing_wall'))

  const otherFlows = bool('set_other_flow_ratios')
  for (const el of ['first_layer_flow_ratio', 'outer_wall_flow_ratio', 'inner_wall_flow_ratio', 'overhang_flow_ratio', 'sparse_infill_flow_ratio',
    'internal_solid_infill_flow_ratio', 'gap_fill_flow_ratio', 'support_flow_ratio', 'support_interface_flow_ratio']) line(el, otherFlows)

  const overhangSpeed = bool('enable_overhang_speed')
  for (const el of ['overhang_1_4_speed', 'overhang_2_4_speed', 'overhang_3_4_speed', 'overhang_4_4_speed']) line(el, overhangSpeed)
  line('slowdown_for_curled_perimeters', overhangSpeed)

  // Per-object only; this is the global (plate) config.
  line('flush_into_objects', false)
  line('support_interface_not_for_body', num('support_interface_filament') !== 0 && num('support_filament') === 0)

  const fuzzy = str('fuzzy_skin') !== 'disabled_fuzzy'
  for (const el of ['fuzzy_skin_mode', 'fuzzy_skin_noise_type', 'fuzzy_skin_point_distance', 'fuzzy_skin_thickness', 'fuzzy_skin_first_layer'])
    line(el, fuzzy)
  const noise = str('fuzzy_skin_noise_type')
  const ripple = noise === 'ripple'
  line('fuzzy_skin_scale', noise !== 'classic' && fuzzy && !ripple)
  line('fuzzy_skin_octaves', noise !== 'classic' && noise !== 'voronoi' && fuzzy && !ripple)
  line('fuzzy_skin_persistence', (noise === 'perlin' || noise === 'billow') && fuzzy && !ripple)
  line('fuzzy_skin_ripples_per_layer', ripple && fuzzy)
  line('fuzzy_skin_ripple_offset', ripple && fuzzy)
  line('fuzzy_skin_layers_between_ripple_offset', ripple && fuzzy)

  const arachne = str('wall_generator') === 'arachne'
  for (const el of ['wall_transition_length', 'wall_transition_filter_deviation', 'wall_transition_angle', 'min_feature_size', 'min_length_factor',
    'min_bead_width', 'wall_distribution_count', 'initial_layer_min_bead_width', 'wall_maximum_resolution', 'wall_maximum_deviation'])
    line(el, arachne)
  field('detect_thin_wall', !arachne)

  field('wipe_speed', !bool('role_based_wipe_speed'))

  for (const el of ['accel_to_decel_enable', 'accel_to_decel_factor']) line(el, gcfKlipper)
  if (gcfKlipper) field('accel_to_decel_factor', bool('accel_to_decel_enable'))

  const printable = bool('make_overhang_printable')
  line('make_overhang_printable_angle', printable)
  line('make_overhang_printable_hole_size', printable)

  line('min_width_top_surface', bool('only_one_wall_top') || (num('min_length_factor') > 0.5 && arachne))
  for (const el of ['hole_to_polyhole_threshold', 'hole_to_polyhole_twisted']) line(el, bool('hole_to_polyhole'))

  const allowReverse = !spiral
  line('overhang_reverse', allowReverse)
  line('overhang_reverse_internal_only', allowReverse && bool('overhang_reverse'))
  line('overhang_reverse_threshold', bool('detect_overhang_wall') && allowReverse && bool('overhang_reverse') && !bool('overhang_reverse_internal_only'))
  line('timelapse_type', isBBL)

  line('small_area_infill_flow_compensation_model', bool('small_area_infill_flow_compensation'))

  field('seam_slope_type', !spiral)
  const scarf = !spiral && str('seam_slope_type') !== 'none'
  for (const el of ['seam_slope_conditional', 'seam_slope_start_height', 'seam_slope_entire_loop', 'seam_slope_min_length',
    'seam_slope_steps', 'seam_slope_inner_walls', 'scarf_joint_speed', 'scarf_joint_flow_ratio']) line(el, scarf)
  field('seam_slope_min_length', !bool('seam_slope_entire_loop'))
  line('scarf_angle_threshold', scarf && bool('seam_slope_conditional'))
  line('scarf_overhang_threshold', scarf && bool('seam_slope_conditional'))

  const beam = bool('interlocking_beam')
  line('mmu_segmented_region_interlocking_depth', !beam)
  for (const el of ['interlocking_beam_width', 'interlocking_orientation', 'interlocking_beam_layer_count', 'interlocking_depth', 'interlocking_boundary_avoidance'])
    line(el, beam)

  for (const el of ['lateral_lattice_angle_1', 'lateral_lattice_angle_2']) line(el, pattern === 'lateral-lattice')
  for (const el of ['lightning_overhang_angle', 'lightning_prune_angle', 'lightning_straightening_angle']) line(el, pattern === 'lightning')

  const adaptive = pattern === 'adaptivecubic' || pattern === 'supportcubic'
  field('sparse_infill_rotate_template', !adaptive)
  field('infill_direction', str('sparse_infill_rotate_template') === '' && !adaptive)
  field('solid_infill_direction', str('solid_infill_rotate_template') === '')
  line('infill_overhang_angle', pattern === 'lateral-honeycomb')

  // Wrapping detection is for printers with that sensor (H2D and newer), not the X1.
  line('enable_wrapping_detection', false)

  return { hidden, disabled }
}
