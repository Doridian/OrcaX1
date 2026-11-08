#!/usr/bin/env node
// Headless check of the engine + profile bundle: slices a 20 mm cube with an
// X1C profile and exports a printable .gcode.3mf. Orca's defaults (parsed from
// PrintConfig.cpp) for filament and printer settings the presets leave out are
// applied too, and checked against the config block of the G-code.
// Usage: node scripts/engine-smoke.mjs [out.gcode.3mf]
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = join(ROOT, 'web/public/engine')
globalThis.require ??= createRequire(import.meta.url)
globalThis.__dirname ??= '.'
globalThis.__filename ??= ''

const bundle = JSON.parse(readFileSync(join(ROOT, 'web/public/profiles/bbl-x1.json'), 'utf8'))
const printer = bundle.printers.find((p) => p.name === 'Bambu Lab X1 Carbon 0.4 nozzle')
const proc = bundle.processes.find((p) => p.name === '0.20mm Standard @BBL X1C')
const fil = bundle.filaments.find((p) => p.name === 'Bambu PLA Basic @BBL X1C')

function cube(s) {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const buf = new DataView(new ArrayBuffer(84 + f.length * 50))
  buf.setUint32(80, f.length, true)
  let o = 84
  for (const t of f) {
    o += 12
    for (const i of t) for (const c of v[i]) { buf.setFloat32(o, c, true); o += 4 }
    o += 2
  }
  return new Uint8Array(buf.buffer)
}

const mainScript = join(mkdtempSync(join(tmpdir(), 'orcax1-engine-')), 'slicer-mt.js')
copyFileSync(join(ENGINE, 'slicer-mt.js'), mainScript)
const jsText = readFileSync(join(ENGINE, 'slicer-mt.js'), 'utf8')
const { default: artifact } = await import('data:text/javascript;charset=utf-8,' +
  encodeURIComponent(`${jsText}\nexport default OneSlicerEngine;`))
const engine = await artifact.createEngine({
  runtime: {
    wasmBinary: readFileSync(join(ENGINE, 'slicer-mt.wasm')),
    // Pthread workers load this file; under web/ the package.json would make Node treat it as ESM.
    mainScriptUrlOrBlob: mainScript,
    printErr: (m) => console.warn('[engine]', m),
  },
})
const session = await engine.createSession()
const enc = (o) => new TextEncoder().encode(JSON.stringify(o))

let t = Date.now()
await session.init(enc({ bed_size_x: 256, bed_size_y: 256 }))
// Settings tab options the presets don't set get Orca's default, as the settings editors show them.
const defaulted = {}
function withDefaults(schema, settings, perFilament) {
  const out = { ...settings }
  for (const [k, d] of Object.entries(schema.options)) {
    if (k in settings || k in proc.settings || d.default === undefined) continue
    out[k] = perFilament && !Array.isArray(d.default) ? [d.default] : d.default
    defaulted[k] = out[k]
  }
  return out
}
await session.applyProfile('orca.profile-json', enc(withDefaults(bundle.printerSchema, printer.settings, false)))
await session.applyProfile('orca.profile-json', enc(proc.settings))
const filFrag = {}
for (const [k, v] of Object.entries(withDefaults(bundle.filamentSchema, fil.settings, true))) filFrag[k] = Array.isArray(v) ? v : [v]
await session.applyProfile('orca.profile-json', enc(filFrag))
await session.applyProfile('orca.native-json', enc({
  curr_bed_type: 'Textured PEI Plate',
  printer_settings_id: printer.name,
  print_settings_id: proc.name,
  filament_settings_id: [fil.name],
  filament_ids: [fil.filament_id],
  filament_colour: ['#FF8800'],
}))
console.log('profiles applied', Date.now() - t, 'ms')

const stl = cube(20)
await session.setObjects(stl, {
  schemaVersion: '0.7.0',
  plates: [{ id: 'plate-0', label: 'Plate 1', index: 0 }],
  meshes: [{ id: 'm0', format: 'stl', dataRange: { offset: 0, length: stl.length } }],
  objects: [{ id: 'o0', meshId: 'm0', extruderId: 1, label: 'cube' }],
  instances: [{ id: 'i0', objectId: 'o0', plateId: 'plate-0', transform: { matrix: [1, 0, 0, 118, 0, 1, 0, 118, 0, 0, 1, 0, 0, 0, 0, 1] } }],
  modifierVolumes: [],
})
t = Date.now()
const result = await session.slice({ schemaVersion: '0.7.0', plateSelection: 'all', includeGcode: true, includeStatistics: true },
  { onProgress: (p) => process.stdout.write(`\r${p.percent ?? '?'}% ${p.stage}          `) })
console.log('\nsliced in', Date.now() - t, 'ms')
console.log(JSON.stringify(result, null, 1).slice(0, 2500))
const plate = result.plateResults[0]
const gcodeAsset = plate.assets.find((a) => a.kind === 'gcode')
const gcode = new TextDecoder().decode(await session.getAsset(gcodeAsset.id))
console.log('gcode bytes', gcode.length)
console.log(gcode.split('\n').filter((l) => l.startsWith('; ')).slice(0, 30).join('\n'))

// The engine must have taken every default (the G-code ends with "; key = value" for the full config).
const block = new Map()
for (const m of gcode.matchAll(/^; ([a-zA-Z0-9_]+) = (.*)$/gm)) block.set(m[1], m[2])
const same = (want, got) => {
  const w = (Array.isArray(want) ? want : [want]).map(String)
  // Strings are written quoted and escaped ("a","b"); numbers and enums bare (a,b).
  let g
  try { g = got.startsWith('"') ? JSON.parse(`[${got}]`) : got.split(/[,;]/).map((x) => x.trim()) } catch { g = [got] }
  const eq = (a, b) => a === b || (a !== '' && b !== '' && Number(a) === Number(b))
  // Per-filament / per-extruder values: one entry each (the slice used one filament and one extruder).
  return eq(w.join(','), got) || (g.length === w.length && w.every((x, i) => eq(x, g[i]))) || (w.length >= 1 && g.length === 1 && eq(w[0], g[0]))
}
const bad = [], missing = []
for (const [k, v] of Object.entries(defaulted)) {
  if (!block.has(k)) { missing.push(k); continue }
  if (!same(v, block.get(k))) bad.push(`${k}: applied ${JSON.stringify(v)}, G-code has ${JSON.stringify(block.get(k))}`)
}
console.log(`defaults applied: ${Object.keys(defaulted).length}, in G-code config: ${Object.keys(defaulted).length - missing.length}`)
if (missing.length) console.log('not in the G-code config block:', missing.join(', '))
if (bad.length) {
  console.error('defaults the engine did not take:\n  ' + bad.join('\n  '))
  process.exit(1)
}
const exp = await session.export('project.3mf', { schemaVersion: '0.7.0', preservation: 'best-effort', includeSliceArtifacts: true })
console.log('export', JSON.stringify(exp))
const bytes = await session.getAsset(exp.asset.id)
const out = process.argv[2] ?? join(ROOT, 'build/smoke.gcode.3mf')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, bytes)
console.log('wrote', out, bytes.length)
process.exit(0)
