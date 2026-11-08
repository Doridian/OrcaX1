// Editing of an object's support enforcer / blocker volumes. Volumes live in
// the (immutable) ModelObject, so undo/redo and the slice manifest cover them.
import { computed, signal } from '@preact/signals'
import { Matrix4, Quaternion, Vector3 } from 'three'
import {
  centerMesh, decomposeVolume, meshExtent, primitive, volumeMatrix, ROLE_LABEL, SHAPE_LABEL,
  type ModelVolume, type VolumeRole, type VolumeShape,
} from '../model/volumes'
import { localBounds, objectMatrix, objects, selection, touch, type ModelObject } from './project'

/** The volume being edited (its object is the selected object). */
export const selectedVolume = signal<{ obj: string; vol: string } | null>(null)

/** The selected volume and its object, if both still exist (undo can remove them). */
export const activeVolume = computed(() => {
  const s = selectedVolume.value
  if (!s || selection.value.length !== 1 || selection.value[0] !== s.obj) return null
  const o = objects.value.find((x) => x.id === s.obj)
  const v = o?.volumes?.find((x) => x.id === s.vol)
  return o && v ? { o, v } : null
})

let nextVolume = 1

function replaceVolumes(id: string, fn: (list: ModelVolume[]) => ModelVolume[], final = true) {
  objects.value = objects.value.map((o) => (o.id === id ? { ...o, volumes: fn(o.volumes ?? []), rev: o.rev + 1 } : o))
  if (final) touch()
}

export function selectVolume(obj: string, vol: string | null) {
  selection.value = [obj]
  selectedVolume.value = vol ? { obj, vol } : null
}

/** Adds a volume to an object: centered on it, half its size (Orca places new modifiers similarly). */
export function addVolume(o: ModelObject, role: VolumeRole, shape: VolumeShape, mesh?: { name: string; positions: Float32Array }) {
  const lb = localBounds(o)
  const center: [number, number, number] = [0, 1, 2].map((a) => (lb.min[a] + lb.max[a]) / 2) as [number, number, number]
  const size = [0, 1, 2].map((a) => Math.max(5, (lb.max[a] - lb.min[a]) / 2))
  let positions: Float32Array
  let scale: [number, number, number]
  if (shape === 'mesh') {
    if (!mesh) throw new Error('no mesh')
    positions = centerMesh(mesh.positions)
    scale = [1, 1, 1]
  } else {
    positions = primitive(shape)
    const s = shape === 'box' ? size : [Math.min(size[0], size[1]), Math.min(size[0], size[1]), shape === 'sphere' ? Math.min(...size) : size[2]]
    if (shape === 'sphere') s[0] = s[1] = s[2]
    scale = s as [number, number, number]
  }
  const count = (o.volumes ?? []).filter((v) => v.role === role).length
  const v: ModelVolume = {
    id: `vol-${nextVolume++}`,
    name: mesh?.name ?? `${ROLE_LABEL[role]} ${count + 1} (${SHAPE_LABEL[shape].toLowerCase()})`,
    role,
    shape,
    positions,
    pos: center,
    rot: [0, 0, 0, 1],
    scale,
  }
  replaceVolumes(o.id, (list) => [...list, v])
  selectVolume(o.id, v.id)
  return v
}

export function removeVolume(obj: string, vol: string) {
  replaceVolumes(obj, (list) => list.filter((v) => v.id !== vol))
  if (selectedVolume.value?.obj === obj && selectedVolume.value.vol === vol) selectedVolume.value = null
}

export function patchVolume(obj: string, vol: string, patch: Partial<ModelVolume>, final = true) {
  replaceVolumes(obj, (list) => list.map((v) => (v.id === vol ? { ...v, ...patch } : v)), final)
}

/** World matrix of a volume (object instance transform × volume placement). */
export function volumeWorldMatrix(o: ModelObject, v: ModelVolume): Matrix4 {
  return objectMatrix(o).multiply(volumeMatrix(v))
}

/** Center, orientation and half extents of a volume in world space (for gizmos and selection). */
export function volumeWorldFrame(o: ModelObject, v: ModelVolume) {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3()
  volumeWorldMatrix(o, v).decompose(p, q, s)
  const ext = meshExtent(v.positions)
  return { center: p, quat: q, half: new Vector3(Math.abs(s.x) * ext[0] / 2, Math.abs(s.y) * ext[1] / 2, Math.abs(s.z) * ext[2] / 2) }
}

/** Applies a world-space transform `w` (about the world origin) to a volume, keeping its object fixed. */
export function transformedVolume(o: ModelObject, v: ModelVolume, w: Matrix4) {
  const obj = objectMatrix(o)
  const local = obj.clone().invert().multiply(w).multiply(obj).multiply(volumeMatrix(v))
  return decomposeVolume(local)
}

/** Scales a volume along its own axes (about its center). */
export function scaledVolume(v: ModelVolume, k: [number, number, number]) {
  return { scale: v.scale.map((s, a) => Math.max(1e-3, s * k[a])) as ModelVolume['scale'] }
}
