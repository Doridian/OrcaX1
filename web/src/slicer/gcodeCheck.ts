// Orca's check of custom G-code for comments the G-code processor uses as
// markers: Tab::validate_custom_gcode (src/slic3r/GUI/Tab.cpp) with
// GCodeProcessor::contains_reserved_tags and GCodeProcessor::Reserved_Tags
// (src/libslic3r/GCode/GCodeProcessor.cpp), OrcaSlicer v2.4.2. Bambu Lab
// printers use the Reserved_Tags list (not Reserved_Tags_compatible).
// Orca shows an OK-only message box; here it becomes a notice.

const RESERVED_TAGS = [
  ' FEATURE: ', ' WIPE_START', ' WIPE_END', ' LAYER_HEIGHT: ', ' LINE_WIDTH: ', ' CHANGE_LAYER', ' COLOR_CHANGE',
  ' PAUSE_PRINTING', ' CUSTOM_GCODE', '_GP_FIRST_LINE_M73_PLACEHOLDER', '_GP_LAST_LINE_M73_PLACEHOLDER',
  '_GP_ESTIMATED_PRINTING_TIME_PLACEHOLDER', '_GP_TOTAL_LAYER_NUMBER_PLACEHOLDER', ' MANUAL_TOOL_CHANGE ',
  '_DURING_PRINT_EXHAUST_FAN', ' WIPE_TOWER_START', ' WIPE_TOWER_END', ' PA_CHANGE:', '@PRINT_TIME_SEC@', '@USED_FILAMENT_LENGTH@',
]

/**
 * The G-code options whose option group validates them on change
 * (validate_custom_gcode_cb in TabPrint::build, TabFilament::build and
 * TabPrinter::build_fff), with the group title Orca names in the message.
 */
export const CHECKED_GCODE: Record<string, string> = {
  process_change_extrusion_role_gcode: 'Change extrusion role G-code',
  filament_start_gcode: 'Filament start G-code',
  filament_change_extrusion_role_gcode: 'Change extrusion role G-code',
  filament_end_gcode: 'Filament end G-code',
  file_start_gcode: 'File header G-code',
  machine_start_gcode: 'Machine start G-code',
  machine_end_gcode: 'Machine end G-code',
  printing_by_object_gcode: 'Printing by object G-code',
  before_layer_change_gcode: 'Before layer change G-code',
  layer_change_gcode: 'Layer change G-code',
  time_lapse_gcode: 'Timelapse G-code',
  wrapping_detection_gcode: 'Clumping Detection G-code',
  change_filament_gcode: 'Change filament G-code',
  change_extrusion_role_gcode: 'Change extrusion role G-code',
  machine_pause_gcode: 'Pause G-code',
  template_custom_gcode: 'Template Custom G-code',
}

/** Up to five comment lines that start with a reserved tag (contains_reserved_tags(gcode, 5, tags)). */
export function reservedTags(gcode: string): string[] {
  const found: string[] = []
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length <= 2 || line[0] !== ';') continue
    const comment = line.slice(1)
    for (const tag of RESERVED_TAGS) {
      if (comment.startsWith(tag)) {
        found.push(comment)
        if (found.length === 5) return found
      }
    }
  }
  return found
}

/** Orca's warning for `key` set to `gcode`, or null if it is fine (or not checked). */
export function gcodeWarning(key: string, gcode: string): string | null {
  const title = CHECKED_GCODE[key]
  if (!title) return null
  const tags = reservedTags(gcode)
  if (!tags.length) return null
  const lines = ':\n' + tags.map((t) => `;${t}\n`).join('')
  const text = tags.length === 1
    ? `Following line ${lines} contains reserved keywords.\nPlease remove it, or will beat G-code visualization and printing time estimation.`
    : `Following lines ${lines} contain reserved keywords.\nPlease remove them, or will beat G-code visualization and printing time estimation.`
  return `Reserved keywords found in ${title}.\n\n${text}`
}
