// Orca-style manipulation gizmos: move arrows, rotation rings and scale handles.
// The gizmo is a Group placed at the selection's center; `frame` gives its
// orientation (world axes for move/rotate, the object's own axes for scaling a
// single object). Handles keep a constant on-screen size via `unit`.
import {
  BoxGeometry, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments,
  Mesh, MeshBasicMaterial, Object3D, Quaternion, Raycaster, TorusGeometry, Vector3,
} from 'three'

export type GizmoMode = 'move' | 'rotate' | 'scale'
/** Handle ids: m0/m1/m2 (move along axis), r0/r1/r2 (rotate about axis), s0/s1/s2 (scale axis), su (uniform). */
export type HandleId = `m${0 | 1 | 2}` | `r${0 | 1 | 2}` | `s${0 | 1 | 2}` | 'su'

export interface GizmoFrame {
  center: Vector3
  quat: Quaternion
  /** Half extents of the box the handles sit on, in the frame's axes. */
  half: Vector3
}

/** Rotation snap zones, as multiples of the ring radius (distance of the cursor from the center). */
export const SNAP_FREE_OUT = 1.1 // closer than this: free rotation
export const SNAP_FINE_OUT = 1.6 // up to this: 5° steps; beyond: 15° steps

const AXIS_COLORS = [0xe5463b, 0x3fb950, 0x3d8bfd]
const UNIFORM_COLOR = 0xb0b8c4
const HOVER_COLOR = 0xffc107

export class Gizmo {
  readonly group = new Group()
  private pickables: Mesh[] = []
  private visuals = new Map<string, Mesh[]>()
  private hovered: string | null = null
  mode: GizmoMode | null = null
  frame: GizmoFrame | null = null
  /** Multi-object selections only get uniform scaling. */
  uniformOnly = false
  /** Radius of the rotation rings as last drawn (mm). */
  ringRadius = 0
  /**
   * While a ring is being dragged: its axis. Only that ring is drawn, with
   * snap tick marks, and its radius stays fixed so the snap zones don't move.
   */
  activeRing: { axis: 0 | 1 | 2; radius: number } | null = null

  constructor() {
    this.group.renderOrder = 20
  }

  /** Rebuilds the handles; `unit` is roughly one on-screen pixel-ish size in mm at the gizmo's distance. */
  update(mode: GizmoMode | null, frame: GizmoFrame | null, unit: number) {
    this.mode = mode
    this.frame = frame
    for (const c of [...this.group.children]) this.dispose(c)
    this.group.clear()
    this.pickables = []
    this.visuals.clear()
    if (!mode || !frame) { this.group.visible = false; return }
    this.group.visible = true
    this.group.position.copy(frame.center)
    this.group.quaternion.copy(frame.quat)
    const u = unit
    const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)]
    const up = new Vector3(0, 1, 0)

    if (mode === 'move') {
      // X and Y only: objects always rest on the bed.
      for (const a of [0, 1] as const) {
        const len = frame.half.getComponent(a) + 60 * u
        const dir = axes[a]
        const q = new Quaternion().setFromUnitVectors(up, dir)
        const start = frame.half.getComponent(a) + 4 * u
        const shaft = new Mesh(new CylinderGeometry(1.2 * u, 1.2 * u, len - start, 8), this.mat(AXIS_COLORS[a]))
        shaft.quaternion.copy(q)
        shaft.position.copy(dir).multiplyScalar((start + len) / 2)
        const head = new Mesh(new ConeGeometry(4 * u, 10 * u, 16), this.mat(AXIS_COLORS[a]))
        head.quaternion.copy(q)
        head.position.copy(dir).multiplyScalar(len + 5 * u)
        const pick = new Mesh(new CylinderGeometry(6 * u, 6 * u, len + 10 * u - start, 6), this.pickMat())
        pick.quaternion.copy(q)
        pick.position.copy(dir).multiplyScalar((start + len + 10 * u) / 2)
        this.add(`m${a}`, [shaft, head], pick)
      }
    } else if (mode === 'rotate') {
      const r = this.activeRing?.radius ?? Math.hypot(frame.half.x, frame.half.y, frame.half.z) + 10 * u
      this.ringRadius = r
      for (const a of [0, 1, 2] as const) {
        if (this.activeRing && this.activeRing.axis !== a) continue
        const ring = new Mesh(new TorusGeometry(r, 1.3 * u, 8, 96), this.mat(AXIS_COLORS[a]))
        const pick = new Mesh(new TorusGeometry(r, 6 * u, 6, 64), this.pickMat())
        // Torus lies in its XY plane (axis = Z); turn it to face the wanted axis.
        const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), axes[a])
        ring.quaternion.copy(q)
        pick.quaternion.copy(q)
        this.add(`r${a}`, [ring], pick)
        if (this.activeRing) {
          // Snap ticks just outside the ring: every 5°, long ones every 15°,
          // matching the snap zones in SceneView (5° near, 15° further out).
          const pts: number[] = []
          for (let i = 0; i < 72; i++) {
            const t = (i * 5 * Math.PI) / 180
            const r0 = r * SNAP_FREE_OUT, r1 = r0 + (i % 3 === 0 ? 14 : 6) * u
            pts.push(Math.cos(t) * r0, Math.sin(t) * r0, 0, Math.cos(t) * r1, Math.sin(t) * r1, 0)
          }
          const g = new BufferGeometry()
          g.setAttribute('position', new Float32BufferAttribute(pts, 3))
          const ticks = new LineSegments(g, new LineBasicMaterial({ color: AXIS_COLORS[a], depthTest: false, transparent: true }))
          ticks.renderOrder = 20
          ticks.quaternion.copy(q)
          this.group.add(ticks)
        }
      }
    } else if (mode === 'scale') {
      const h = frame.half
      const sz = 7 * u
      if (!this.uniformOnly) {
        for (const a of [0, 1, 2] as const) {
          const meshes: Mesh[] = []
          for (const s of [-1, 1]) {
            const m = new Mesh(new BoxGeometry(sz, sz, sz), this.mat(AXIS_COLORS[a]))
            m.position.copy(axes[a]).multiplyScalar(s * (h.getComponent(a) + 6 * u))
            meshes.push(m)
          }
          const picks = meshes.map((m) => {
            const p = new Mesh(new BoxGeometry(sz * 2.2, sz * 2.2, sz * 2.2), this.pickMat())
            p.position.copy(m.position)
            return p
          })
          this.add(`s${a}`, meshes, ...picks)
        }
      }
      const corners: Mesh[] = []
      for (let c = 0; c < 8; c++) {
        const m = new Mesh(new BoxGeometry(sz, sz, sz), this.mat(UNIFORM_COLOR))
        m.position.set((c & 1 ? 1 : -1) * (h.x + 2 * u), (c & 2 ? 1 : -1) * (h.y + 2 * u), (c & 4 ? 1 : -1) * (h.z + 2 * u))
        corners.push(m)
      }
      const picks = corners.map((m) => {
        const p = new Mesh(new BoxGeometry(sz * 2.2, sz * 2.2, sz * 2.2), this.pickMat())
        p.position.copy(m.position)
        return p
      })
      this.add('su', corners, ...picks)
    }
    if (this.hovered) this.setHover(this.hovered)
  }

  pick(raycaster: Raycaster): HandleId | null {
    if (!this.group.visible || !this.pickables.length) return null
    this.group.updateMatrixWorld(true)
    const hits = raycaster.intersectObjects(this.pickables, false)
    if (this.mode === 'rotate' && this.frame && hits.length > 1) {
      // Rings overlap on screen (one is often seen nearly edge-on). Prefer the
      // ring whose plane the cursor ray meets closest to the ring itself.
      const c = this.frame.center
      let best: HandleId | null = null, bestScore = Infinity
      for (const h of new Set(hits.map((x) => x.object.userData.handle as HandleId))) {
        const axis = this.axis(Number(h[1]))
        const denom = axis.dot(raycaster.ray.direction)
        if (Math.abs(denom) < 1e-6) continue
        const t = axis.dot(c.clone().sub(raycaster.ray.origin)) / denom
        const p = raycaster.ray.at(t, new Vector3())
        const score = Math.abs(p.distanceTo(c) - this.ringRadius) / this.ringRadius
        if (score < bestScore) { bestScore = score; best = h }
      }
      if (best) return best
    }
    return (hits[0]?.object.userData.handle as HandleId) ?? null
  }

  setHover(id: string | null) {
    if (this.hovered && this.hovered !== id) this.paint(this.hovered, false)
    this.hovered = id
    if (id) this.paint(id, true)
  }

  /** World direction of a frame axis. */
  axis(a: number): Vector3 {
    return new Vector3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0).applyQuaternion(this.frame?.quat ?? new Quaternion())
  }

  private add(id: string, visuals: Mesh[], ...picks: Mesh[]) {
    for (const v of visuals) { v.renderOrder = 20; v.userData.baseColor = (v.material as MeshBasicMaterial).color.getHex(); this.group.add(v) }
    for (const p of picks) { p.userData.handle = id; this.group.add(p); this.pickables.push(p) }
    this.visuals.set(id, visuals)
  }

  private paint(id: string, on: boolean) {
    for (const v of this.visuals.get(id) ?? []) (v.material as MeshBasicMaterial).color = new Color(on ? HOVER_COLOR : v.userData.baseColor)
  }

  private mat(color: number) {
    return new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
  }

  private pickMat() {
    return new MeshBasicMaterial({ visible: false })
  }

  private dispose(o: Object3D) {
    const m = o as Mesh
    m.geometry?.dispose()
    ;(m.material as MeshBasicMaterial | undefined)?.dispose?.()
  }
}
