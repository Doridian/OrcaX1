// Orca / Bambu project 3MF: post-processing of the engine's export and a
// reader for project files (ours and OrcaSlicer's / Bambu Studio's).
//
// Kept free of three.js and DOM APIs (regex XML parsing, fflate only) so the
// headless check (scripts/engine-project.mjs) runs it in Node.
//
// Layout of what Orca writes (bbs_3mf.cpp):
//  - 3D/3dmodel.model: one mesh object per part, one object per model object
//    with a <component> per part (transform = the part's matrix in the
//    object), and a <build> item per instance (transform = the instance's
//    world matrix, plus its plate's origin, see plateOrigin()).
//    Bambu Studio puts the meshes in 3D/Objects/*.model (p:path components).
//  - Metadata/model_settings.config: per object its name and extruder, per
//    part its name and subtype (normal_part, support_enforcer, ...), and the
//    <plate> list with the object ids on each plate.
//  - Metadata/project_settings.config: the full flattened config (JSON) with
//    the preset names and `different_settings_to_system` (the keys changed
//    from each preset: process, filament 1..n, printer).
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** OrcaX1's own extra file in a saved project (OrcaSlicer ignores unknown files). */
export const META_PATH = 'Metadata/orcax1_project.json'

export interface ProjectMeta {
  app: 'OrcaX1'
  version: 1
  /** The full preset selection with all overrides (state/settings `sel`). */
  selection: unknown
  plateCount: number
  /** By model_settings object id. */
  objects: Record<string, { id: string; volumes: Record<string, { id: string; shape: string }> }>
}

/** 3MF row-vector transform (12 numbers) as a three.js column-major 4x4 `elements` array. */
export function transformToElements(t: number[]): number[] {
  return [t[0], t[1], t[2], 0, t[3], t[4], t[5], 0, t[6], t[7], t[8], 0, t[9], t[10], t[11], 1]
}

/** Orca's plate grid: columns for `count` plates (PartPlateList::compute_colum_count). */
export function plateColumns(count: number): number {
  const v = Math.sqrt(count), r = Math.round(v)
  return v > r ? r + 1 : r
}

/** World origin of plate `index` (PartPlateList::compute_origin; plates are 1/5 of their size apart). */
export function plateOrigin(index: number, count: number, bed: { x: number; y: number }): [number, number] {
  const cols = plateColumns(count)
  const row = Math.floor(index / cols), col = index % cols
  return [col * bed.x * 1.2, -row * bed.y * 1.2]
}

const xmlEscape = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
const xmlUnescape = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()])
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? xmlUnescape(m[1]) : null
}
const metaValue = (block: string, key: string) => {
  const m = new RegExp(`<metadata key="${key}" value="([^"]*)"`).exec(block)
  return m ? xmlUnescape(m[1]) : null
}

/**
 * The engine names parts after their manifest ids (it has no label for
 * volumes). Renames them in model_settings.config: `names` maps a part's
 * current name (manifest object id for the object's mesh, modifier volume id
 * for a volume) to its display name.
 */
export function renameParts(modelSettings: string, names: Record<string, string>): string {
  return modelSettings.replace(/<part\b[\s\S]*?<\/part>/g, (block) =>
    block.replace(/(<metadata key="name" value=")([^"]*)(")/, (all, a: string, v: string, b: string) => {
      const n = names[xmlUnescape(v)]
      return n === undefined ? all : `${a}${xmlEscape(n)}${b}`
    }))
}

export interface WriteInfo {
  /** Part name in the engine export (manifest id) → display name. */
  names: Record<string, string>
  /** Manifest object id → plate index. */
  plates: Record<string, number>
  plateCount: number
  /** Plate size (the printer's bed), for the plate grid. */
  bed: { x: number; y: number }
  /** project_settings `different_settings_to_system`: changed keys of process, filaments 1..n, printer. */
  differentSettings: string[]
  /** OrcaX1 data: manifest object id → { volumes: manifest volume id → shape }, plus the selection. */
  objects: Record<string, { id: string; volumes: Record<string, { id: string; shape: string }> }>
  selection: unknown
}

/**
 * Turns the engine's portable project export (no slice artifacts) into an
 * Orca project: the engine flattens logical plates into one build ("portable
 * OrcaSlicer 3MF export flattens logical plates"), so this moves each build
 * item to its plate's origin and writes Orca's <plate> list. It also names
 * the parts, records the changed settings keys and adds OrcaX1's own file.
 */
export function writeProject3mf(bytes: Uint8Array, info: WriteInfo): Uint8Array {
  const files = unzipSync(bytes)
  const msPath = 'Metadata/model_settings.config'
  let ms = files[msPath] ? strFromU8(files[msPath]) : '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n</config>\n'

  // Map engine object ids (model_settings / build item ids) to manifest ids via the part names.
  const fileIdOf = new Map<string, string>() // manifest object id -> 3MF object id
  const meta: ProjectMeta['objects'] = {}
  for (const ob of ms.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) {
    const [, fid, body] = ob
    const parts = [...body.matchAll(/<part id="(\d+)" subtype="([^"]*)">([\s\S]*?)<\/part>/g)].map((p) => ({ id: p[1], role: p[2], name: metaValue(p[3], 'name') ?? '' }))
    const mid = parts.find((p) => p.role === 'normal_part' && info.objects[p.name])?.name
    if (!mid) continue
    fileIdOf.set(mid, fid)
    const entry: ProjectMeta['objects'][string] = { id: info.objects[mid].id, volumes: {} }
    for (const p of parts) {
      const v = info.objects[mid].volumes[p.name]
      if (v) entry.volumes[p.id] = v
    }
    meta[fid] = entry
  }
  ms = renameParts(ms, info.names)

  // Plates: move build items to their plate's origin, then list the plates.
  const plateOf = new Map<string, number>() // 3MF object id -> plate
  for (const [mid, fid] of fileIdOf) plateOf.set(fid, info.plates[mid] ?? 0)
  const modelPath = rootModelPath(files)
  if (files[modelPath] && info.plateCount > 1) {
    const xml = strFromU8(files[modelPath]).replace(/<item\b[^>]*>/g, (tag) => {
      const plate = plateOf.get(attr(tag, 'objectid') ?? '') ?? 0
      const t = (attr(tag, 'transform') ?? '1 0 0 0 1 0 0 0 1 0 0 0').trim().split(/\s+/).map(Number)
      if (!plate || t.length !== 12) return tag
      const [ox, oy] = plateOrigin(plate, info.plateCount, info.bed)
      t[9] += ox; t[10] += oy
      const s = t.map((x) => String(+x.toPrecision(12))).join(' ')
      return /\stransform="/.test(tag) ? tag.replace(/(\stransform=")[^"]*"/, `$1${s}"`) : tag.replace(/<item\b/, `<item transform="${s}"`)
    })
    files[modelPath] = strToU8(xml)
  }
  if (!/<plate>/.test(ms)) {
    let identify = 100
    const plates = Array.from({ length: Math.max(1, info.plateCount) }, (_, i) => {
      const inst = [...plateOf].filter(([, p]) => p === i).map(([fid]) => [
        '    <model_instance>',
        `      <metadata key="object_id" value="${fid}"/>`,
        '      <metadata key="instance_id" value="0"/>',
        `      <metadata key="identify_id" value="${identify++}"/>`,
        '    </model_instance>',
      ].join('\n'))
      return ['  <plate>', `    <metadata key="plater_id" value="${i + 1}"/>`, '    <metadata key="plater_name" value=""/>',
        '    <metadata key="locked" value="false"/>', ...inst, '  </plate>'].join('\n')
    }).join('\n')
    ms = /<assemble>/.test(ms) ? ms.replace(/(\s*)<assemble>/, `\n${plates}$1<assemble>`) : ms.replace('</config>', `${plates}\n</config>`)
  }
  files[msPath] = strToU8(ms)

  const psPath = 'Metadata/project_settings.config'
  if (files[psPath] && info.differentSettings.some((s) => s)) {
    try {
      const ps = JSON.parse(strFromU8(files[psPath]))
      ps.different_settings_to_system = info.differentSettings
      files[psPath] = strToU8(JSON.stringify(ps, null, 4))
    } catch { /* leave it as exported */ }
  }

  const extra: ProjectMeta = { app: 'OrcaX1', version: 1, selection: info.selection, plateCount: info.plateCount, objects: meta }
  files[META_PATH] = strToU8(JSON.stringify(extra))
  return zipSync(files, { level: 6 })
}

function rootModelPath(files: Record<string, Uint8Array>): string {
  const rels = files['_rels/.rels']
  const m = rels && /Target="([^"]+\.model)"/i.exec(strFromU8(rels))
  return m ? m[1].replace(/^\//, '') : '3D/3dmodel.model'
}

// ---- Reading ----------------------------------------------------------------

export type PartRole = 'normal_part' | 'support_enforcer' | 'support_blocker' | 'modifier_part' | 'negative_part' | string

export interface ProjectPart {
  /** model_settings part id (the component's object id). */
  partId: string
  name: string
  role: PartRole
  /** The part's mesh as stored (triangle soup). */
  positions: Float32Array
  /** The part's placement in its object (three.js column-major 4x4). */
  matrix: number[]
}

export interface ProjectObject {
  fileId: string
  name: string
  /** 1-based extruder (filament slot). */
  extruder: number
  plate: number
  /** Instance world matrix (three.js column-major 4x4), plate origin removed. */
  matrix: number[]
  parts: ProjectPart[]
}

export interface ProjectFile {
  objects: ProjectObject[]
  plateCount: number
  /** project_settings.config, if present. */
  config: Record<string, any> | null
  meta: ProjectMeta | null
  /** True when the file has Orca/Bambu project metadata (not just geometry). */
  isProject: boolean
}

interface RawObject { mesh?: Float32Array; components: { path: string; id: string; t: number[] }[] }

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
const parseT = (s: string | null) => {
  const v = (s ?? '').trim().split(/\s+/).map(Number)
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY
}
/** Row-vector 3x4: a, then b. */
const mulT = (a: number[], b: number[]) => {
  const r = new Array(12).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    let s = i === 3 ? b[9 + j] : 0
    for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j]
    r[i * 3 + j] = s
  }
  return r
}

function parseModel(xml: string, path: string): { objects: Map<string, RawObject>; items: { id: string; t: number[]; printable: boolean }[] } {
  const objects = new Map<string, RawObject>()
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attr(m[1], 'id')
    if (!id) continue
    const body = m[2]
    const raw: RawObject = { components: [] }
    const mesh = /<mesh>([\s\S]*?)<\/mesh>/.exec(body)
    if (mesh) {
      const verts: number[] = []
      for (const v of mesh[1].matchAll(/<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g)) verts.push(+v[1], +v[2], +v[3])
      const tris = [...mesh[1].matchAll(/<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g)]
      const out = new Float32Array(tris.length * 9)
      tris.forEach((t, i) => {
        for (let k = 0; k < 3; k++) {
          const vi = +t[k + 1] * 3
          out[i * 9 + k * 3] = verts[vi]; out[i * 9 + k * 3 + 1] = verts[vi + 1]; out[i * 9 + k * 3 + 2] = verts[vi + 2]
        }
      })
      raw.mesh = out
    }
    for (const c of body.matchAll(/<component\b([^>]*)\/?>/g)) {
      const p = attr(c[1], 'p:path')
      raw.components.push({ id: attr(c[1], 'objectid') ?? '', path: p ? p.replace(/^\//, '') : path, t: parseT(attr(c[1], 'transform')) })
    }
    objects.set(id, raw)
  }
  const items = [...xml.matchAll(/<item\b([^>]*)\/?>/g)].map((m) => ({
    id: attr(m[1], 'objectid') ?? '', t: parseT(attr(m[1], 'transform')), printable: attr(m[1], 'printable') !== '0',
  }))
  return { objects, items }
}

/** Bed size from a flattened config's printable_area ("0x0,256x0,..." or a list). */
export function configBed(config: Record<string, any> | null): { x: number; y: number } | null {
  const area = config?.printable_area
  const pts = (Array.isArray(area) ? area : String(area ?? '').split(','))
    .map((p: string) => p.split('x').map(Number)).filter((p: number[]) => p.length === 2 && p.every(Number.isFinite))
  if (!pts.length) return null
  const xs = pts.map((p: number[]) => p[0]), ys = pts.map((p: number[]) => p[1])
  return { x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys) }
}

/**
 * Reads a 3MF as a project: objects with their parts (meshes in the part's own
 * frame plus its matrix), instance transforms, plates, settings. Each build
 * item becomes one object (Orca instances of one object become separate objects).
 */
export function readProject3mf(bytes: Uint8Array, fallbackBed: { x: number; y: number }): ProjectFile {
  const files = unzipSync(bytes)
  const text = (p: string) => (files[p] ? strFromU8(files[p]) : null)
  const root = rootModelPath(files)
  const docs = new Map<string, ReturnType<typeof parseModel>>()
  const doc = (path: string) => {
    let d = docs.get(path)
    if (!d) {
      const xml = text(path)
      if (xml === null) throw new Error(`3MF: missing ${path}`)
      d = parseModel(xml, path)
      docs.set(path, d)
    }
    return d
  }
  const rootDoc = doc(root)

  let config: Record<string, any> | null = null
  try { const ps = text('Metadata/project_settings.config'); if (ps) config = JSON.parse(ps) } catch { config = null }
  let meta: ProjectMeta | null = null
  try { const m = text(META_PATH); if (m) { const j = JSON.parse(m); if (j?.app === 'OrcaX1') meta = j } } catch { meta = null }

  // model_settings: object names / extruders, part names / subtypes, plates.
  const ms = text('Metadata/model_settings.config') ?? ''
  const objInfo = new Map<string, { name: string | null; extruder: number; parts: Map<string, { name: string; role: string }> }>()
  for (const ob of ms.matchAll(/<object id="([^"]+)">([\s\S]*?)<\/object>/g)) {
    const head = ob[2].split(/<part\b/)[0]
    const parts = new Map<string, { name: string; role: string }>()
    for (const p of ob[2].matchAll(/<part id="([^"]+)" subtype="([^"]*)">([\s\S]*?)<\/part>/g)) {
      parts.set(p[1], { name: metaValue(p[3], 'name') ?? '', role: p[2] })
    }
    objInfo.set(ob[1], { name: metaValue(head, 'name'), extruder: Number(metaValue(head, 'extruder') ?? '1') || 1, parts })
  }
  const plateOf = new Map<string, number>()
  let plateCount = 0
  for (const pl of ms.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const idx = Number(metaValue(pl[1], 'plater_id') ?? '0') - 1
    if (!(idx >= 0)) continue
    plateCount = Math.max(plateCount, idx + 1)
    for (const mi of pl[1].matchAll(/<model_instance>([\s\S]*?)<\/model_instance>/g)) {
      const oid = metaValue(mi[1], 'object_id')
      if (oid) plateOf.set(oid, idx)
    }
  }
  plateCount = Math.max(1, plateCount, meta?.plateCount ?? 0)
  const bed = configBed(config) ?? fallbackBed

  // Leaf meshes of a component tree, with the transform from mesh to the top object.
  const leaves = (path: string, id: string, t: number[], depth = 0): { positions: Float32Array; t: number[] }[] => {
    if (depth > 16) throw new Error('3MF: component nesting too deep')
    const o = doc(path).objects.get(id)
    if (!o) throw new Error(`3MF: missing object ${id} in ${path}`)
    const out: { positions: Float32Array; t: number[] }[] = []
    if (o.mesh) out.push({ positions: o.mesh, t })
    for (const c of o.components) out.push(...leaves(c.path, c.id, mulT(c.t, t), depth + 1))
    return out
  }

  const objects: ProjectObject[] = []
  for (const item of rootDoc.items) {
    const raw = rootDoc.objects.get(item.id)
    if (!raw) continue
    const info = objInfo.get(item.id)
    const parts: ProjectPart[] = []
    const addLeaves = (path: string, id: string, t: number[], partId: string) => {
      const p = info?.parts.get(partId)
      for (const leaf of leaves(path, id, t)) {
        parts.push({ partId, name: p?.name ?? '', role: p?.role ?? 'normal_part', positions: leaf.positions, matrix: transformToElements(leaf.t) })
      }
    }
    if (raw.mesh) parts.push({ partId: item.id, name: info?.name ?? '', role: 'normal_part', positions: raw.mesh, matrix: transformToElements(IDENTITY) })
    for (const c of raw.components) addLeaves(c.path, c.id, c.t, c.id)
    const plate = Math.min(plateOf.get(item.id) ?? 0, plateCount - 1)
    const t = [...item.t]
    if (plate > 0) {
      const [ox, oy] = plateOrigin(plate, plateCount, bed)
      t[9] -= ox; t[10] -= oy
    }
    objects.push({
      fileId: item.id,
      name: info?.name ?? `Object ${item.id}`,
      extruder: info?.extruder ?? 1,
      plate,
      matrix: transformToElements(t),
      parts,
    })
  }
  return { objects, plateCount, config, meta, isProject: !!(config || ms) }
}

/** True for a 3MF that carries an Orca / Bambu project (settings), not just geometry. */
export function isProject3mf(bytes: Uint8Array): boolean {
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name === 'Metadata/project_settings.config' })
    return !!files['Metadata/project_settings.config']
  } catch { return false }
}
