#!/usr/bin/env node
// Builds web/public/profiles/bbl-x1.json from OrcaSlicer's bundled Bambu Lab
// system profiles. Only X1-series printers, and the processes and filaments
// compatible with them, are kept. Inheritance is resolved at build time, so
// the browser gets ready-to-apply Orca preset JSON.
//
// Usage: node scripts/build-profiles.mjs [--orca-src build/orca-src]
// If --orca-src is missing, the pinned OrcaSlicer tag is sparse-cloned into
// build/orca-src.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ORCA_TAG = process.env.ORCA_TAG ?? 'v2.4.2'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRINTER_MODELS = ['Bambu Lab X1 Carbon', 'Bambu Lab X1', 'Bambu Lab X1E']

const args = process.argv.slice(2)
const srcArg = args.indexOf('--orca-src')
const orcaSrc = srcArg >= 0 ? resolve(args[srcArg + 1]) : join(ROOT, 'build', 'orca-src')

if (!existsSync(join(orcaSrc, 'resources/profiles/BBL.json'))) {
  mkdirSync(dirname(orcaSrc), { recursive: true })
  const git = (...a) => execFileSync('git', a, { stdio: 'inherit' })
  git('clone', '--depth', '1', '--branch', ORCA_TAG, '--filter=blob:none', '--sparse',
    'https://github.com/SoftFever/OrcaSlicer', orcaSrc)
  git('-C', orcaSrc, 'sparse-checkout', 'set', '--no-cone', 'resources/profiles/BBL/', '/resources/profiles/BBL.json',
    'resources/profiles/OrcaFilamentLibrary/', '/resources/profiles/OrcaFilamentLibrary.json',
    '/src/libslic3r/PrintConfig.cpp')
}
if (!existsSync(join(orcaSrc, 'src/libslic3r/PrintConfig.cpp'))) {
  execFileSync('git', ['-C', orcaSrc, 'sparse-checkout', 'add', '/src/libslic3r/PrintConfig.cpp'], { stdio: 'inherit' })
}

// Option types from Orca's config definitions: the engine rejects an array
// value for a scalar option, but Bambu presets store some scalars per variant.
const optionTypes = {}
const printConfig = readFileSync(join(orcaSrc, 'src/libslic3r/PrintConfig.cpp'), 'utf8')
for (const m of printConfig.matchAll(/this->add(?:_nullable)?\("([a-z0-9_]+)",\s*(co[A-Za-z0-9]+)\)/g)) {
  optionTypes[m[1]] ??= m[2]
}
const VECTOR_TYPES = new Set(['coFloats', 'coInts', 'coStrings', 'coPercents', 'coFloatsOrPercents', 'coPoints', 'coBools', 'coEnums', 'coPointsGroups', 'coIntsGroups'])
const scalarKeys = Object.keys(optionTypes).filter((k) => !VECTOR_TYPES.has(optionTypes[k])).sort()

const BBL = join(orcaSrc, 'resources/profiles/BBL')
const vendor = JSON.parse(readFileSync(BBL + '.json', 'utf8'))

/** name -> raw profile, per type directory */
function loadDir(dir, base = BBL, out = new Map()) {
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (entry.endsWith('.json')) {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        if (j.name) out.set(j.name, j)
      }
    }
  }
  walk(join(base, dir))
  return out
}

const machines = loadDir('machine')
const processes = loadDir('process')
// Bambu's filament presets inherit from Orca's shared filament library.
const filaments = loadDir('filament', join(orcaSrc, 'resources/profiles/OrcaFilamentLibrary'))
loadDir('filament', BBL, filaments)

// Keys that describe the preset file itself rather than slicer settings.
const META = new Set(['type', 'name', 'inherits', 'from', 'instantiation', 'setting_id', 'filament_id',
  'description', 'url', 'version', 'is_custom_defined', 'renamed_from'])

function resolveProfile(map, name, seen = new Set()) {
  const p = map.get(name)
  if (!p) throw new Error(`missing parent profile ${name}`)
  if (seen.has(name)) throw new Error(`inheritance cycle at ${name}`)
  seen.add(name)
  const base = p.inherits ? resolveProfile(map, p.inherits, seen) : {}
  const out = { ...base }
  for (const [k, v] of Object.entries(p)) {
    if (k === 'inherits') continue
    out[k] = v
  }
  return out
}

function settingsOnly(resolved) {
  const s = {}
  for (const [k, v] of Object.entries(resolved)) if (!META.has(k)) s[k] = v
  return s
}

const printerOut = []
for (const [name, raw] of machines) {
  if (raw.instantiation !== 'true') continue
  const r = resolveProfile(machines, name)
  if (!PRINTER_MODELS.includes(r.printer_model)) continue
  printerOut.push({
    name,
    model: r.printer_model,
    nozzle: r.printer_variant ?? r.nozzle_diameter?.[0],
    setting_id: raw.setting_id ?? r.setting_id ?? null,
    settings: settingsOnly(r),
  })
}
printerOut.sort((a, b) => a.name.localeCompare(b.name))
const printerNames = new Set(printerOut.map((p) => p.name))

function compatible(resolved) {
  const list = resolved.compatible_printers
  if (!Array.isArray(list) || list.length === 0) return null
  return list.filter((n) => printerNames.has(n))
}

function collect(map, kind) {
  const out = []
  for (const [name, raw] of map) {
    if (raw.instantiation !== 'true') continue
    const r = resolveProfile(map, name)
    const compat = compatible(r)
    if (!compat || compat.length === 0) continue
    const s = settingsOnly(r)
    delete s.compatible_printers
    delete s.compatible_printers_condition
    const entry = { name, compatible: compat, setting_id: raw.setting_id ?? r.setting_id ?? null, settings: s }
    if (kind === 'filament') {
      entry.filament_id = r.filament_id ?? null
      entry.vendor = (Array.isArray(r.filament_vendor) ? r.filament_vendor[0] : r.filament_vendor) ?? null
      entry.type = (Array.isArray(r.filament_type) ? r.filament_type[0] : r.filament_type) ?? null
    }
    out.push(entry)
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

const processOut = collect(processes, 'process')
const filamentOut = collect(filaments, 'filament')

const models = PRINTER_MODELS.map((m) => {
  const raw = machines.get(m) ?? {}
  return {
    name: m,
    default_bed_type: raw.default_bed_type ?? null,
    default_materials: (raw.default_materials ?? '').split(';').filter(Boolean),
    model_id: raw.model_id ?? null,
  }
})

const bundle = {
  scalarKeys,
  source: `OrcaSlicer ${ORCA_TAG} resources/profiles/BBL (vendor version ${vendor.version})`,
  models,
  printers: printerOut,
  processes: processOut,
  filaments: filamentOut,
}

const outDir = join(ROOT, 'web/public/profiles')
mkdirSync(outDir, { recursive: true })
const json = JSON.stringify(bundle)
writeFileSync(join(outDir, 'bbl-x1.json'), json)
console.log(`option types: ${Object.keys(optionTypes).length} (${scalarKeys.length} scalar)`)
console.log(`profiles: ${printerOut.length} printers, ${processOut.length} processes, ${filamentOut.length} filaments, ${(json.length / 1e6).toFixed(1)} MB`)
