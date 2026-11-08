// Save / open the whole project as an Orca project 3MF: objects, transforms,
// plates, support volumes, filament assignment and the preset selection with
// its overrides.
//
// Saving uses the engine's own 3MF writer (OrcaSlicer's bbs_3mf exporter) and
// then fixes what the portable export leaves out (plates, part names, the
// changed-settings list); see model/project3mf.ts. Opening parses the 3MF
// here: the engine can load a project 3MF (initProfile 'project.3mf') but
// gives no way to read the loaded meshes back and flattens plates.
import { Matrix4, Quaternion, Vector3 } from 'three'
import { readProject3mf, writeProject3mf, type ProjectFile, type WriteInfo } from '../model/project3mf'
import { centerMesh, primitive, type ModelVolume, type VolumeShape } from '../model/volumes'
import { BED_TYPES, compatibleFilaments, compatibleProcesses, type Overrides, type ProfileBundle, type Selection } from '../slicer/profiles'
import { loadProject, newObjectId, objects, partNames, plateCount, volumeManifestId, type ModelObject } from './project'
import { bed, bundle, sel } from './settings'
import { configuredEngine } from './slice'

/** Builds the project 3MF of the current project. */
export async function saveProject3mf(): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const engine = await configuredEngine()
  const res = await engine.export('project.3mf', { schemaVersion: '0.7.0', preservation: 'best-effort', includeSliceArtifacts: false })
  // Plates are written back below; anything else the engine reports is passed on.
  const warnings = (res.warnings ?? []).filter((w: any) => w.code !== 'logical-plates-flattened' && w.code !== 'portable-export')
    .map((w: any) => w.message ?? String(w.code))
  const raw = await engine.getAsset(res.asset.id)
  const bytes = writeProject3mf(raw, projectWriteInfo())
  return { bytes, warnings }
}

/** What writeProject3mf needs to know about the current project. */
export function projectWriteInfo(): WriteInfo {
  const list = objects.value
  const s = sel.value
  return {
    names: partNames(list),
    plates: Object.fromEntries(list.map((o) => [o.id, o.plate])),
    plateCount: plateCount.value,
    bed: bed.value,
    differentSettings: [
      Object.keys(s.processOverrides).join(';'),
      ...s.filaments.map((f) => Object.keys(f.overrides ?? {}).join(';')),
      Object.keys(s.printerOverrides).join(';'),
    ],
    objects: Object.fromEntries(list.map((o) => [o.id, {
      id: o.id,
      volumes: Object.fromEntries((o.volumes ?? []).map((v) => [volumeManifestId(o, v), { id: v.id, shape: v.shape }])),
    }])),
    selection: s,
  }
}

/** Reads a project 3MF and replaces the current project and settings with it. Returns warnings for the user. */
export function openProject3mf(bytes: Uint8Array): string[] {
  const b = bundle.value
  if (!b) throw new Error('profiles not loaded')
  const file = readProject3mf(bytes, bed.value)
  const warnings: string[] = []
  const nextSel = file.meta ? metaSelection(b, file.meta.selection, warnings) : null
  const s = nextSel ?? (file.config ? configSelection(b, file.config, warnings) : sel.value)
  const list = projectObjects(file, s.filaments.length, warnings)
  if (!list.length) throw new Error('The project has no objects.')
  sel.value = s
  loadProject(list, file.plateCount)
  return warnings
}

const SUPPORTED_ROLES: Record<string, ModelVolume['role']> = { support_enforcer: 'support-enforcer', support_blocker: 'support-blocker' }
const ROLE_NAMES: Record<string, string> = { modifier_part: 'settings modifier', negative_part: 'negative volume' }

/** Converts parsed 3MF objects into ModelObjects (mesh recentered, instance as x/y/rotation/scale). */
function projectObjects(file: ProjectFile, filaments: number, warnings: string[]): ModelObject[] {
  const out: ModelObject[] = []
  const seen = new Set<string>()
  const skipped = new Map<string, number>()
  let multiPart = 0
  for (const po of file.objects) {
    const m = file.meta?.objects[po.fileId]
    const normal = po.parts.filter((p) => p.role === 'normal_part')
    if (!normal.length) continue
    if (normal.length > 1) multiPart++
    // Normal parts are merged into one mesh in the object's frame (OrcaX1 objects have a single mesh).
    const total = normal.reduce((n, p) => n + p.positions.length, 0)
    const merged = new Float32Array(total)
    let off = 0
    for (const p of normal) { merged.set(applyMatrix(p.positions, p.matrix), off); off += p.positions.length }
    // Recenter: XY center and bottom at the origin; the instance compensates.
    const { offset: d, positions } = recenterWithOffset(merged)
    const inst = new Matrix4().fromArray(po.matrix)
    const pos = new Vector3(), q = new Quaternion(), sc = new Vector3()
    inst.clone().multiply(new Matrix4().makeTranslation(d[0], d[1], d[2])).decompose(pos, q, sc)
    const toLocal = new Matrix4().makeTranslation(-d[0], -d[1], -d[2])

    const volumes: ModelVolume[] = []
    for (const p of po.parts) {
      if (p.role === 'normal_part') continue
      const role = SUPPORTED_ROLES[p.role]
      if (!role) { skipped.set(p.role, (skipped.get(p.role) ?? 0) + 1); continue }
      const vm = m?.volumes[p.partId]
      // Our primitives are shared and unit-sized (centered); other meshes are centered on their box.
      const c0 = meshCenter(p.positions)
      const shape = (vm && vm.shape !== 'mesh' && c0.every((x) => Math.abs(x) < 1e-4) ? vm.shape : 'mesh') as VolumeShape
      const centered = shape !== 'mesh' ? null : centerMesh(p.positions)
      const c = centered ? c0 : [0, 0, 0]
      const matrix = toLocal.clone().multiply(new Matrix4().fromArray(p.matrix)).multiply(new Matrix4().makeTranslation(c[0], c[1], c[2]))
      let id = vm?.id ?? `vol-${volumes.length + 1}`
      while (volumes.some((v) => v.id === id)) id += '+'
      volumes.push({
        id, name: p.name || `${role} ${volumes.length + 1}`, role, shape,
        positions: centered ?? primitive(shape as Exclude<VolumeShape, 'mesh'>),
        matrix: matrix.toArray(),
      })
    }
    const id = m?.id && /^obj-\d+$/.test(m.id) && !seen.has(m.id) ? m.id : newObjectId()
    seen.add(id)
    out.push({
      id,
      name: po.name,
      positions,
      x: pos.x, y: pos.y,
      rot: [q.x, q.y, q.z, q.w],
      scale: [sc.x, sc.y, sc.z],
      filament: Math.min(Math.max(0, po.extruder - 1), filaments - 1),
      plate: po.plate,
      volumes: volumes.length ? volumes : undefined,
      rev: 0,
    })
  }
  // Ids from the file can collide with fresh ids handed out above; make them unique.
  const ids = new Set<string>()
  for (const o of out) { if (ids.has(o.id)) o.id = newObjectId(); ids.add(o.id) }
  for (const [role, n] of skipped) {
    warnings.push(`${n} ${ROLE_NAMES[role] ?? role} part(s) were left out: the slicer engine only supports support enforcers and blockers (see issue #19).`)
  }
  if (multiPart) warnings.push(`${multiPart} multi-part object(s) were merged into one mesh each.`)
  return out
}

function applyMatrix(p: Float32Array, elements: number[]): Float32Array {
  const e = elements
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2]
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12]
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]
  }
  return out
}

function meshBounds(p: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i++) {
    const a = i % 3
    if (p[i] < min[a]) min[a] = p[i]
    if (p[i] > max[a]) max[a] = p[i]
  }
  return { min, max }
}
function meshCenter(p: Float32Array) {
  const b = meshBounds(p)
  return [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2)
}
function recenterWithOffset(p: Float32Array) {
  const b = meshBounds(p)
  const d = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]]
  if (d.every((x) => x === 0)) return { offset: d, positions: p }
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i++) out[i] = p[i] - d[i % 3]
  return { offset: d, positions: out }
}

/** The selection OrcaX1 saved, if its presets exist here. */
function metaSelection(b: ProfileBundle, saved: any, warnings: string[]): Selection | null {
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.filaments)) return null
  const missing = [
    !b.printers.some((p) => p.name === saved.printer) && `printer "${saved.printer}"`,
    !b.processes.some((p) => p.name === saved.process) && `process "${saved.process}"`,
    ...saved.filaments.filter((f: any) => !b.filaments.some((x) => x.name === f?.preset)).map((f: any) => `filament "${f?.preset}"`),
  ].filter(Boolean)
  if (missing.length) {
    warnings.push(`Presets not available here: ${missing.join(', ')}. Using the settings stored in the file instead.`)
    return null
  }
  return { ...sel.value, ...saved, processOverrides: saved.processOverrides ?? {}, printerOverrides: saved.printerOverrides ?? {} }
}

/**
 * A selection from an OrcaSlicer / Bambu Studio project_settings.config: the
 * presets it names, plus overrides for the keys it lists as changed
 * (`different_settings_to_system`: process, filament 1..n, printer).
 */
function configSelection(b: ProfileBundle, cfg: Record<string, any>, warnings: string[]): Selection {
  const cur = sel.value
  const printer = b.printers.find((p) => p.name === cfg.printer_settings_id)
  if (!printer) warnings.push(`Printer preset "${cfg.printer_settings_id ?? '?'}" is not available; kept "${cur.printer}".`)
  const printerName = printer?.name ?? cur.printer
  const procs = compatibleProcesses(b, printerName)
  const proc = procs.find((p) => p.name === cfg.print_settings_id)
  if (!proc && cfg.print_settings_id) warnings.push(`Process preset "${cfg.print_settings_id}" is not available; kept "${cur.process}".`)
  const fils = compatibleFilaments(b, printerName)
  const names: string[] = Array.isArray(cfg.filament_settings_id) ? cfg.filament_settings_id : []
  const colors: string[] = Array.isArray(cfg.filament_colour) ? cfg.filament_colour : []
  const diff: string[] = Array.isArray(cfg.different_settings_to_system) ? cfg.different_settings_to_system : []
  const keys = (i: number) => (diff[i] ?? '').split(';').map((k) => k.trim().replace(/^"|"$/g, '')).filter(Boolean)

  const filaments = names.map((name, i) => {
    const f = fils.find((x) => x.name === name)
    if (!f) warnings.push(`Filament preset "${name}" is not available; used "${fils[0]?.name}" for filament ${i + 1}.`)
    const preset = f ?? fils[0]
    const overrides: Overrides = {}
    if (f) {
      for (const k of keys(i + 1)) {
        if (!(k in cfg)) continue
        const v = Array.isArray(cfg[k]) ? (cfg[k][i] ?? cfg[k][0]) : cfg[k]
        const o = asOverride(preset.settings[k], v)
        if (o !== undefined) overrides[k] = o
      }
    }
    const color = /^#[0-9a-f]{6}/i.test(colors[i] ?? '') ? colors[i].slice(0, 7).toUpperCase() : '#F2F2F2'
    return { preset: preset?.name ?? '', color, ...(Object.keys(overrides).length ? { overrides } : {}) }
  }).filter((f) => f.preset)

  const collect = (settings: Record<string, any> | undefined, list: string[]) => {
    const o: Overrides = {}
    if (!settings) return o
    for (const k of list) {
      if (!(k in cfg)) continue
      const v = asOverride(settings[k], cfg[k])
      if (v !== undefined) o[k] = v
    }
    return o
  }
  if (!diff.length) warnings.push('The file does not list which settings differ from the presets; only the preset names were taken over.')
  return {
    ...cur,
    printer: printerName,
    process: proc?.name ?? (procs.some((p) => p.name === cur.process) ? cur.process : procs[0]?.name ?? cur.process),
    filaments: filaments.length ? filaments : cur.filaments,
    bedType: (BED_TYPES as readonly string[]).includes(cfg.curr_bed_type) ? cfg.curr_bed_type : cur.bedType,
    processOverrides: proc ? collect(proc.settings, keys(0)) : {},
    printerOverrides: printer ? collect(printer.settings, keys(diff.length - 1)) : {},
  }
}

/**
 * A config value as an override shaped like the preset value (presets store
 * some options per nozzle-flow variant). Undefined when equal to the preset.
 */
function asOverride(preset: string | string[] | undefined, value: unknown): string | string[] | undefined {
  let v: string | string[]
  if (Array.isArray(preset)) {
    if (Array.isArray(value) && value.length === preset.length) v = value.map(String)
    else v = preset.map(() => String(Array.isArray(value) ? value[0] ?? '' : value ?? ''))
  } else {
    v = Array.isArray(value) ? value.map(String).join(',') : String(value ?? '')
  }
  return JSON.stringify(v) === JSON.stringify(preset) ? undefined : v
}
