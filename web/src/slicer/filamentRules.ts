// Orca's checks after a filament value changes: ports of ConfigManipulation's
// check_nozzle_recommended_temperature_range, check_nozzle_temperature_range,
// check_nozzle_temperature_initial_layer_range, check_filament_max_volumetric_speed,
// check_chamber_temperature and check_chamber_minimal_temperature from
// OrcaSlicer v2.4.2 (src/slic3r/GUI/ConfigManipulation.cpp), as wired up in
// TabFilament (Tab.cpp). Orca shows these as OK-only message boxes; here they
// become notices. Orca has commented out the bed temperature checks.

/** Orca's MaterialType table: [min, max, chamberMin, chamberMax] per filament_type. */
export interface MaterialTemps { default: number[]; types: Record<string, number[]> }

export interface FilamentRuleHost {
  /** Effective filament value (active variant). */
  get(key: string): string
  set(key: string, value: string): void
  /** Effective printer value. */
  printer(key: string): string
  temps: MaterialTemps | undefined
  notify(text: string): void
}

const int = (v: string) => Math.trunc(Number(v) || 0)

function nozzleRange(h: FilamentRuleHost, key: string) {
  const low = int(h.get('nozzle_temperature_range_low')), high = int(h.get('nozzle_temperature_range_high'))
  const t = int(h.get(key))
  if (t < low || t > high) {
    h.notify('Nozzle may be blocked when the temperature is out of recommended range.\n'
      + 'Please make sure whether to use the temperature to print.\n\n'
      + `The recommended nozzle temperature for this filament type is [${low}, ${high}] degrees Celsius.`)
  }
}

function recommendedRange(h: FilamentRuleHost) {
  const low = int(h.get('nozzle_temperature_range_low')), high = int(h.get('nozzle_temperature_range_high'))
  let type = h.get('filament_type')
  const row = h.temps?.types[type]
  if (!row) type = 'Unknown'
  const [min, max] = row ?? h.temps?.default ?? [190, 300]
  let msg = ''
  if (low < min) msg += `A minimum temperature above ${min}℃ is recommended for ${type}.\n`
  if (high > max) msg += `A maximum temperature below ${max}℃ is recommended for ${type}.\n`
  if (low > high) msg += 'The recommended minimum temperature cannot be higher than the recommended maximum temperature.\n'
  if (msg) h.notify(msg + 'Please check.')
}

function chamberTemperature(h: FilamentRuleHost) {
  const v = h.printer('support_chamber_temp_control')
  if (v !== '1' && v !== 'true') return
  const row = h.temps?.types[h.get('filament_type')]
  if (row && row[3] < int(h.get('chamber_temperature'))) {
    h.notify('Current chamber temperature is higher than the material\'s safe temperature, this may result in material softening and clogging. '
      + `The maximum safe temperature for the material is ${row[3]}`)
  }
}

function chamberMinimal(h: FilamentRuleHost) {
  const min = int(h.get('chamber_minimal_temperature')), target = int(h.get('chamber_temperature'))
  if (min > target) {
    h.notify(`The minimal chamber temperature (${min}℃) is higher than the target chamber temperature (${target}℃). `
      + 'The minimal value is the threshold at which printing starts while the chamber keeps heating toward the target, '
      + 'so it should not exceed it. It will be clamped to the target.')
    h.set('chamber_minimal_temperature', String(target))
  }
}

/** Run Orca's checks for a changed filament option. */
export function filamentChanged(key: string, h: FilamentRuleHost) {
  switch (key) {
    case 'nozzle_temperature_range_low':
    case 'nozzle_temperature_range_high':
      return recommendedRange(h)
    case 'nozzle_temperature':
    case 'nozzle_temperature_initial_layer':
      return nozzleRange(h, key)
    case 'chamber_temperature':
      chamberTemperature(h)
      return chamberMinimal(h)
    case 'chamber_minimal_temperature':
      return chamberMinimal(h)
    case 'filament_max_volumetric_speed':
      // Orca runs this on every TabFilament::update; only this option can trigger it.
      if (h.get(key) !== '' && Number(h.get(key)) < 0.5) {
        h.notify('Too small max volumetric speed.\nReset to 0.5.')
        h.set(key, '0.5')
      }
  }
}
