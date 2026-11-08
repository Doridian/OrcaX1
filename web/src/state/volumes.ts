// Editing of an object's support enforcer / blocker volumes. Volumes live in
// the (immutable) ModelObject, so undo/redo and the slice manifest cover them.
import { computed, signal } from '@preact/signals'
import { Matrix4, Quaternion, Vector3 } from 'three'
import {
  centerMesh, composeVolume, meshExtent, primitive, volumeMatrix, volumeTRS, ROLE_LABEL, SHAPE_LABEL,
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
  // Ids only need to be unique within the object (a loaded project brings its own).
  const used = new Set((o.volumes ?? []).map((x) => x.id))
  let id = `vol-${nextVolume++}`
  while (used.has(id)) id = `vol-${nextVolume++}`
  const v: ModelVolume = {
    id,
    name: mesh?.name ?? `${ROLE_LABEL[role]} ${count + 1} (${SHAPE_LABEL[shape].toLowerCase()})`,
    role,
    shape,
    positions,
    matrix: composeVolume(center, [0, 0, 0, 1], scale),
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
  // A sheared volume has no exact frame; its first axis and the plane of the
  // first two are kept (volumeTRS), which is what the gizmo needs.
  const { pos, rot, scale: s } = volumeTRS({ matrix: volumeWorldMatrix(o, v).toArray() })
  const ext = meshExtent(v.positions)
  return { center: new Vector3(...pos), quat: new Quaternion(...rot), half: new Vector3(Math.abs(s[0]) * ext[0] / 2, Math.abs(s[1]) * ext[1] / 2, Math.abs(s[2]) * ext[2] / 2) }
}

/**
 * Applies a world-space transform `w` (about the world origin) to a volume,
 * keeping its object fixed. The result is exact: with a non-uniformly scaled
 * object, a world rotation is a shear in the object's frame, which the
 * volume's matrix keeps.
 */
export function transformedVolume(o: ModelObject, v: ModelVolume, w: Matrix4) {
  const obj = objectMatrix(o)
  const local = obj.clone().invert().multiply(w).multiply(obj).multiply(volumeMatrix(v))
  return { matrix: local.toArray() }
}

/** Scales a volume along its own axes (about its center); each axis keeps at least 1e-3 of its mesh size. */
export function scaledVolume(v: ModelVolume, k: [number, number, number]) {
  const e = [...v.matrix]
  for (let a = 0; a < 3; a++) {
    const len = Math.hypot(e[a * 4], e[a * 4 + 1], e[a * 4 + 2])
    const f = len * Math.abs(k[a]) < 1e-3 ? 1e-3 / Math.max(len, 1e-12) : k[a]
    for (let r = 0; r < 3; r++) e[a * 4 + r] *= f
  }
  return { matrix: e }
}

/** Sets the volume's position (in object mesh coordinates). */
export function positionedVolume(v: ModelVolume, pos: [number, number, number]) {
  const e = [...v.matrix]
  e[12] = pos[0]; e[13] = pos[1]; e[14] = pos[2]
  return { matrix: e }
}

/** Turns the volume (about its center) so its displayed rotation becomes `rot`; any shear is kept. */
export function rotatedVolume(v: ModelVolume, rot: [number, number, number, number]) {
  const cur = volumeTRS(v)
  const delta = new Matrix4().makeRotationFromQuaternion(new Quaternion(...rot).multiply(new Quaternion(...cur.rot).invert()))
  const m = volumeMatrix(v)
  const p = new Vector3().setFromMatrixPosition(m)
  m.setPosition(0, 0, 0).premultiply(delta).setPosition(p)
  return { matrix: m.toArray() }
}
