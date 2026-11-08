#!/usr/bin/env node
// Headless round trip of a project 3MF through the app's own code and the
// engine:
//   app state (objects on two plates, support volumes incl. a sheared one,
//   filament assignment, process/filament overrides)
//   -> buildProject + engine export('project.3mf') + writeProject3mf (Save project)
//   -> openProject3mf (Open project)
//   -> the same app state.
// It also checks the file as OrcaSlicer reads it (part names, plates,
// different_settings_to_system), reading it without OrcaX1's own metadata
// (as for a file saved by OrcaSlicer), and loading it back into the engine
// (initProfile 'project.3mf', which is OrcaSlicer's own 3MF loader).
// Needs Node 23.6+ (TypeScript type stripping), the engine
// (scripts/fetch-engine.sh) and the profiles (scripts/build-profiles.mjs).
// Usage: node scripts/engine-project.mjs
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
const volumes = await src('state/volumes.ts')
const settings = await src('state/settings.ts')
const projectFile = await src('state/projectFile.ts')
const { buildEngineConfig } = await src('slicer/profiles.ts')
const p3 = await src('model/project3mf.ts')
const { strFromU8, strToU8, unzipSync, zipSync } = await import(join(ROOT, 'web/node_modules/fflate/esm/index.mjs'))
const { Matrix4, Vector3 } = await import(join(ROOT, 'web/node_modules/three/build/three.module.js'))

let failed = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failed++ }
const close = (a, b, tol = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol)

// ---- Engine --------------------------------------------------------------
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

// ---- App state -------------------------------------------------------------
const bundle = JSON.parse(readFileSync(join(ROOT, 'web/public/profiles/bbl-x1.json'), 'utf8'))
settings.bundle.value = bundle
settings.sel.value = {
  printer: 'Bambu Lab X1 Carbon 0.4 nozzle',
  process: '0.20mm Standard @BBL X1C',
  filaments: [
    { preset: 'Bambu PLA Basic @BBL X1C', color: '#F2F2F2' },
    { preset: 'Bambu PLA Basic @BBL X1C', color: '#C12E1F', overrides: { nozzle_temperature: ['225', '225'] } },
  ],
  bedType: 'Textured PEI Plate',
  flow: 'Standard',
  processOverrides: {},
  printerOverrides: {},
}
settings.writeProcessScalar('enable_support', '1')
settings.writeProcessScalar('support_type', 'normal(manual)')
settings.writeProcessScalar('wall_loops', '5')

function box([x0, y0, z0], [x1, y1, z1]) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return new Float32Array(f.flatMap((t) => t.flatMap((i) => v[i])))
}
const bed = settings.bed.value
const [mush, cube] = project.addMeshes([
  { name: 'Mushroom.stl', positions: new Float32Array([...box([-3, -3, 0], [3, 3, 10.2]), ...box([-15, -15, 10], [15, 15, 14])]) },
  { name: 'Cube & "friends".stl', positions: box([-10, -10, 0], [10, 10, 20]) },
], bed)
const q = new Matrix4().makeRotationZ(0.4)
const { Quaternion } = await import(join(ROOT, 'web/node_modules/three/build/three.module.js'))
const qq = new Quaternion().setFromRotationMatrix(q)
project.updateObject(cube.id, { plate: 1, filament: 1, scale: [1, 2.5, 0.75], rot: [qq.x, qq.y, qq.z, qq.w], x: 90, y: 140 })
project.plateCount.value = 2
const obj = (id) => project.objects.value.find((o) => o.id === id)
volumes.addVolume(obj(mush.id), 'support-enforcer', 'box')
volumes.addVolume(obj(cube.id), 'support-blocker', 'cylinder')
volumes.addVolume(obj(cube.id), 'support-enforcer', 'mesh', { name: 'wedge.stl', positions: box([0, 0, 0], [4, 6, 3]) })
// Rotate the cylinder in world space inside the non-uniformly scaled cube: a sheared placement.
{
  const o = obj(cube.id), v = o.volumes[0]
  const c = new Vector3().setFromMatrixPosition(volumes.volumeWorldMatrix(o, v))
  const w = new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new Matrix4().makeRotationX(0.6)).multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z))
  volumes.patchVolume(o.id, v.id, volumes.transformedVolume(o, v, w))
}
const before = { objects: project.objects.value, plateCount: project.plateCount.value, sel: structuredClone(settings.sel.value) }

// ---- Save project ------------------------------------------------------------
const session = await engine.createSession()
const cfg = buildEngineConfig(bundle, settings.sel.value)
await session.init(enc(cfg.init))
for (const f of cfg.fragments) await session.applyProfile(f.format, enc(f.data))
const { blob, manifest } = project.buildProject(before.objects, before.plateCount)
await session.setObjects(blob, manifest)
const exp = await session.export('project.3mf', { schemaVersion: '0.7.0', preservation: 'best-effort', includeSliceArtifacts: false })
const raw = await session.getAsset(exp.asset.id)
const saved = p3.writeProject3mf(raw, projectFile.projectWriteInfo())
console.log(`saved project: ${saved.length} bytes; engine warnings: ${(exp.warnings ?? []).map((w) => w.code).join(', ') || 'none'}`)

// ---- The file as OrcaSlicer sees it -----------------------------------------
const files = unzipSync(saved)
const ms = strFromU8(files['Metadata/model_settings.config'])
const partNames = [...ms.matchAll(/<part id="\d+" subtype="([^"]+)">\s*<metadata key="name" value="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`)
check('parts are named after the objects and volumes, not manifest ids',
  partNames.includes('normal_part:Mushroom.stl') && partNames.includes('normal_part:Cube &amp; &quot;friends&quot;.stl') &&
  partNames.some((n) => n === 'support_enforcer:Support enforcer 1 (box)') && partNames.includes('support_enforcer:wedge.stl') &&
  partNames.includes('support_blocker:Support blocker 1 (cylinder)') && !partNames.some((n) => /:obj-\d/.test(n)), partNames.join(', '))
const plates = [...ms.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => [...m[1].matchAll(/key="object_id" value="(\d+)"/g)].map((x) => x[1]))
check('two <plate> entries with one object each', plates.length === 2 && plates.every((p) => p.length === 1), JSON.stringify(plates))
const model = strFromU8(files['3D/3dmodel.model'])
const items = [...model.matchAll(/<item objectid="(\d+)" transform="([^"]+)"/g)].map((m) => ({ id: m[1], t: m[2].split(' ').map(Number) }))
const item2 = items.find((i) => i.id === plates[1][0])
check('the plate 2 object sits at the plate 2 origin (x + 1.2 × bed width), like OrcaSlicer',
  item2 && Math.abs(item2.t[9] - (90 + bed.x * 1.2)) < 1e-6, item2 && `x = ${item2.t[9]}`)
const ps = JSON.parse(strFromU8(files['Metadata/project_settings.config']))
check('project_settings has the overridden values', ps.wall_loops === '5' && ps.enable_support === '1' && ps.support_type === 'normal(manual)' && ps.nozzle_temperature?.[1] === '225',
  `wall_loops=${ps.wall_loops} enable_support=${ps.enable_support} nozzle_temperature=${ps.nozzle_temperature}`)
check('different_settings_to_system lists the changed keys (process; filament 1; filament 2; printer)',
  JSON.stringify(ps.different_settings_to_system) === JSON.stringify(['enable_support;support_type;wall_loops', '', 'nozzle_temperature', '']),
  JSON.stringify(ps.different_settings_to_system))

// ---- Open project --------------------------------------------------------------
function compare(label, { exactIds = true, shapes = true } = {}) {
  const after = project.objects.value
  check(`${label}: plate count`, project.plateCount.value === before.plateCount, `${project.plateCount.value}`)
  check(`${label}: object count`, after.length === before.objects.length, `${after.length}`)
  for (const [i, a] of before.objects.entries()) {
    const b = after[i]
    if (!b) continue
    const errs = []
    if (exactIds && a.id !== b.id) errs.push(`id ${b.id}`)
    if (a.name !== b.name) errs.push(`name ${b.name}`)
    if (a.plate !== b.plate) errs.push(`plate ${b.plate}`)
    if (a.filament !== b.filament) errs.push(`filament ${b.filament}`)
    if (!close(Array.from(a.positions), Array.from(b.positions), 1e-5)) errs.push('mesh')
    const wa = project.objectMatrix(a).elements, wb = project.objectMatrix(b).elements
    if (!close(wa, wb, 1e-4)) errs.push(`world matrix ${wb.map((x) => x.toFixed(3))}`)
    const va = a.volumes ?? [], vb = b.volumes ?? []
    if (va.length !== vb.length) errs.push(`${vb.length} volumes`)
    for (const [j, x] of va.entries()) {
      const y = vb[j]
      if (!y) continue
      if ((exactIds && x.id !== y.id) || x.name !== y.name || x.role !== y.role) errs.push(`volume ${j} ${y.id}/${y.name}/${y.role}`)
      if (shapes && x.shape !== y.shape) errs.push(`volume ${j} shape ${y.shape}`)
      const wxa = volumes.volumeWorldMatrix(a, x).elements, wxb = volumes.volumeWorldMatrix(b, y).elements
      if (!close(wxa, wxb, 1e-4)) errs.push(`volume ${j} world matrix`)
      if (x.shape === 'mesh' && !close(Array.from(x.positions), Array.from(y.positions), 1e-5)) errs.push(`volume ${j} mesh`)
    }
    check(`${label}: object ${a.name}`, !errs.length, errs.join('; '))
  }
}

project.clearProject()
settings.sel.value = { ...before.sel, processOverrides: {}, filaments: [before.sel.filaments[0]] }
let warnings = projectFile.openProject3mf(saved)
check('open: no warnings', warnings.length === 0, warnings.join(' | '))
compare('open')
check('open: settings selection with all overrides', JSON.stringify(settings.sel.value) === JSON.stringify(before.sel), JSON.stringify(settings.sel.value.processOverrides))
check('open: undo history starts empty', !project.canUndo.value)

// Without OrcaX1's metadata (an OrcaSlicer-saved file): geometry, plates and volumes from
// the 3MF, presets and overrides from project_settings.config.
delete files[p3.META_PATH]
const foreign = zipSync(files)
project.clearProject()
settings.sel.value = { ...before.sel, processOverrides: {}, filaments: [before.sel.filaments[0]] }
warnings = projectFile.openProject3mf(foreign)
check('open without OrcaX1 metadata: no warnings', warnings.length === 0, warnings.join(' | '))
compare('open without OrcaX1 metadata', { exactIds: false, shapes: false })
const s2 = settings.sel.value
check('open without OrcaX1 metadata: presets, colors and overrides from project_settings',
  s2.printer === before.sel.printer && s2.process === before.sel.process && s2.filaments.length === 2 &&
  s2.filaments[1].color === '#C12E1F' && settings.processScalar('wall_loops') === '5' && settings.processScalar('support_type') === 'normal(manual)' &&
  JSON.stringify(s2.filaments[1].overrides?.nozzle_temperature) === JSON.stringify(['225', '225']),
  `${JSON.stringify(s2.processOverrides)} ${JSON.stringify(s2.filaments[1].overrides)}`)

// ---- Load the saved file into the engine (OrcaSlicer's 3MF loader) ------------
const s3 = await engine.createSession()
await s3.initProfile('project.3mf', saved)
const m3 = await s3.getManifest()
check('engine loads the saved project: objects and support volumes',
  m3.objects.length === 2 && m3.modifierVolumes.filter((v) => v.role === 'support-enforcer').length === 2 &&
  m3.modifierVolumes.filter((v) => v.role === 'support-blocker').length === 1,
  `${m3.objects.map((o) => o.label).join(', ')}; ${m3.modifierVolumes.map((v) => v.role).join(', ')}; plates: ${m3.plates.length}`)
// Slice both sessions: the loaded project must give the same G-code config and toolpaths per plate.
async function sliceConfigs(sess) {
  const res = await sess.slice({ schemaVersion: '0.7.0', plateSelection: 'all', includeGcode: true, includeStatistics: false })
  const out = {}
  for (const pr of res.plateResults) {
    const g = new TextDecoder().decode(await sess.getAsset(pr.assets.find((a) => a.kind === 'gcode').id))
    const config = Object.fromEntries([...g.matchAll(/^; ([a-z0-9_]+) = (.*)$/gm)].map((m) => [m[1], m[2]]))
    const moves = g.split('\n').filter((l) => /^G[0-3] /.test(l)).length
    out[pr.plateId] = { config, moves }
  }
  return out
}
const orig = await sliceConfigs(session)
const loaded = await sliceConfigs(s3)
// Keys that differ by construction (the changed-keys list) or only in formatting (thumbnails: "a,b" vs "a, b").
const IGNORE = new Set(['different_settings_to_system', 'thumbnails'])
for (const plate of Object.keys(orig)) {
  const a = orig[plate], b = loaded[plate]
  const diff = b ? Object.keys(a.config).filter((k) => !IGNORE.has(k) && a.config[k] !== b.config[k]) : ['(plate missing)']
  check(`engine slices the loaded project like the original: ${plate} config`, diff.length === 0,
    diff.slice(0, 8).map((k) => `${k}: ${a.config[k]} -> ${b?.config[k]}`).join('; ') || `${Object.keys(a.config).length} keys, wall_loops=${b.config.wall_loops}`)
  check(`engine slices the loaded project like the original: ${plate} toolpaths`, b && Math.abs(a.moves - b.moves) <= a.moves * 0.001, `${a.moves} vs ${b?.moves} moves`)
}

console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
