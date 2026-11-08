#!/usr/bin/env node
// Headless check of Orca's value rules against the X1 profiles:
// web/src/slicer/configRules.ts (process), printerRules.ts, filamentRules.ts,
// gcodeCheck.ts, and the filament clamp of buildEngineConfig. Needs Node 23.6+ (TypeScript
// type stripping) and the profile bundle (scripts/build-profiles.mjs).
// Usage: node scripts/config-rules-check.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The web sources import without extensions (bundler resolution).
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx) } catch (e) {
      if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(spec + '.ts', ctx)
      throw e
    }
  },
})

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { processChanged, processUpdate, newRuleState } = await import(join(ROOT, 'web/src/slicer/configRules.ts'))
const { printerChanged } = await import(join(ROOT, 'web/src/slicer/printerRules.ts'))
const { filamentChanged } = await import(join(ROOT, 'web/src/slicer/filamentRules.ts'))
const { gcodeWarning } = await import(join(ROOT, 'web/src/slicer/gcodeCheck.ts'))
const { clampFilamentRefs } = await import(join(ROOT, 'web/src/slicer/profiles.ts'))
const bundle = JSON.parse(readFileSync(join(ROOT, 'web/public/profiles/bbl-x1.json'), 'utf8'))
const printer = bundle.printers.find((p) => p.name === 'Bambu Lab X1 Carbon 0.4 nozzle').settings
const preset = bundle.processes.find((p) => p.name === '0.20mm Standard @BBL X1C').settings
const filament = (name) => {
  const s = bundle.filaments.find((f) => f.name === name).settings
  return { type: s.filament_type[0], support: s.filament_is_support?.[0] === '1', soluble: s.filament_soluble?.[0] === '1' }
}
const PLA = filament('Bambu PLA Basic @BBL X1C')
const SUPPORT_PLA = filament('Bambu Support For PLA @BBL X1C')

/**
 * Sets `changes` as the user, runs the rules and returns the overrides, the
 * questions asked and the notices. `answers` are the replies to the questions, in order.
 */
async function run(changes, { answers = [], initial = {}, filaments = [PLA], used = ['PLA'], simple = false, state = newRuleState(), proc = preset, machine = printer, update = false } = {}) {
  const over = { ...initial }
  const get = (k) => {
    const v = over[k] ?? proc[k] ?? bundle.processSchema.options[k]?.default
    return (Array.isArray(v) ? v[0] : v) ?? ''
  }
  const asked = []
  const notices = []
  const host = {
    get,
    set: (k, v) => { over[k] = v },
    printer: machine,
    filaments,
    usedFilamentTypes: () => used,
    simpleMode: simple,
    ask: async (q) => {
      asked.push(q.title)
      assert.ok(asked.length <= answers.length, `unexpected question "${q.title}"`)
      return answers[asked.length - 1]
    },
    notify: (t) => notices.push(t),
  }
  for (const [k, v] of Object.entries(changes)) {
    const prev = get(k)
    over[k] = v
    await processChanged(k, prev, host, state)
  }
  if (update) await processUpdate(host, state)
  assert.equal(asked.length, answers.length, `asked ${JSON.stringify(asked)}`)
  return { get, over, asked, notices }
}

/** Printer rules on the X1C 0.4 preset (Standard flow: variant 0, machine limits [normal, silent] per variant). */
async function runPrinter(changes, { answers = [], initial = {} } = {}) {
  const over = { ...initial }
  const all = (k) => { const v = over[k] ?? printer[k] ?? bundle.printerSchema.options[k]?.default; return Array.isArray(v) ? v : v === undefined ? [] : [v] }
  const asked = [], notices = []
  const host = {
    get: (k) => all(k)[0] ?? '',
    getAll: all,
    set: (k, v) => { const cur = over[k] ?? printer[k]; over[k] = Array.isArray(cur) ? [v, ...cur.slice(1)] : v },
    setAll: (k, v) => { over[k] = v },
    ask: async (q) => {
      asked.push(q.title)
      assert.ok(asked.length <= answers.length, `unexpected question "${q.title}"`)
      return answers[asked.length - 1]
    },
    notify: (t) => notices.push(t),
  }
  let result
  for (const [k, v] of Object.entries(changes)) { host.set(k, v); result = await printerChanged(k, host) }
  assert.equal(asked.length, answers.length, `asked ${JSON.stringify(asked)}`)
  return { get: host.get, all, over, notices, result }
}

/** Filament rules on PLA Basic. */
function runFilament(changes) {
  const s = bundle.filaments.find((f) => f.name === 'Bambu PLA Basic @BBL X1C').settings
  const over = {}, notices = []
  const host = {
    get: (k) => { const v = over[k] ?? s[k] ?? bundle.filamentSchema.options[k]?.default; return (Array.isArray(v) ? v[0] : v) ?? '' },
    set: (k, v) => { over[k] = v },
    printer: (k) => { const v = printer[k]; return (Array.isArray(v) ? v[0] : v) ?? '' },
    temps: bundle.materialTemps,
    notify: (t) => notices.push(t),
  }
  for (const [k, v] of Object.entries(changes)) { over[k] = v; filamentChanged(k, host) }
  return { get: host.get, over, notices }
}

const tests = {
  async 'loading any stock process on any compatible printer changes and asks nothing'() {
    let n = 0
    for (const proc of bundle.processes) {
      for (const name of proc.compatible) {
        const machine = bundle.printers.find((p) => p.name === name)?.settings
        if (!machine) continue
        const r = await run({}, { proc: proc.settings, machine, update: true })
        assert.deepEqual(r.over, {}, `${proc.name} on ${name}`)
        assert.deepEqual(r.notices, [], `${proc.name} on ${name}`)
        n++
      }
    }
    assert.ok(n > 20, `only ${n} combinations`)
  },
  async 'removing a filament clamps the support filaments (Sidebar::delete_filament -> update)'() {
    const r = await run({}, { initial: { support_filament: '2', support_interface_filament: '2' }, update: true })
    assert.equal(r.get('support_filament'), '0')
    assert.equal(r.get('support_interface_filament'), '0')
    const keep = await run({}, { initial: { support_filament: '2' }, filaments: [PLA, SUPPORT_PLA], used: ['PLA'], update: true })
    assert.equal(keep.get('support_filament'), '2')
  },
  async 'engine config clamps filament references like full_fff_config'() {
    const p = { support_filament: '3', support_interface_filament: '-1', wipe_tower_filament: '2', outer_wall_filament_id: '3', top_surface_filament_id: '2', sparse_infill_layers: '3' }
    clampFilamentRefs(p, 2)
    assert.deepEqual(p, { support_filament: '2', support_interface_filament: '0', wipe_tower_filament: '2', outer_wall_filament_id: '0', top_surface_filament_id: '2', sparse_infill_layers: '3' })
  },
  async 'printer: firmware retraction, yes sets retract before wipe to 100% on every variant'() {
    const r = await runPrinter({ use_firmware_retraction: '1' }, { answers: [true] })
    assert.equal(r.get('use_firmware_retraction'), '1')
    assert.ok(r.all('wipe').every((v) => v === '0'))
    assert.ok(r.all('retract_before_wipe').every((v) => v === '100%'))
    assert.equal(r.all('wipe').length, printer.wipe.length)
  },
  async 'printer: firmware retraction, no turns it off again'() {
    const r = await runPrinter({ use_firmware_retraction: '1' }, { answers: [false] })
    assert.equal(r.get('use_firmware_retraction'), '0')
    assert.deepEqual(r.all('wipe'), printer.wipe)
  },
  async 'printer: firmware retraction without wipe asks nothing'() {
    const r = await runPrinter({ wipe: '0', use_firmware_retraction: '1' })
    assert.equal(r.get('use_firmware_retraction'), '1')
  },
  async 'printer: single-extruder MM off clears purge in prime tower and manual filament change, and reruns the process rules'() {
    const r = await runPrinter({ single_extruder_multi_material: '0' }, { initial: { purge_in_prime_tower: '1', manual_filament_change: '1' } })
    assert.equal(r.get('purge_in_prime_tower'), '0')
    assert.equal(r.get('manual_filament_change'), '0')
    assert.equal(r.result.processUpdate, true)
    assert.equal((await runPrinter({ printer_notes: 'x' })).result.processUpdate, false)
  },
  async 'printer: input shaper type follows the firmware flavour'() {
    assert.equal((await runPrinter({ input_shaping_type: 'MZV', gcode_flavor: 'marlin2' })).get('input_shaping_type'), 'ZV')
    assert.equal((await runPrinter({ gcode_flavor: 'klipper', input_shaping_type: 'EI' })).get('input_shaping_type'), 'EI')
    assert.equal((await runPrinter({ gcode_flavor: 'klipper', input_shaping_type: 'DAA' })).get('input_shaping_type'), 'Default')
  },
  async 'printer: long retraction warns, reserved G-code tags warn'() {
    assert.equal((await runPrinter({ long_retractions_when_cut: '1' })).notices.length, 1)
    const g = await runPrinter({ machine_end_gcode: 'M400\n; FEATURE: Custom\n' })
    assert.equal(g.notices.length, 1)
    assert.match(g.notices[0], /Machine end G-code[\s\S]*; FEATURE: Custom/)
    assert.equal((await runPrinter({ machine_end_gcode: printer.machine_end_gcode })).notices.length, 0)
  },
  async 'stock G-code of every preset has no reserved tags'() {
    for (const list of [bundle.printers, bundle.filaments, bundle.processes]) {
      for (const p of list) {
        for (const [k, v] of Object.entries(p.settings)) {
          for (const g of [v].flat()) assert.equal(gcodeWarning(k, g), null, `${p.name} ${k}`)
        }
      }
    }
  },
  async 'filament: diameter and pellet flow coefficient follow each other'() {
    const r = runFilament({ filament_diameter: '2' })
    assert.equal(Number(r.get('pellet_flow_coefficient')).toFixed(6), (4 / (4 * Math.PI)).toFixed(6))
    const k = runFilament({ pellet_flow_coefficient: String(4 / (1.75 * 1.75 * Math.PI)) })
    assert.equal(k.get('filament_diameter'), '1.75')
  },
  async 'filament: long retraction and G-code warnings'() {
    assert.equal(runFilament({ filament_long_retractions_when_cut: '1' }).notices.length, 1)
    assert.equal(runFilament({ filament_end_gcode: '; WIPE_START\n; WIPE_END\n' }).notices.length, 1)
  },
  async 'unrelated change on the stock preset does nothing'() {
    const r = await run({ outer_wall_speed: '150' })
    assert.deepEqual(r.over, { outer_wall_speed: '150' })
    assert.deepEqual(r.notices, [])
  },
  async 'spiral vase: yes adjusts walls, shells, infill, support'() {
    const r = await run({ enable_support: '1' }, { answers: [] })
    const s = await run({ spiral_mode: '1' }, { answers: [true], initial: r.over })
    assert.equal(s.get('spiral_mode'), '1')
    assert.equal(s.get('wall_loops'), '1')
    assert.equal(s.get('top_shell_layers'), '0')
    assert.equal(s.get('sparse_infill_density'), '0%')
    assert.equal(s.get('enable_support'), '0')
    assert.equal(s.get('timelapse_type'), '0')
  },
  async 'spiral vase: no turns it back off'() {
    const r = await run({ spiral_mode: '1' }, { answers: [false] })
    assert.equal(r.get('spiral_mode'), '0')
    assert.equal(r.get('wall_loops'), '2')
  },
  async 'spiral vase: already compatible asks nothing'() {
    const r = await run({ spiral_mode: '1' }, { initial: { wall_loops: '1', top_shell_layers: '0', sparse_infill_density: '0%' } })
    assert.equal(r.get('spiral_mode'), '1')
  },
  async 'extrusion rate smoothing turns arc fitting off'() {
    assert.equal((await run({})).get('enable_arc_fitting'), '1')
    const r = await run({ max_volumetric_extrusion_rate_slope: '300' })
    assert.equal(r.get('enable_arc_fitting'), '0')
  },
  async 'smoothing segment length below 0.5 becomes 1'() {
    assert.equal((await run({ max_volumetric_extrusion_rate_slope_segment_length: '0.2' })).get('max_volumetric_extrusion_rate_slope_segment_length'), '1')
  },
  async 'multiline infill reset for patterns without it'() {
    const r = await run({ fill_multiline: '3' })
    assert.equal(r.get('fill_multiline'), '3') // crosshatch supports it
    const z = await run({ sparse_infill_pattern: 'zigzag' }, { initial: { fill_multiline: '3' } })
    assert.equal(z.get('fill_multiline'), '1')
  },
  async 'reverse on internal only zeroes the threshold'() {
    assert.equal((await run({ overhang_reverse: '1', overhang_reverse_internal_only: '1' })).get('overhang_reverse_threshold'), '0%')
  },
  async 'layer height above the nozzle limit: adjust'() {
    const r = await run({ layer_height: '0.35' }, { answers: [true] })
    assert.equal(r.get('layer_height'), '0.28')
    assert.deepEqual(r.notices, [])
  },
  async 'layer height above the nozzle limit: ignore, then update_print_fff_config caps it'() {
    const r = await run({ layer_height: '0.35' }, { answers: [false] })
    assert.equal(r.get('layer_height'), '0.28')
    assert.equal(r.notices.length, 1)
  },
  async 'layer height below the nozzle limit: ignore keeps it'() {
    const r = await run({ layer_height: '0.06' }, { answers: [false] })
    assert.equal(r.get('layer_height'), '0.06')
  },
  async 'zero layer height goes to the minimum'() {
    const r = await run({ layer_height: '0' })
    assert.equal(r.get('layer_height'), '0.08')
    assert.equal(r.notices.length, 1)
  },
  async 'smooth timelapse offers the prime tower'() {
    const r = await run({ timelapse_type: '1' }, { initial: { enable_prime_tower: '0' }, answers: [true] })
    assert.equal(r.get('enable_prime_tower'), '1')
  },
  async 'disabling the prime tower with smooth timelapse: no keeps it'() {
    const r = await run({ enable_prime_tower: '0' }, { initial: { timelapse_type: '1' }, answers: [false] })
    assert.equal(r.get('enable_prime_tower'), '1')
  },
  async 'precise Z height with a prime tower: cancel'() {
    assert.equal((await run({ precise_z_height: '1' }, { answers: [false] })).get('precise_z_height'), '0')
  },
  async 'fuzzy skin extrusion mode needs Arachne'() {
    assert.equal((await run({ fuzzy_skin_mode: 'extrusion' }, { answers: [true] })).get('wall_generator'), 'arachne')
    const n = await run({ fuzzy_skin_mode: 'extrusion' }, { answers: [false] })
    assert.equal(n.get('fuzzy_skin_mode'), 'displacement')
    assert.equal(n.get('wall_generator'), 'classic')
  },
  async 'alternate extra wall vs ensure vertical shell thickness All'() {
    assert.equal((await run({ alternate_extra_wall: '1' }, { answers: [true] })).get('ensure_vertical_shell_thickness'), 'ensure_moderate')
    assert.equal((await run({ alternate_extra_wall: '1' }, { answers: [false] })).get('alternate_extra_wall'), '0')
  },
  async 'enabling support turns overhang detection on once'() {
    const state = newRuleState()
    const r = await run({ detect_overhang_wall: '0', enable_support: '1' }, { state })
    assert.equal(r.get('detect_overhang_wall'), '1')
    const again = await run({ detect_overhang_wall: '0' }, { state, initial: r.over })
    assert.equal(again.get('detect_overhang_wall'), '0')
  },
  async 'support style must fit the support type'() {
    const r = await run({ enable_support: '1', support_type: 'tree(auto)' }, { initial: { support_style: 'grid' } })
    assert.equal(r.get('support_style'), 'default')
  },
  async 'simple mode resets support style on type change'() {
    const r = await run({ support_type: 'normal(manual)' }, { initial: { support_style: 'snug' }, simple: true })
    assert.equal(r.get('support_style'), 'default')
  },
  async 'support filament past the last slot falls back to default'() {
    assert.equal((await run({ support_filament: '3' })).get('support_filament'), '0')
  },
  async 'support interface with support material suggests settings'() {
    const r = await run({ support_interface_filament: '2' }, { filaments: [PLA, SUPPORT_PLA], answers: [true] })
    assert.equal(r.get('support_top_z_distance'), '0')
    assert.equal(r.get('support_interface_pattern'), 'rectilinear_interlaced')
    assert.equal(r.get('independent_support_layer_height'), '0')
    assert.equal(r.get('support_filament'), '0')
  },
  async 'non-soluble support material as base asks'() {
    assert.equal((await run({ support_filament: '2' }, { filaments: [PLA, SUPPORT_PLA], answers: [false] })).get('support_filament'), '0')
  },
  async 'scarf start height must be below the layer height'() {
    const r = await run({ seam_slope_type: 'external', seam_slope_start_height: '150%' })
    assert.equal(r.get('seam_slope_start_height'), '0')
    assert.equal(r.notices.length, 1)
    assert.equal((await run({ seam_slope_type: 'external', seam_slope_start_height: '50%' })).get('seam_slope_start_height'), '50%')
  },
  async 'lock depth larger than skin depth'() {
    assert.equal((await run({ infill_lock_depth: '5' })).get('infill_lock_depth'), '1')
  },
  async 'cone wipe tower is not for Bambu printers'() {
    assert.equal((await run({ wipe_tower_wall_type: 'cone' })).get('wipe_tower_wall_type'), 'rectangle')
  },
  async 'out of range compensation values reset'() {
    for (const k of ['xy_hole_compensation', 'xy_contour_compensation', 'elefant_foot_compensation']) {
      const r = await run({ [k]: '3' })
      assert.equal(r.get(k), '0', k)
      assert.equal(r.notices.length, 1)
    }
    assert.equal((await run({ ironing_spacing: '0.01' })).get('ironing_spacing'), '0.1')
    assert.equal((await run({ initial_layer_print_height: '0' })).get('initial_layer_print_height'), '0.2')
  },
  async 'make overhang printable asks'() {
    assert.equal((await run({ make_overhang_printable: '1' }, { answers: [false] })).get('make_overhang_printable'), '0')
  },
  async 'rotating a gyroid template asks, but not when editing an existing one'() {
    const r = await run({ sparse_infill_pattern: 'gyroid', sparse_infill_rotate_template: '0,90' }, { answers: [false] })
    assert.equal(r.get('sparse_infill_rotate_template'), '')
    const rect = await run({ sparse_infill_pattern: 'rectilinear', sparse_infill_rotate_template: '0,90' })
    assert.equal(rect.get('sparse_infill_rotate_template'), '0,90')
    const edit = await run({ sparse_infill_pattern: 'gyroid', sparse_infill_rotate_template: '0,45' }, { initial: { sparse_infill_rotate_template: '0,90' } })
    assert.equal(edit.get('sparse_infill_rotate_template'), '0,45')
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`) }
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
