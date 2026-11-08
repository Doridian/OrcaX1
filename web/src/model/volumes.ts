// Extra volumes of an object (Orca's "parts" list below an object): support
// enforcers and blockers. They live in the object's mesh coordinates, so they
// follow the object when it is moved, rotated or scaled.
//
// The engine (OrcaWasm, one-slicer-api 0.7) only accepts these two roles in
// the project manifest's `modifierVolumes`; settings modifiers, negative
// volumes and per-object/per-volume config overrides are rejected (see
// scripts/engine-modifiers.mjs).
import { Matrix4, Quaternion, Vector3 } from 'three'

export type VolumeRole = 'support-enforcer' | 'support-blocker'
export type VolumeShape = 'box' | 'cylinder' | 'sphere' | 'mesh'

export interface ModelVolume {
  id: string
  name: string
  role: VolumeRole
  shape: VolumeShape
  /** Triangle soup centered on its bounding box (primitives: unit size, -0.5..0.5). */
  positions: Float32Array
  /** Placement in the object's mesh coordinates. */
  pos: [number, number, number]
  rot: [number, number, number, number]
  scale: [number, number, number]
}

export const ROLE_LABEL: Record<VolumeRole, string> = {
  'support-enforcer': 'Support enforcer',
  'support-blocker': 'Support blocker',
}
export const ROLE_COLOR: Record<VolumeRole, number> = {
  'support-enforcer': 0x3fb950,
  'support-blocker': 0xe5463b,
}
export const SHAPE_LABEL: Record<VolumeShape, string> = { box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', mesh: 'Mesh' }

function tri(out: number[], a: number[], b: number[], c: number[]) { out.push(...a, ...b, ...c) }

function unitBox(): Float32Array {
  const v = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map((p) => p.map((c) => c / 2))
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const out: number[] = []
  for (const [a, b, c] of f) tri(out, v[a], v[b], v[c])
  return new Float32Array(out)
}

function unitCylinder(n = 48): Float32Array {
  const out: number[] = []
  const ring = (z: number) => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI) / 2, Math.sin((i / n) * 2 * Math.PI) / 2, z])
  const lo = ring(-0.5), hi = ring(0.5)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    tri(out, [0, 0, -0.5], lo[j], lo[i])
    tri(out, [0, 0, 0.5], hi[i], hi[j])
    tri(out, lo[i], lo[j], hi[j])
    tri(out, lo[i], hi[j], hi[i])
  }
  return new Float32Array(out)
}

function unitSphere(rings = 24, segs = 48): Float32Array {
  const out: number[] = []
  const p = (r: number, s: number) => {
    const th = (r / rings) * Math.PI, ph = (s / segs) * 2 * Math.PI
    return [Math.sin(th) * Math.cos(ph) / 2, Math.sin(th) * Math.sin(ph) / 2, Math.cos(th) / 2]
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = p(r, s), b = p(r + 1, s), c = p(r + 1, s + 1), d = p(r, s + 1)
      if (r > 0) tri(out, a, b, d)
      if (r < rings - 1) tri(out, b, c, d)
    }
  }
  return new Float32Array(out)
}

// Shared per shape, so the slice manifest sends each primitive once.
const primitives = new Map<VolumeShape, Float32Array>()
export function primitive(shape: Exclude<VolumeShape, 'mesh'>): Float32Array {
  let p = primitives.get(shape)
  if (!p) {
    p = shape === 'box' ? unitBox() : shape === 'cylinder' ? unitCylinder() : unitSphere()
    primitives.set(shape, p)
  }
  return p
}

/** Moves a triangle soup so its bounding box is centered on the origin. */
export function centerMesh(positions: Float32Array): Float32Array {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    const a = i % 3
    if (positions[i] < min[a]) min[a] = positions[i]
    if (positions[i] > max[a]) max[a] = positions[i]
  }
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i++) out[i] = positions[i] - (min[i % 3] + max[i % 3]) / 2
  return out
}

/** Extent of the volume's mesh (before its scale). */
export function meshExtent(positions: Float32Array): [number, number, number] {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    const a = i % 3
    if (positions[i] < min[a]) min[a] = positions[i]
    if (positions[i] > max[a]) max[a] = positions[i]
  }
  return [0, 1, 2].map((a) => (Number.isFinite(max[a] - min[a]) ? max[a] - min[a] : 0)) as [number, number, number]
}

/** Volume placement relative to its object's mesh coordinates. */
export function volumeMatrix(v: ModelVolume): Matrix4 {
  return new Matrix4().compose(new Vector3(...v.pos), new Quaternion(...v.rot), new Vector3(...v.scale))
}

/** Splits a local matrix back into a volume's pos/rot/scale. */
export function decomposeVolume(m: Matrix4): Pick<ModelVolume, 'pos' | 'rot' | 'scale'> {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3()
  m.decompose(p, q, s)
  q.normalize()
  return {
    pos: [p.x, p.y, p.z],
    rot: [q.x, q.y, q.z, q.w],
    scale: [Math.max(1e-3, s.x), Math.max(1e-3, s.y), Math.max(1e-3, s.z)],
  }
}
