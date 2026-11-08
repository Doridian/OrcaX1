import { batch, computed, effect, signal } from '@preact/signals'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { bounds, recenter, writeStl, type ImportedMesh } from '../model/mesh'
import { volumeMatrix, type ModelVolume } from '../model/volumes'

export interface ModelObject {
  id: string
  name: string
  /** Triangle soup, centered on XY = 0 with its bottom at Z = 0. */
  positions: Float32Array
  x: number
  y: number
  rot: [number, number, number, number]
  scale: [number, number, number]
  filament: number
  plate: number
  /** Support enforcers / blockers attached to this object. */
  volumes?: ModelVolume[]
  /** Bumped on each geometry or transform change, so views can cache. */
  rev: number
}

let nextId = 1
export const objects = signal<ModelObject[]>([])
export const selection = signal<string[]>([])
export const plateCount = signal(1)
export const currentPlate = signal(0)
/** Bumped whenever anything that affects slicing changes. */
export const projectRev = signal(0)

export const plateObjects = computed(() => objects.value.filter((o) => o.plate === currentPlate.value))
export const selectedObjects = computed(() => objects.value.filter((o) => selection.value.includes(o.id)))

export function touch() { projectRev.value++ }

// ---- Undo / redo ---------------------------------------------------------
// ModelObjects are immutable (every edit replaces the object), so a snapshot is
// just the array reference plus the plate count. An effect records the state
// before each change. Changes made in the same task (e.g. a multi-object edit)
// and changes inside a gesture (a drag) collapse into one undo step.
interface Snapshot { objects: ModelObject[]; plateCount: number }
const undoStack: Snapshot[] = []
const redoStack: Snapshot[] = []
export const canUndo = signal(false)
export const canRedo = signal(false)
let last: Snapshot = { objects: objects.value, plateCount: plateCount.value }
let restoring = false
let stepOpen = false
let gesture = false

effect(() => {
  const cur: Snapshot = { objects: objects.value, plateCount: plateCount.value }
  if (cur.objects === last.objects && cur.plateCount === last.plateCount) return
  if (!restoring && !stepOpen) {
    undoStack.push(last)
    if (undoStack.length > 200) undoStack.shift()
    redoStack.length = 0
    stepOpen = true
    if (!gesture) queueMicrotask(() => { stepOpen = gesture })
  }
  last = cur
  canUndo.value = undoStack.length > 0
  canRedo.value = redoStack.length > 0
})

/** Groups every change until endGesture() into a single undo step. */
export function beginGesture() { gesture = true }
export function endGesture() { gesture = false; queueMicrotask(() => { stepOpen = gesture }) }

function restore(from: Snapshot[], to: Snapshot[]) {
  const s = from.pop()
  if (!s) return
  to.push(last)
  restoring = true
  batch(() => {
    objects.value = s.objects
    plateCount.value = s.plateCount
    if (currentPlate.value >= s.plateCount) currentPlate.value = s.plateCount - 1
    const ids = new Set(s.objects.map((o) => o.id))
    selection.value = selection.value.filter((id) => ids.has(id))
  })
  restoring = false
  canUndo.value = undoStack.length > 0
  canRedo.value = redoStack.length > 0
  touch()
}
export const undo = () => restore(undoStack, redoStack)
export const redo = () => restore(redoStack, undoStack)

export function addMeshes(meshes: ImportedMesh[], bed: { x: number; y: number }) {
  const added: ModelObject[] = []
  for (const m of meshes) {
    const positions = recenter(m.positions)
    const o: ModelObject = {
      id: `obj-${nextId++}`,
      name: m.name,
      positions,
      x: bed.x / 2,
      y: bed.y / 2,
      rot: [0, 0, 0, 1],
      scale: [1, 1, 1],
      filament: 0,
      plate: currentPlate.value,
      rev: 0,
    }
    if (m.origin && m.origin[0] > 0 && m.origin[0] < bed.x && m.origin[1] > 0 && m.origin[1] < bed.y) {
      o.x = m.origin[0]
      o.y = m.origin[1]
    }
    added.push(o)
  }
  // Find a free spot for each new object (footprint circles must not overlap).
  const radius = (o: ModelObject) => {
    const b = bounds(o.positions)
    return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2
  }
  const placed = plateObjects.value.map((p) => ({ x: p.x, y: p.y, r: radius(p) }))
  for (const o of added) {
    const r = radius(o)
    const free = (x: number, y: number) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + 3)
    if (!free(o.x, o.y)) {
      // Spiral out from the bed center.
      for (let i = 1; i < 2000; i++) {
        const a = i * 0.5, d = 2 * Math.sqrt(i) * 3
        const x = bed.x / 2 + Math.cos(a) * d, y = bed.y / 2 + Math.sin(a) * d
        if (x - r < 0 || y - r < 0 || x + r > bed.x || y + r > bed.y) continue
        if (free(x, y)) { o.x = x; o.y = y; break }
      }
    }
    placed.push({ x: o.x, y: o.y, r })
  }
  objects.value = [...objects.value, ...added]
  selection.value = added.map((o) => o.id)
  touch()
  return added
}

export function updateObject(id: string, patch: Partial<ModelObject>) {
  objects.value = objects.value.map((o) => (o.id === id ? { ...o, ...patch, rev: o.rev + 1 } : o))
  touch()
}

export function removeObjects(ids: string[]) {
  objects.value = objects.value.filter((o) => !ids.includes(o.id))
  selection.value = selection.value.filter((id) => !ids.includes(id))
  touch()
}

export function duplicateObjects(ids: string[]) {
  const copies = objects.value.filter((o) => ids.includes(o.id)).map((o) => ({
    ...o, id: `obj-${nextId++}`, x: o.x + 10, y: o.y + 10, rev: 0,
  }))
  objects.value = [...objects.value, ...copies]
  selection.value = copies.map((c) => c.id)
  touch()
}

/**
 * Replaces the whole project (open file / restore after reload). Starts a
 * fresh undo history: the previous project is not an undo step.
 */
export function loadProject(list: ModelObject[], plates: number) {
  for (const o of list) {
    const n = Number(/^obj-(\d+)$/.exec(o.id)?.[1])
    if (n >= nextId) nextId = n + 1
  }
  restoring = true
  batch(() => {
    objects.value = list
    plateCount.value = Math.max(1, plates)
    currentPlate.value = 0
    selection.value = []
  })
  restoring = false
  undoStack.length = 0
  redoStack.length = 0
  canUndo.value = false
  canRedo.value = false
  touch()
}

/** A fresh object id (for objects built outside addMeshes, e.g. a loaded project with duplicate ids). */
export function newObjectId() { return `obj-${nextId++}` }

export function clearProject() {
  objects.value = []
  selection.value = []
  plateCount.value = 1
  currentPlate.value = 0
  touch()
}

/** Rotation/scale matrix without translation, plus the Z lift that puts the transformed mesh on the bed. */
export function objectMatrix(o: ModelObject): Matrix4 {
  const m = new Matrix4().compose(new Vector3(0, 0, 0), new Quaternion(...o.rot), new Vector3(...o.scale))
  const e = m.elements
  const p = o.positions
  let minZ = Infinity
  for (let i = 0; i < p.length; i += 3) {
    const z = e[2] * p[i] + e[6] * p[i + 1] + e[10] * p[i + 2]
    if (z < minZ) minZ = z
  }
  m.setPosition(o.x, o.y, Number.isFinite(minZ) ? -minZ : 0)
  return m
}

/** Row-major 4x4 (column vectors), as the engine manifest expects. */
export function rowMajor(m: Matrix4): number[] {
  const e = m.elements // column-major
  return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]]
}

export function worldBounds(o: ModelObject) {
  const m = objectMatrix(o).elements
  const p = o.positions
  const t = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2]
    t[i] = m[0] * x + m[4] * y + m[8] * z + m[12]
    t[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
    t[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
  }
  return bounds(t)
}

const stlCache = new WeakMap<Float32Array, Uint8Array>()
function stlOf(positions: Float32Array) {
  let s = stlCache.get(positions)
  if (!s) { s = writeStl(positions); stlCache.set(positions, s) }
  return s
}

/** Builds the one-slicer-api project (object blob + manifest). */
export function buildProject(list: ModelObject[], plates: number) {
  const meshIds = new Map<Float32Array, string>()
  const chunks: Uint8Array[] = []
  const meshes: any[] = []
  let offset = 0
  const addMesh = (positions: Float32Array) => {
    if (meshIds.has(positions)) return
    const stl = stlOf(positions)
    const id = `mesh-${meshes.length}`
    meshIds.set(positions, id)
    meshes.push({ id, format: 'stl', dataRange: { offset, length: stl.length } })
    chunks.push(stl)
    offset += stl.length
  }
  for (const o of list) {
    addMesh(o.positions)
    for (const v of o.volumes ?? []) addMesh(v.positions)
  }
  const blob = new Uint8Array(offset)
  let o2 = 0
  for (const c of chunks) { blob.set(c, o2); o2 += c.length }
  const manifest = {
    schemaVersion: '0.7.0',
    plates: Array.from({ length: plates }, (_, i) => ({ id: `plate-${i}`, label: `Plate ${i + 1}`, index: i })),
    meshes,
    objects: list.map((o) => ({ id: o.id, meshId: meshIds.get(o.positions)!, extruderId: o.filament + 1, label: o.name })),
    instances: list.map((o) => ({
      id: `${o.id}-i`, objectId: o.id, plateId: `plate-${o.plate}`, transform: { matrix: rowMajor(objectMatrix(o)) },
    })),
    // Placed in the object's mesh coordinates; the engine applies the instance transform on top.
    modifierVolumes: list.flatMap((o) => (o.volumes ?? []).map((v) => ({
      id: volumeManifestId(o, v), meshId: meshIds.get(v.positions)!, role: v.role, objectId: o.id, plateId: `plate-${o.plate}`,
      transform: { matrix: rowMajor(volumeMatrix(v)) },
    }))),
  }
  return { blob, manifest }
}

/** Manifest id → display name of every object and volume (the engine names 3MF parts after manifest ids). */
export function partNames(list: ModelObject[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const o of list) {
    out[o.id] = o.name
    for (const v of o.volumes ?? []) out[volumeManifestId(o, v)] = v.name
  }
  return out
}

export const volumeManifestId = (o: ModelObject, v: ModelVolume) => `${o.id}-${v.id}`

// ---- Transforms (shared by the gizmos and the value-entry panels) ---------

export type Tool = 'move' | 'rotate' | 'scale' | 'lay' | null
export const activeTool = signal<Tool>(null)

/** Replaces several objects at once (one undo step, one re-render). */
export function patchObjects(patches: Map<string, Partial<ModelObject>>, final = true) {
  objects.value = objects.value.map((o) => {
    const p = patches.get(o.id)
    return p ? { ...o, ...p, rev: o.rev + 1 } : o
  })
  if (final) touch()
}

/** World-space bounding box of a group of objects. */
export function groupBounds(list: ModelObject[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const o of list) {
    const b = worldBounds(o)
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], b.min[a]); max[a] = Math.max(max[a], b.max[a]) }
  }
  return { min, max, center: [0, 1, 2].map((a) => (min[a] + max[a]) / 2) }
}

/** Mesh-space bounds (before scale/rotation), cached per geometry. */
const localBoundsCache = new WeakMap<Float32Array, ReturnType<typeof bounds>>()
export function localBounds(o: ModelObject) {
  let b = localBoundsCache.get(o.positions)
  if (!b) { b = bounds(o.positions); localBoundsCache.set(o.positions, b) }
  return b
}

/** Object size along its own (scaled, unrotated) axes. */
export function localSize(o: ModelObject): [number, number, number] {
  const b = localBounds(o)
  return [0, 1, 2].map((a) => (b.max[a] - b.min[a]) * o.scale[a]) as [number, number, number]
}

/** Moves objects (from their `base` state) by dx, dy. */
export function translated(base: ModelObject[], dx: number, dy: number) {
  return new Map(base.map((o) => [o.id, { x: o.x + dx, y: o.y + dy }]))
}

/** Rotates objects (from `base`) by quaternion q about a world point (XY of each object orbits it). */
export function rotated(base: ModelObject[], q: Quaternion, center: number[]) {
  const c = new Vector3(center[0], center[1], center[2])
  return new Map(base.map((o) => {
    const r = q.clone().multiply(new Quaternion(...o.rot)).normalize()
    const p = new Vector3(o.x, o.y, c.z).sub(c).applyQuaternion(q).add(c)
    return [o.id, { rot: [r.x, r.y, r.z, r.w] as ModelObject['rot'], x: base.length > 1 ? p.x : o.x, y: base.length > 1 ? p.y : o.y }]
  }))
}

/** Scales objects (from `base`) by per-axis factors in each object's own frame; groups scale about their center. */
export function scaled(base: ModelObject[], k: [number, number, number], center: number[]) {
  return new Map(base.map((o) => {
    const s = o.scale.map((v, a) => Math.max(1e-4, v * k[a])) as ModelObject['scale']
    if (base.length === 1) return [o.id, { scale: s }]
    return [o.id, { scale: s, x: center[0] + (o.x - center[0]) * k[0], y: center[1] + (o.y - center[1]) * k[1] }]
  }))
}

/** Rotates an object so that the given world-space face normal points down onto the bed. */
export function layOnFace(o: ModelObject, worldNormal: Vector3) {
  const q = new Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), new Vector3(0, 0, -1))
  const r = q.multiply(new Quaternion(...o.rot)).normalize()
  updateObject(o.id, { rot: [r.x, r.y, r.z, r.w] })
}
