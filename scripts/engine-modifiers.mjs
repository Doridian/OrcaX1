#!/usr/bin/env node
// Headless check of what the engine does with per-object settings and
// modifier volumes (one-slicer-api 0.7 `modifierVolumes`):
//  - support enforcers / blockers change the support toolpaths,
//  - they survive the printable 3MF export,
//  - per-object and per-volume config overrides, plain (settings) modifiers
//    and negative volumes are rejected by the manifest parser.
// The last group documents engine gaps; if one of them starts passing, the
// engine has gained the feature and the web UI can expose it.
// Usage: node scripts/engine-modifiers.mjs
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from '../web/node_modules/fflate/esm/index.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = join(ROOT, 'web/public/engine')
globalThis.require ??= createRequire(import.meta.url)
globalThis.__dirname ??= '.'
globalThis.__filename ??= ''

const bundle = JSON.parse(readFileSync(join(ROOT, 'web/public/profiles/bbl-x1.json'), 'utf8'))
const printer = bundle.printers.find((p) => p.name === 'Bambu Lab X1 Carbon 0.4 nozzle')
const proc = bundle.processes.find((p) => p.name === '0.20mm Standard @BBL X1C')
const fil = bundle.filaments.find((p) => p.name === 'Bambu PLA Basic @BBL X1C')

/** Triangle soup of an axis-aligned box. */
function box([x0, y0, z0], [x1, y1, z1]) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return f.flatMap((t) => t.flatMap((i) => v[i]))
}
function stl(tris) {
  const n = tris.length / 9
  const dv = new DataView(new ArrayBuffer(84 + n * 50))
  dv.setUint32(80, n, true)
  let o = 84
  for (let t = 0; t < n; t++) {
    o += 12
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, tris[t * 9 + k], true); o += 4 }
    o += 2
  }
  return new Uint8Array(dv.buffer)
}

const mainScript = join(mkdtempSync(join(tmpdir(), 'orcax1-engine-')), 'slicer-mt.js')
copyFileSync(join(ENGINE, 'slicer-mt.js'), mainScript)
const jsText = readFileSync(join(ENGINE, 'slicer-mt.js'), 'utf8')
const { default: artifact } = await import('data:text/javascript;charset=utf-8,' +
  encodeURIComponent(`${jsText}\nexport default OneSlicerEngine;`))
const engine = await artifact.createEngine({
  runtime: { wasmBinary: readFileSync(join(ENGINE, 'slicer-mt.wasm')), mainScriptUrlOrBlob: mainScript, printErr: () => {} },
})
const caps = engine.capabilities
const session = await engine.createSession()
const enc = (o) => new TextEncoder().encode(JSON.stringify(o))

async function configure(extra = {}) {
  await session.init(enc({ bed_size_x: 256, bed_size_y: 256 }))
  await session.applyProfile('orca.profile-json', enc(printer.settings))
  await session.applyProfile('orca.profile-json', enc({ ...proc.settings, ...extra }))
  const filFrag = {}
  for (const [k, v] of Object.entries(fil.settings)) filFrag[k] = Array.isArray(v) ? v : [v]
  await session.applyProfile('orca.profile-json', enc(filFrag))
  await session.applyProfile('orca.native-json', enc({
    curr_bed_type: 'Textured PEI Plate', printer_settings_id: printer.name, print_settings_id: proc.name,
    filament_settings_id: [fil.name], filament_ids: [fil.filament_id], filament_colour: ['#FF8800'],
  }))
}

// A "mushroom": 6x6x10 stem under a 30x30x4 cap, so the cap overhangs on all sides.
const mushroom = stl([...box([-3, -3, 0], [3, 3, 10.2]), ...box([-15, -15, 10], [15, 15, 14])])
const cube = stl(box([-10, -10, 0], [10, 10, 20]))
// Modifier meshes are in object space; the manifest transform places them.
const unitBox = stl(box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]))
const at = (x, y, z, sx = 1, sy = 1, sz = 1) => ({ matrix: [sx, 0, 0, x, 0, sy, 0, y, 0, 0, sz, z, 0, 0, 0, 1] })

function project(objects, modifierVolumes = []) {
  const meshes = [mushroom, cube, unitBox]
  const blob = new Uint8Array(meshes.reduce((n, m) => n + m.length, 0))
  let off = 0
  const meshList = meshes.map((m, i) => { blob.set(m, off); const r = { id: `m${i}`, format: 'stl', dataRange: { offset: off, length: m.length } }; off += m.length; return r })
  const manifest = {
    schemaVersion: '0.7.0',
    plates: [{ id: 'plate-0', label: 'Plate 1', index: 0 }],
    meshes: meshList,
    objects: objects.map((o) => ({ id: o.id, meshId: o.meshId, extruderId: 1, label: o.id, ...(o.extra ?? {}) })),
    instances: objects.map((o) => ({ id: `${o.id}-i`, objectId: o.id, plateId: 'plate-0', transform: at(o.x, o.y, 0) })),
    modifierVolumes,
  }
  return { blob, manifest }
}

async function sliceStats(p) {
  await session.setObjects(p.blob, p.manifest)
  const r = await session.slice({ schemaVersion: '0.7.0', plateSelection: 'all', includeGcode: true, includeStatistics: true })
  const asset = r.plateResults[0].assets.find((a) => a.kind === 'gcode')
  const gcode = new TextDecoder().decode(await session.getAsset(asset.id))
  // Count extrusion moves per feature type.
  const types = {}
  let type = ''
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; FEATURE: ')) type = line.slice(11)
    else if (/^G1 .*E[\d.]/.test(line) && !/E-/.test(line)) types[type] = (types[type] ?? 0) + 1
  }
  return { types, gcode }
}
const support = (t) => (t['Support'] ?? 0) + (t['Support interface'] ?? 0) + (t['Support transition'] ?? 0)

let failed = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failed++ }
const gap = (name, ok, detail = '') => console.log(`${ok ? 'SUPPORTED' : 'ENGINE GAP'} ${name}${detail ? ` (${detail})` : ''}`)

console.log('capabilities: project.modifierVolumes =', caps?.features?.['project.modifierVolumes'] ?? "(unknown)")

// 1. Support enforcer with manual supports (enforcers only): support appears under the cap.
await configure({ enable_support: '1', support_type: 'normal(manual)' })
const mush = [{ id: 'o0', meshId: 'm0', x: 128, y: 128 }]
const base = await sliceStats(project(mush))
const enforced = await sliceStats(project(mush, [
  { id: 'enf', meshId: 'm2', role: 'support-enforcer', objectId: 'o0', plateId: 'plate-0', transform: at(0, 0, 7, 34, 34, 14) },
]))
check('support enforcer adds support with support_type=normal(manual)', support(base.types) === 0 && support(enforced.types) > 0,
  `support moves ${support(base.types)} -> ${support(enforced.types)}`)

// 2. Support blocker with support enabled: blocking half the cap removes about half the support.
await configure({ enable_support: '1', support_type: 'normal(auto)' })
const full = await sliceStats(project(mush))
const blocked = await sliceStats(project(mush, [
  { id: 'blk', meshId: 'm2', role: 'support-blocker', objectId: 'o0', plateId: 'plate-0', transform: at(-9, 0, 7, 18, 34, 14) },
]))
check("support blocker removes support", support(full.types) > 0 && support(blocked.types) < support(full.types),
  `support moves ${support(full.types)} -> ${support(blocked.types)}`)

// 3. The printable 3MF keeps the blocker (Orca writes it as a volume of the object).
const exp = await session.export('project.3mf', { schemaVersion: '0.7.0', preservation: 'best-effort', includeSliceArtifacts: true })
const files = unzipSync(await session.getAsset(exp.asset.id))
const settings = strFromU8(files['Metadata/model_settings.config'] ?? new Uint8Array())
check('3MF export keeps the support blocker volume', /support_blocker/.test(settings),
  (settings.match(/<metadata key="volume_type" value="[^"]*"/g) ?? []).join(' '))

// 4. Engine gaps: per-object config, per-volume config, settings modifiers, negative volumes.
async function accepted(p) {
  try { await session.setObjects(p.blob, p.manifest); return [true, ''] } catch (e) { return [false, e?.message ?? String(e)] }
}
await configure()
let [ok, msg] = await accepted(project([{ id: 'o0', meshId: 'm1', x: 100, y: 128, extra: { config: { wall_loops: '5' } } }]))
gap('per-object config on manifest objects', ok, msg)
;[ok, msg] = await accepted(project([{ id: 'o0', meshId: 'm1', x: 100, y: 128 }], [
  { id: 'mod', meshId: 'm2', role: 'modifier', objectId: 'o0', plateId: 'plate-0', transform: at(0, 0, 10, 10, 10, 10) },
]))
gap('settings modifier volumes (role "modifier")', ok, msg)
;[ok, msg] = await accepted(project([{ id: 'o0', meshId: 'm1', x: 100, y: 128 }], [
  { id: 'neg', meshId: 'm2', role: 'negative-volume', objectId: 'o0', plateId: 'plate-0', transform: at(0, 0, 10, 10, 10, 10) },
]))
gap('negative volumes', ok, msg)
;[ok, msg] = await accepted(project([{ id: 'o0', meshId: 'm1', x: 100, y: 128 }], [
  { id: 'enf', meshId: 'm2', role: 'support-enforcer', objectId: 'o0', plateId: 'plate-0', transform: at(0, 0, 10, 10, 10, 10), config: { support_type: 'tree(auto)' } },
]))
gap('per-volume config', ok, msg)
;[ok, msg] = await accepted(project([{ id: 'o0', meshId: 'm1', x: 100, y: 128, extra: { meshIds: ['m1', 'm2'] } }]))
gap('multi-part objects', ok, msg)

console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
