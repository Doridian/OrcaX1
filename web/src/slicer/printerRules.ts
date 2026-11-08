// What Orca does to other printer values when one changes: the value side of
// the printer tab in OrcaSlicer v2.4.2 (src/slic3r/GUI/Tab.cpp), next to the
// show/hide rules in presetToggles.ts. Ported from
//   - Tab::on_value_change, the printer keys: gcode_flavor (input shaper type),
//     single_extruder_multi_material (purge in prime tower), the long
//     retraction warning, and the option groups' custom G-code check;
//   - TabPrinter::toggle_options, which TabPrinter::update() runs after every
//     change: firmware retraction needs "retract before wipe" at 100%,
//     manual filament change needs single-extruder multi-material, and the
//     input shaper type has to be one the firmware flavour offers.
// toggle_options only acts on the page that is open in Orca; here it runs for
// every page, since the values it corrects are wrong on any page.
//
// Left out, because a single-extruder X1 can't reach them: the extruder count
// (and filament count sync), nozzle diameters of several extruders, per-extruder
// layer height limits, and parallel printheads.

import { gcodeWarning } from './gcodeCheck'
import type { Question } from './configRules'

export interface PrinterRuleHost {
  /** Effective printer value for the active nozzle-flow variant. */
  get(key: string): string
  /** Every variant's value of a per-variant option. */
  getAll(key: string): string[]
  /** Writes the active variant's value (without running the rules again). */
  set(key: string, value: string): void
  /** Writes every variant's value. */
  setAll(key: string, values: string[]): void
  /** Yes/No dialog; resolves true for Yes. */
  ask(q: Question): Promise<boolean>
  /** Non-blocking warning (Orca's OK-only message boxes). */
  notify(text: string): void
}

export interface PrinterChangeResult {
  /** Orca runs the print tab's update() for this change (TabPrint::update via get_tab(TYPE_PRINT)->update()). */
  processUpdate: boolean
}

const isTrue = (v: string) => v === '1' || v === 'true'

/** input_shaper_types_for_flavor: the input shaper types each firmware flavour offers (the first is the fallback). */
export function inputShaperTypes(flavor: string): string[] {
  switch (flavor) {
    case 'klipper': return ['Default', 'ZV', 'MZV', 'ZVD', 'EI', '2HUMP_EI', '3HUMP_EI', 'Disable']
    case 'reprapfirmware': return ['Default', 'MZV', 'ZVD', 'ZVDD', 'ZVDDD', 'EI2', 'EI3', 'DAA', 'Disable']
    case 'marlin2': return ['ZV', 'Disable']
    default: return ['Default', 'Disable']
  }
}

/** Runs Orca's reaction to the user changing printer option `key` (already written). */
export async function printerChanged(key: string, h: PrinterRuleHost): Promise<PrinterChangeResult> {
  let processUpdate = false
  const value = h.get(key)

  const gcode = gcodeWarning(key, value)
  if (gcode) h.notify(gcode)

  if (key === 'long_retractions_when_cut' && value === '1') {
    h.notify('Experimental feature: Retracting and cutting off the filament at a greater distance during filament changes to minimize flush. '
      + 'Although it can notably reduce flush, it may also elevate the risk of nozzle clogs or other printing complications.')
  }
  if (key === 'single_extruder_multi_material' || key === 'purge_in_prime_tower') processUpdate = true
  // Orca: purge in prime tower needs single-extruder multi-material.
  if (key === 'single_extruder_multi_material' && !isTrue(value) && isTrue(h.get('purge_in_prime_tower'))) h.set('purge_in_prime_tower', '0')

  await printerUpdate(h)
  return { processUpdate }
}

/** TabPrinter::update() -> toggle_options(): the values it corrects. Repeats until nothing changes (load_config re-runs it). */
export async function printerUpdate(h: PrinterRuleHost): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    let changed = false
    const set = (k: string, v: string) => { if (h.get(k) !== v) { h.set(k, v); changed = true } }

    // Multimaterial page
    if (!isTrue(h.get('single_extruder_multi_material')) && isTrue(h.get('manual_filament_change'))) set('manual_filament_change', '0')

    // Extruder page: firmware retraction can only work with "retract before wipe" at 100%.
    const firmware = isTrue(h.get('use_firmware_retraction'))
    const retraction = (parseFloat(h.get('retraction_length')) || 0) > 0 || firmware
    const wipe = retraction && isTrue(h.get('wipe'))
    if (firmware && wipe && (parseFloat(h.get('retract_before_wipe')) || 0) < 100) {
      if (await h.ask({
        title: 'Firmware Retraction',
        body: 'The Retract before wipe option could be only 100% when using the Firmware Retraction mode.\n\n'
          + 'Shall I set it to 100% in order to enable Firmware Retraction?',
        yes: 'Yes', no: 'No',
      })) {
        // Every variant, as Orca does.
        h.setAll('wipe', h.getAll('wipe').map(() => '0'))
        h.setAll('retract_before_wipe', h.getAll('retract_before_wipe').map(() => '100%'))
      } else h.set('use_firmware_retraction', '0')
      changed = true
    }

    // Motion ability page: update_input_shaper_menu.
    const allowed = inputShaperTypes(h.get('gcode_flavor'))
    if (!allowed.includes(h.get('input_shaping_type'))) set('input_shaping_type', allowed[0])

    if (!changed) break
  }
}
