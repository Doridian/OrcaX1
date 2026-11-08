#!/usr/bin/env node
// Multi-filament settings through the app's own buildEngineConfig and the
// engine: every filament must slice with its own values (nozzle temperature,
// flow ratio, max volumetric speed, ...), not filament 1's. These are
// per-nozzle-variant options, which the engine only maps per filament when
// filament_self_index is set.
// Needs Node 23.6+ (TypeScript type stripping), the engine
// (scripts/fetch-engine.sh) and the profiles (scripts/build-profiles.mjs).
// Usage: node scripts/engine-filaments.mjs
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx) } catch (e) {
      if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(spec + '.ts', ctx)
      throw e
    }
  },
})

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = join(ROOT, 'web/public/engine')
const src = (p) => import(join(ROOT, 'web/src', p))
const project = await src('state/project.ts')
const settings = await src('state/settings.ts')
const { buildEngineConfig } = await src('slicer/profiles.ts')

let failed = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failed++ }

globalThis.require ??= createRequire(import.meta.url)
globalThis.__dirname ??= '.'
globalThis.__filename ??= ''
const mainScript = join(mkdtempSync(join(tmpdir(), 'orcax1-engine-')), 'slicer-mt.js')
copyFileSync(join(ENGINE, 'slicer-mt.js'), mainScript)
const jsText = readFileSync(join(ENGINE, 'slicer-mt.js'), 'utf8')
const { default: artifact } = await import('data:text/javascript;charset=utf-8,' +
  encodeURIComponent(`${jsText}\nexport default OneSlicerEngine;`))
const engine = await artifact.createEngine({
  runtime: { wasmBinary: readFileSync(join(ENGINE, 'slicer-mt.wasm')), mainScriptUrlOrBlob: mainScript, printErr: () => {} },
})
const enc = (o) => new TextEncoder().encode(JSON.stringify(o))

const bundle = JSON.parse(readFileSync(join(ROOT, 'web/public/profiles/bbl-x1.json'), 'utf8'))
settings.bundle.value = bundle
settings.sel.value = {
  printer: 'Bambu Lab X1 Carbon 0.4 nozzle',
  process: '0.20mm Standard @BBL X1C',
  filaments: [
    { preset: 'Bambu PLA Basic @BBL X1C', color: '#F2F2F2' },
    { preset: 'Bambu PETG HF @BBL X1C', color: '#2850E0' },
    { preset: 'Bambu PLA Basic @BBL X1C', color: '#C12E1F', overrides: { nozzle_temperature: ['232', '232'], filament_flow_ratio: ['0.9', '0.9'] } },
  ],
  bedType: 'Textured PEI Plate',
  flow: 'Standard',
  // PLA next to PETG is outside each other's recommended range: Orca refuses that unless allowed (checked below).
  allowMixedTemps: true,
  processOverrides: {},
  printerOverrides: {},
}

function box([x0, y0, z0], [x1, y1, z1]) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return new Float32Array(f.flatMap((t) => t.flatMap((i) => v[i])))
}
const objs = project.addMeshes([0, 1, 2].map((i) => ({ name: `cube${i}.stl`, positions: box([-8, -8, 0], [8, 8, 6]) })), settings.bed.value)
objs.forEach((o, i) => project.updateObject(o.id, { filament: i, x: 70 + i * 50, y: 128 }))

const cfg = buildEngineConfig(bundle, settings.sel.value)
const filFrag = Object.assign({}, ...cfg.fragments.map((f) => f.data))
const KEYS = ['nozzle_temperature', 'nozzle_temperature_initial_layer', 'filament_flow_ratio', 'filament_max_volumetric_speed']
for (const k of KEYS) {
  const v = filFrag[k]
  check(`fragment has one ${k} per filament`, Array.isArray(v) && v.length === 3, JSON.stringify(v))
}
check('the filaments differ (or this test proves nothing)',
  new Set(filFrag.nozzle_temperature).size === 3 && new Set(filFrag.filament_flow_ratio).size === 3,
  `${filFrag.nozzle_temperature} / ${filFrag.filament_flow_ratio}`)

const { blob, manifest } = project.buildProject(project.objects.value, 1)
async function slice(c) {
  const session = await engine.createSession()
  await session.init(enc(c.init))
  for (const f of c.fragments) await session.applyProfile(f.format, enc(f.data))
  await session.setObjects(blob, manifest)
  return { session, res: await session.slice({ schemaVersion: '0.7.0', plateSelection: 'all', includeGcode: true, includeStatistics: false }) }
}
// Without the mixed-temperature allowance the engine sees PETG's temperature next to PLA's and refuses
// (it can't when it thinks every filament has filament 1's temperature).
{
  const err = await slice(buildEngineConfig(bundle, { ...settings.sel.value, allowMixedTemps: false })).then(() => null, (e) => e)
  check('mixed PLA + PETG temperatures are refused unless allowed', /nozzle temperatures are incompatible/.test(err?.message ?? ''), err?.message?.slice(0, 60) ?? 'sliced')
}
const { session, res } = await slice(cfg)
const pr = res.plateResults[0]
const gcode = new TextDecoder().decode(await session.getAsset(pr.assets.find((a) => a.kind === 'gcode').id))
const block = new Map()
for (const m of gcode.matchAll(/^; ([a-zA-Z0-9_]+) = (.*)$/gm)) block.set(m[1], m[2])

for (const k of KEYS) {
  const got = (block.get(k) ?? '').split(',').map(Number)
  const want = filFrag[k].map(Number)
  check(`G-code ${k} is each filament's own`, got.length === want.length && got.every((x, i) => x === want[i]), `sent ${want}, G-code ${got}`)
}
// The temperature the printer is actually told for each filament.
for (const t of filFrag.nozzle_temperature) {
  check(`the G-code heats to ${t} for its filament`, new RegExp(`^M10[49] S${t}\\b`, 'm').test(gcode))
}

console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
