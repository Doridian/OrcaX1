// Mesh import/export. Meshes are non-indexed triangle soups:
// Float32Array with 9 floats (3 vertices) per triangle.
import { strFromU8, unzipSync } from 'fflate'

export interface ImportedMesh {
  name: string
  positions: Float32Array
  /** Placement from the source file (3MF build item), if any: bed-space center offset. */
  origin?: [number, number, number]
}

export function parseStl(bytes: Uint8Array): Float32Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength >= 84) {
    const n = dv.getUint32(80, true)
    if (84 + n * 50 === bytes.byteLength) {
      const out = new Float32Array(n * 9)
      let o = 84
      for (let t = 0; t < n; t++) {
        o += 12
        for (let k = 0; k < 9; k++) { out[t * 9 + k] = dv.getFloat32(o, true); o += 4 }
        o += 2
      }
      return out
    }
  }
  // ASCII STL
  const text = new TextDecoder().decode(bytes)
  const nums: number[] = []
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3])
  if (nums.length === 0 || nums.length % 9 !== 0) throw new Error('not a valid STL file')
  return new Float32Array(nums)
}

export function writeStl(positions: Float32Array): Uint8Array {
  const n = positions.length / 9
  const buf = new ArrayBuffer(84 + n * 50)
  const dv = new DataView(buf)
  dv.setUint32(80, n, true)
  let o = 84
  for (let t = 0; t < n; t++) {
    const p = positions.subarray(t * 9, t * 9 + 9)
    const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2]
    const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2]
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true)
    o += 12
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, p[k], true); o += 4 }
    o += 2
  }
  return new Uint8Array(buf)
}

type Mat = number[] // 3MF 4x3, row-vector convention: [m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32]
const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
const parseMat = (s: string | null): Mat => {
  if (!s) return IDENTITY
  const v = s.trim().split(/\s+/).map(Number)
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY
}
/** a then b */
const mul = (a: Mat, b: Mat): Mat => {
  const r: Mat = new Array(12).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    let s = i === 3 ? b[9 + j] : 0
    for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j]
    r[i * 3 + j] = s
  }
  return r
}

interface ModelObj { name: string; mesh?: Float32Array; components?: { path: string; id: string; m: Mat }[] }

/** Parses a 3MF into one mesh per build item, with item transforms applied. */
export function parse3mf(bytes: Uint8Array): ImportedMesh[] {
  const files = unzipSync(bytes, { filter: (f) => f.name.endsWith('.model') || f.name.endsWith('.rels') })
  const norm = (p: string) => p.replace(/^\//, '')
  let root = '3D/3dmodel.model'
  const rels = files['_rels/.rels']
  if (rels) {
    const m = /Target="([^"]+\.model)"/i.exec(strFromU8(rels))
    if (m) root = norm(m[1])
  }
  const docs = new Map<string, Map<string, ModelObj>>()
  const load = (path: string): Map<string, ModelObj> => {
    const cached = docs.get(path)
    if (cached) return cached
    const data = files[path]
    if (!data) throw new Error(`3MF: missing ${path}`)
    const xml = new DOMParser().parseFromString(strFromU8(data), 'application/xml')
    const objs = new Map<string, ModelObj>()
    for (const o of Array.from(xml.getElementsByTagNameNS('*', 'object'))) {
      const entry: ModelObj = { name: o.getAttribute('name') ?? `object ${o.getAttribute('id')}` }
      const mesh = o.getElementsByTagNameNS('*', 'mesh')[0]
      if (mesh) {
        const vs = mesh.getElementsByTagNameNS('*', 'vertex')
        const verts = new Float32Array(vs.length * 3)
        for (let i = 0; i < vs.length; i++) {
          verts[i * 3] = +vs[i].getAttribute('x')!
          verts[i * 3 + 1] = +vs[i].getAttribute('y')!
          verts[i * 3 + 2] = +vs[i].getAttribute('z')!
        }
        const ts = mesh.getElementsByTagNameNS('*', 'triangle')
        const out = new Float32Array(ts.length * 9)
        for (let i = 0; i < ts.length; i++) {
          const idx = [+ts[i].getAttribute('v1')!, +ts[i].getAttribute('v2')!, +ts[i].getAttribute('v3')!]
          for (let k = 0; k < 3; k++) out.set(verts.subarray(idx[k] * 3, idx[k] * 3 + 3), i * 9 + k * 3)
        }
        entry.mesh = out
      }
      const comps = o.getElementsByTagNameNS('*', 'component')
      if (comps.length) {
        entry.components = Array.from(comps).map((c) => ({
          id: c.getAttribute('objectid')!,
          path: norm(c.getAttribute('p:path') ?? c.getAttributeNS('http://schemas.microsoft.com/3dmanufacturing/production/2015/06', 'path') ?? path),
          m: parseMat(c.getAttribute('transform')),
        }))
      }
      objs.set(o.getAttribute('id')!, entry)
    }
    docs.set(path, objs)
    ;(objs as any).__build = Array.from(xml.getElementsByTagNameNS('*', 'item')).map((it) => ({
      id: it.getAttribute('objectid')!, m: parseMat(it.getAttribute('transform')),
    }))
    return objs
  }

  const flatten = (path: string, id: string, m: Mat, out: Float32Array[], depth = 0) => {
    if (depth > 16) throw new Error('3MF: component nesting too deep')
    const obj = load(path).get(id)
    if (!obj) throw new Error(`3MF: missing object ${id} in ${path}`)
    if (obj.mesh) {
      const src = obj.mesh, dst = new Float32Array(src.length)
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i], y = src[i + 1], z = src[i + 2]
        dst[i] = x * m[0] + y * m[3] + z * m[6] + m[9]
        dst[i + 1] = x * m[1] + y * m[4] + z * m[7] + m[10]
        dst[i + 2] = x * m[2] + y * m[5] + z * m[8] + m[11]
      }
      out.push(dst)
    }
    for (const c of obj.components ?? []) flatten(c.path, c.id, mul(c.m, m), out, depth + 1)
  }

  const rootObjs = load(root)
  const build: { id: string; m: Mat }[] = (rootObjs as any).__build
  const result: ImportedMesh[] = []
  for (const item of build) {
    const parts: Float32Array[] = []
    flatten(root, item.id, item.m, parts)
    const total = parts.reduce((s, p) => s + p.length, 0)
    if (!total) continue
    const positions = new Float32Array(total)
    let o = 0
    for (const p of parts) { positions.set(p, o); o += p.length }
    const b = bounds(positions)
    result.push({
      name: rootObjs.get(item.id)?.name ?? 'object',
      positions,
      origin: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]],
    })
  }
  if (!result.length) throw new Error('3MF contains no printable objects')
  return result
}

export function bounds(p: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  return { min, max }
}

/** Moves a mesh so its bounding box is centered on XY = 0 and its bottom at Z = 0. */
export function recenter(p: Float32Array): Float32Array {
  const b = bounds(p)
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = b.min[2]
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i] - cx; out[i + 1] = p[i + 1] - cy; out[i + 2] = p[i + 2] - cz
  }
  return out
}

export type Converter = (kind: 'obj' | 'step' | '3mf', bytes: Uint8Array) => Promise<Uint8Array>

export async function importFile(file: File, convert: Converter): Promise<ImportedMesh[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const base = file.name.replace(/\.[^.]+$/, '')
  const ext = file.name.toLowerCase().split('.').pop()
  switch (ext) {
    case 'stl':
      return [{ name: base, positions: parseStl(bytes) }]
    case '3mf':
      try {
        return parse3mf(bytes)
      } catch (e) {
        console.warn('3MF parse failed, falling back to engine import', e)
        return [{ name: base, positions: parseStl(await convert('3mf', bytes)) }]
      }
    case 'obj':
      return [{ name: base, positions: parseStl(await convert('obj', bytes)) }]
    case 'step':
    case 'stp':
      return [{ name: base, positions: parseStl(await convert('step', bytes)) }]
    default:
      throw new Error(`unsupported file type .${ext}`)
  }
}
