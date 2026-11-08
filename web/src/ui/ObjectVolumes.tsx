// Object list entries for an object's support enforcer / blocker volumes, the
// "Add" menu, and the transform panel of the volume being edited.
import { useRef, useState } from 'preact/hooks'
import { Euler, Quaternion } from 'three'
import { importFile } from '../model/mesh'
import { isSheared, meshExtent, volumeTRS, ROLE_COLOR, ROLE_LABEL, type VolumeRole, type VolumeShape } from '../model/volumes'
import { getEngine } from '../slicer/engine'
import type { ModelObject } from '../state/project'
import { processScalar } from '../state/settings'
import {
  activeVolume, addVolume, patchVolume, positionedVolume, removeVolume, rotatedVolume, scaledVolume, selectVolume, selectedVolume,
} from '../state/volumes'
import { NumField } from './Tools'

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`
const RAD = Math.PI / 180

/** The volumes of one object, as indented rows under it in the object list. */
export function VolumeRows({ o }: { o: ModelObject }) {
  const active = activeVolume.value
  return (
    <>
      {(o.volumes ?? []).map((v) => (
        <li class={`volume${active?.o.id === o.id && active.v.id === v.id ? ' sel' : ''}`} title={ROLE_LABEL[v.role]}
          onClick={(e) => { e.stopPropagation(); selectVolume(o.id, v.id) }}>
          <span class="swatch" style={{ background: hex(ROLE_COLOR[v.role]), width: '10px', height: '10px', borderRadius: '2px' }} />
          <span class="name" title={v.name}>{v.name}</span>
          <button class="small icon" title="Delete" onClick={(e) => { e.stopPropagation(); removeVolume(o.id, v.id) }}>×</button>
        </li>
      ))}
    </>
  )
}

/** "Add" controls for the single selected object, plus hints about support settings. */
export function AddVolume({ o }: { o: ModelObject }) {
  const [role, setRole] = useState<VolumeRole>('support-enforcer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const add = (shape: VolumeShape) => { setError(null); addVolume(o, role, shape) }
  const fromFile = async (f: File) => {
    setBusy(true); setError(null)
    try {
      const meshes = await importFile(f, async (kind, bytes) => (await getEngine()).convert(kind, bytes))
      if (!meshes.length) throw new Error('no mesh in file')
      // A multi-object file becomes one volume.
      const total = meshes.reduce((n, m) => n + m.positions.length, 0)
      const positions = new Float32Array(total)
      let off = 0
      for (const m of meshes) { positions.set(m.positions, off); off += m.positions.length }
      addVolume(o, role, 'mesh', { name: meshes[0].name, positions })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally { setBusy(false) }
  }
  const vols = o.volumes ?? []
  const supportOn = processScalar('enable_support') === '1'
  const manual = /\(manual\)/.test(processScalar('support_type'))
  return (
    <div class="add-volume">
      <div class="row">
        <label>Add</label>
        <div class="control">
          <select value={role} onChange={(e) => setRole(e.currentTarget.value as VolumeRole)}>
            <option value="support-enforcer">{ROLE_LABEL['support-enforcer']}</option>
            <option value="support-blocker">{ROLE_LABEL['support-blocker']}</option>
          </select>
        </div>
      </div>
      <div class="actions">
        <button class="small" onClick={() => add('box')}>Box</button>
        <button class="small" onClick={() => add('cylinder')}>Cylinder</button>
        <button class="small" onClick={() => add('sphere')}>Sphere</button>
        <button class="small" disabled={busy} onClick={() => file.current!.click()}>{busy ? 'Loading…' : 'From file…'}</button>
      </div>
      <input ref={file} type="file" accept=".stl,.3mf,.obj,.step,.stp" style={{ display: 'none' }}
        onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) fromFile(f); e.currentTarget.value = '' }} />
      {error && <div class="error small-text">{error}</div>}
      {vols.length > 0 && !supportOn && (
        <div class="warning small-text">Support is off in the process settings, so these volumes have no effect. Enable support; the "(manual)" support types only support the enforced areas.</div>
      )}
      {supportOn && manual && !vols.some((v) => v.role === 'support-enforcer') && (
        <div class="muted small-text">The "(manual)" support type only generates support inside support enforcers.</div>
      )}
    </div>
  )
}

/** Numeric transform of the volume being edited, in its object's (unscaled mesh) coordinates. */
export function VolumePanel() {
  const av = activeVolume.value
  if (!av) return null
  const { o, v } = av
  const trs = volumeTRS(v)
  const euler = new Euler().setFromQuaternion(new Quaternion(...trs.rot), 'XYZ')
  const ext = meshExtent(v.positions)
  const size = trs.scale.map((s, a) => Math.abs(s) * ext[a])
  const set = (patch: Parameters<typeof patchVolume>[2]) => patchVolume(o.id, v.id, patch)
  const axes = ['X', 'Y', 'Z']
  return (
    <>
      <div class="row">
        <label>Type</label>
        <div class="control">
          <select value={v.role} onChange={(e) => set({ role: e.currentTarget.value as VolumeRole })}>
            <option value="support-enforcer">{ROLE_LABEL['support-enforcer']}</option>
            <option value="support-blocker">{ROLE_LABEL['support-blocker']}</option>
          </select>
        </div>
      </div>
      <div class="grid3">
        <span class="muted small-text">Pos. mm</span>
        {[0, 1, 2].map((a) => (
          <label><b class={`ax${a}`}>{axes[a]}</b><NumField value={trs.pos[a]} onCommit={(x) => {
            const p = [...trs.pos] as typeof trs.pos; p[a] = x; set(positionedVolume(v, p))
          }} /></label>
        ))}
      </div>
      <div class="grid3">
        <span class="muted small-text">Rot. °</span>
        {[0, 1, 2].map((a) => (
          <label><b class={`ax${a}`}>{axes[a]}</b><NumField value={[euler.x, euler.y, euler.z][a] / RAD} onCommit={(x) => {
            const e = [euler.x, euler.y, euler.z]; e[a] = x * RAD
            const q = new Quaternion().setFromEuler(new Euler(e[0], e[1], e[2], 'XYZ'))
            set(rotatedVolume(v, [q.x, q.y, q.z, q.w]))
          }} /></label>
        ))}
      </div>
      <div class="grid3">
        <span class="muted small-text">Size mm</span>
        {[0, 1, 2].map((a) => (
          <label><b class={`ax${a}`}>{axes[a]}</b><NumField value={size[a]} onCommit={(x) => {
            if (!(x > 0) || !(size[a] > 0)) return
            const k: [number, number, number] = [1, 1, 1]; k[a] = x / size[a]; set(scaledVolume(v, k))
          }} /></label>
        ))}
      </div>
      <div class="actions">
        <button class="small" onClick={() => { selectedVolume.value = null }}>Done</button>
        <button class="small" onClick={() => removeVolume(o.id, v.id)}>Delete</button>
      </div>
      <div class="muted small-text">In the object's coordinates (before its own scale and rotation). The move, rotate and scale gizmos act on this volume while it is selected.</div>
      {isSheared(v) && <div class="muted small-text">Rotated inside a non-uniformly scaled object, so the volume is sheared in the object's coordinates: rotation and size above are its nearest unsheared equivalent; edits keep the shear.</div>}
    </>
  )
}
