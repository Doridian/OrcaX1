// three.js scene for the bed, models (prepare) and toolpaths (preview).
// Bambu coordinates: Z up, bed from (0,0) to (bed.x, bed.y).
import {
  AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, EdgesGeometry, Float32BufferAttribute,
  Group, HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera,
  Plane, PlaneGeometry, Quaternion, Raycaster, Scene, ShapeGeometry, Shape, Vector2, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { FEATURES, type GcodePreview } from '../gcode/parse'
import { groupBounds, localBounds, objectMatrix, worldBounds, type ModelObject, type Tool } from '../state/project'
import { Gizmo, SNAP_FINE_OUT, SNAP_FREE_OUT, type HandleId } from './gizmo'

export type GizmoEvent =
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'rotate'; q: Quaternion; center: number[]; degrees: number; snap: 0 | 5 | 15; clientX: number; clientY: number }
  | { kind: 'scale'; k: [number, number, number]; center: number[] }

export interface BedInfo { x: number; y: number; z: number; exclude: [number, number][] }

export interface PreviewOptions {
  colorBy: 'feature' | 'tool'
  hidden: Set<number>
  toolColors: string[]
  minLayer: number
  maxLayer: number
}

export class SceneView {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(40, 1, 1, 5000)
  readonly controls: OrbitControls
  private bedGroup = new Group()
  private modelGroup = new Group()
  private previewGroup = new Group()
  private meshes = new Map<string, { mesh: Mesh; obj: ModelObject | null; positions: Float32Array }>()
  private selectionBox: LineSegments | null = null
  private boundsCache = new WeakMap<ModelObject, ReturnType<typeof worldBounds>>()
  private raycaster = new Raycaster()
  private dirty = true
  private disposed = false
  private bed: BedInfo = { x: 256, y: 256, z: 250, exclude: [] }
  private previewMaterial: LineMaterial | null = null
  private observer: ResizeObserver

  private gizmo = new Gizmo()
  private tool: Tool = null
  private mode: 'prepare' | 'preview' = 'prepare'
  private selectedList: ModelObject[] = []
  private layOverlay: Mesh | null = null
  private layKey = ''

  onSelect: (id: string | null, additive: boolean) => void = () => {}
  onMove: (id: string, x: number, y: number, final: boolean) => void = () => {}
  /** A gizmo drag is starting: the listener should snapshot the selection. */
  onGizmoStart: () => void = () => {}
  /** Gizmo drag update, relative to the state at onGizmoStart. */
  onGizmo: (ev: GizmoEvent, final: boolean) => void = () => {}
  /** Lay-on-face click: rotate object `id` so the world normal `n` faces down. */
  onLay: (id: string, n: Vector3) => void = () => {}

  constructor(private container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    container.appendChild(this.renderer.domElement)
    this.scene.background = new Color(getComputedStyle(container).getPropertyValue('--viewport-bg').trim() || '#20232a')
    this.camera.up.set(0, 0, 1)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.addEventListener('change', () => { this.dirty = true; if (this.gizmo.group.visible) this.refreshGizmo() })

    this.scene.add(new HemisphereLight(0xffffff, 0x444455, 1.2))
    this.scene.add(new AmbientLight(0xffffff, 0.3))
    const sun = new DirectionalLight(0xffffff, 1.6)
    sun.position.set(-150, -250, 400)
    this.scene.add(sun)
    this.scene.add(this.bedGroup, this.modelGroup, this.previewGroup, this.gizmo.group)

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(container)
    this.resize()
    this.setBed(this.bed)
    this.resetCamera()
    this.installPointer()
    const loop = () => {
      if (this.disposed) return
      requestAnimationFrame(loop)
      this.controls.update()
      if (this.dirty) { this.dirty = false; this.renderer.render(this.scene, this.camera) }
    }
    loop()
  }

  dispose() {
    this.disposed = true
    this.observer.disconnect()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.previewMaterial?.resolution.set(w, h)
    this.dirty = true
  }

  resetCamera(view: 'iso' | 'top' | 'front' = 'iso') {
    const { x, y } = this.bed
    const c = new Vector3(x / 2, y / 2, 0)
    const d = Math.max(x, y)
    if (view === 'top') this.camera.position.set(c.x, c.y - 0.001, d * 1.9)
    else if (view === 'front') this.camera.position.set(c.x, c.y - d * 1.8, d * 0.35)
    else this.camera.position.set(c.x - d * 0.3, c.y - d * 1.35, d * 1.1)
    this.controls.target.copy(c)
    this.controls.update()
    this.dirty = true
  }

  setBed(bed: BedInfo) {
    this.bed = bed
    this.bedGroup.clear()
    const plate = new Mesh(new PlaneGeometry(bed.x, bed.y), new MeshStandardMaterial({ color: 0x3a3d45, roughness: 0.9 }))
    plate.position.set(bed.x / 2, bed.y / 2, -0.05)
    plate.name = 'bed'
    this.bedGroup.add(plate)
    const grid: number[] = []
    for (let i = 0; i <= bed.x; i += 10) grid.push(i, 0, 0, i, bed.y, 0)
    for (let j = 0; j <= bed.y; j += 10) grid.push(0, j, 0, bed.x, j, 0)
    const gridGeom = new BufferGeometry()
    gridGeom.setAttribute('position', new Float32BufferAttribute(grid, 3))
    this.bedGroup.add(new LineSegments(gridGeom, new LineBasicMaterial({ color: 0x555a66 })))
    if (bed.exclude.length >= 3) {
      const s = new Shape(bed.exclude.map(([px, py]) => new Vector2(px, py)))
      const ex = new Mesh(new ShapeGeometry(s), new MeshBasicMaterial({ color: 0x884444, transparent: true, opacity: 0.6, side: DoubleSide }))
      ex.position.z = 0.01
      this.bedGroup.add(ex)
    }
    const vol = new LineSegments(new EdgesGeometry(new BoxGeometry(bed.x, bed.y, bed.z)), new LineBasicMaterial({ color: 0x4a5060, transparent: true, opacity: 0.6 }))
    vol.position.set(bed.x / 2, bed.y / 2, bed.z / 2)
    this.bedGroup.add(vol)
    // Origin axes
    const axes = new BufferGeometry()
    axes.setAttribute('position', new Float32BufferAttribute([0, 0, 0.1, 25, 0, 0.1, 0, 0, 0.1, 0, 25, 0.1], 3))
    axes.setAttribute('color', new Float32BufferAttribute([1, 0.2, 0.2, 1, 0.2, 0.2, 0.2, 1, 0.2, 0.2, 1, 0.2], 3))
    this.bedGroup.add(new LineSegments(axes, new LineBasicMaterial({ vertexColors: true })))
    this.dirty = true
  }

  setMode(mode: 'prepare' | 'preview') {
    this.modelGroup.visible = mode === 'prepare'
    this.previewGroup.visible = mode === 'preview'
    this.mode = mode
    this.refreshGizmo()
    this.clearLay()
    this.dirty = true
  }

  setObjects(list: ModelObject[], selected: string[], colors: string[], ghost = false) {
    const keep = new Set(list.map((o) => o.id))
    for (const [id, entry] of this.meshes) {
      if (!keep.has(id)) {
        this.modelGroup.remove(entry.mesh)
        entry.mesh.geometry.dispose()
        this.meshes.delete(id)
      }
    }
    for (const o of list) {
      let entry = this.meshes.get(o.id)
      if (!entry || entry.positions !== o.positions) {
        if (entry) { this.modelGroup.remove(entry.mesh); entry.mesh.geometry.dispose() }
        const g = new BufferGeometry()
        g.setAttribute('position', new BufferAttribute(o.positions, 3))
        g.computeVertexNormals()
        const mesh = new Mesh(g, new MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }))
        mesh.matrixAutoUpdate = false
        mesh.userData.id = o.id
        this.modelGroup.add(mesh)
        entry = { mesh, obj: null, positions: o.positions }
        this.meshes.set(o.id, entry)
      }
      // Objects are immutable, so a new reference means a new transform
      // (this also covers undo/redo restoring an older object).
      if (entry.obj !== o) {
        entry.mesh.matrix.copy(objectMatrix(o))
        entry.mesh.matrixWorldNeedsUpdate = true
        entry.obj = o
      }
      const mat = entry.mesh.material as MeshStandardMaterial
      mat.color.set(colors[o.filament] ?? '#cccccc')
      const isSel = selected.includes(o.id)
      mat.emissive.set(isSel ? 0x2266aa : 0x000000)
      mat.emissiveIntensity = isSel ? 0.45 : 0
      mat.transparent = ghost
      mat.opacity = ghost ? 0.25 : 1
      // Out-of-bed check: tint red.
      const m = entry.mesh.matrix.elements
      if (m[12] < 0 || m[13] < 0 || m[12] > this.bed.x || m[13] > this.bed.y) mat.emissive.set(0x991111), mat.emissiveIntensity = 0.6
    }
    this.selectedList = list.filter((o) => selected.includes(o.id))
    this.clearLay()
    this.updateSelectionBox(this.selectedList)
    this.refreshGizmo()
    this.dirty = true
  }

  /** Corner brackets around each selected object's bounding box, like Orca. */
  private updateSelectionBox(list: ModelObject[]) {
    if (this.selectionBox) {
      this.modelGroup.remove(this.selectionBox)
      this.selectionBox.geometry.dispose()
      this.selectionBox = null
    }
    if (!list.length) return
    const v: number[] = []
    for (const o of list) {
      let b = this.boundsCache.get(o)
      if (!b) { b = worldBounds(o); this.boundsCache.set(o, b) }
      const pad = 0.5
      const lo = [b.min[0] - pad, b.min[1] - pad, b.min[2]]
      const hi = [b.max[0] + pad, b.max[1] + pad, b.max[2] + pad]
      const len = [0, 1, 2].map((a) => Math.min(15, (hi[a] - lo[a]) * 0.25))
      for (let c = 0; c < 8; c++) {
        const p = [0, 1, 2].map((a) => ((c >> a) & 1 ? hi[a] : lo[a]))
        for (let a = 0; a < 3; a++) {
          const q = [...p]
          q[a] += ((c >> a) & 1 ? -1 : 1) * len[a]
          v.push(...p, ...q)
        }
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(v, 3))
    const accent = getComputedStyle(this.container).getPropertyValue('--accent').trim() || '#1fb3a3'
    this.selectionBox = new LineSegments(g, new LineBasicMaterial({ color: new Color(accent), depthTest: false, transparent: true }))
    this.selectionBox.renderOrder = 10
    this.modelGroup.add(this.selectionBox)
  }

  setPreview(p: GcodePreview | null, opts: PreviewOptions) {
    for (const c of this.previewGroup.children) {
      ;(c as any).geometry?.dispose()
    }
    this.previewGroup.clear()
    this.previewMaterial = null
    if (!p || p.segmentCount === 0) { this.dirty = true; return }
    const lo = Math.max(0, Math.min(opts.minLayer, p.layerCount - 1))
    const hi = Math.max(lo, Math.min(opts.maxLayer, p.layerCount - 1))
    const start = p.layerStart[lo]
    const end = hi + 1 < p.layerCount ? p.layerStart[hi + 1] : p.segmentCount
    const topStart = p.layerStart[hi]

    const featureColors = FEATURES.map(([, c]) => new Color(c))
    const toolColors = opts.toolColors.map((c) => new Color(c))
    let count = 0
    for (let i = start; i < end; i++) if (!opts.hidden.has(p.feature[i])) count++
    const pos = new Float32Array(count * 6)
    const col = new Float32Array(count * 6)
    let k = 0
    for (let i = start; i < end; i++) {
      if (opts.hidden.has(p.feature[i])) continue
      pos.set(p.segments.subarray(i * 6, i * 6 + 6), k * 6)
      const c = opts.colorBy === 'tool' ? (toolColors[p.tool[i]] ?? featureColors[0]) : featureColors[p.feature[i]]
      // Layers below the top one are slightly darker, which helps depth.
      const f = i >= topStart ? 1 : 0.78
      col[k * 6] = col[k * 6 + 3] = c.r * f
      col[k * 6 + 1] = col[k * 6 + 4] = c.g * f
      col[k * 6 + 2] = col[k * 6 + 5] = c.b * f
      k++
    }
    if (count > 3_000_000) {
      // Too many for fat lines; fall back to 1px lines.
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(pos, 3))
      g.setAttribute('color', new BufferAttribute(col, 3))
      this.previewGroup.add(new LineSegments(g, new LineBasicMaterial({ vertexColors: true })))
    } else {
      const g = new LineSegmentsGeometry()
      g.setPositions(pos)
      g.setColors(col)
      const mat = new LineMaterial({ vertexColors: true, worldUnits: true, linewidth: 0.42 })
      mat.resolution.set(this.container.clientWidth, this.container.clientHeight)
      this.previewMaterial = mat
      this.previewGroup.add(new LineSegments2(g, mat))
    }
    this.dirty = true
  }

  private pick(ev: PointerEvent): { id: string | null; point: Vector3 | null } {
    const r = this.renderer.domElement.getBoundingClientRect()
    const ndc = new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const hits = this.raycaster.intersectObjects(this.modelGroup.visible ? [...this.meshes.values()].map((e) => e.mesh) : [], false)
    const bedPoint = new Vector3()
    const hitBed = this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), bedPoint)
    return { id: hits[0]?.object.userData.id ?? null, point: hitBed ? bedPoint : null }
  }

  setTool(tool: Tool) {
    this.tool = tool
    this.renderer.domElement.style.cursor = tool === 'lay' ? 'crosshair' : ''
    this.clearLay()
    this.refreshGizmo()
  }

  /** Approximate size of one screen pixel in mm at a world point. */
  private pixelSize(at: Vector3) {
    const h = this.renderer.domElement.clientHeight || 600
    return (this.camera.position.distanceTo(at) * 2 * Math.tan((this.camera.fov * Math.PI) / 360)) / h
  }

  private refreshGizmo() {
    const t = this.tool
    const list = this.selectedList
    if (this.mode !== 'prepare' || !list.length || (t !== 'move' && t !== 'rotate' && t !== 'scale')) {
      this.gizmo.update(null, null, 1)
      this.dirty = true
      return
    }
    let center: Vector3, quat = new Quaternion(), half: Vector3
    if (t === 'scale' && list.length === 1) {
      // The object's own frame, so per-axis handles match its scale vector.
      const o = list[0]
      const lb = localBounds(o)
      center = new Vector3((lb.min[0] + lb.max[0]) / 2, (lb.min[1] + lb.max[1]) / 2, (lb.min[2] + lb.max[2]) / 2).applyMatrix4(objectMatrix(o))
      quat = new Quaternion(...o.rot)
      half = new Vector3(...[0, 1, 2].map((a) => ((lb.max[a] - lb.min[a]) / 2) * o.scale[a]) as [number, number, number])
    } else {
      const g = groupBounds(list)
      center = new Vector3(...(g.center as [number, number, number]))
      half = new Vector3((g.max[0] - g.min[0]) / 2, (g.max[1] - g.min[1]) / 2, (g.max[2] - g.min[2]) / 2)
    }
    this.gizmo.uniformOnly = list.length > 1
    this.gizmo.update(t, { center, quat, half }, this.pixelSize(center))
    this.dirty = true
  }

  private setRay(ev: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect()
    const ndc = new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
  }

  /** Parameter along the line (origin + s·dir) of the point closest to the current ray. */
  private lineParam(origin: Vector3, dir: Vector3) {
    const ray = this.raycaster.ray
    const w0 = origin.clone().sub(ray.origin)
    const b = dir.dot(ray.direction), d = dir.dot(w0), e = ray.direction.dot(w0)
    const denom = 1 - b * b
    if (Math.abs(denom) < 1e-6) return null
    return (b * e - d) / denom
  }

  private planeHit(normal: Vector3, point: Vector3) {
    const out = new Vector3()
    return this.raycaster.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(normal, point), out) ? out : null
  }

  private clearLay() {
    if (this.layOverlay) {
      this.scene.remove(this.layOverlay)
      this.layOverlay.geometry.dispose()
      this.layOverlay = null
      this.layKey = ''
      this.dirty = true
    }
  }

  /** World-space normal of the hovered triangle, and highlight of every coplanar triangle of that object. */
  private layHover(ev: PointerEvent): { id: string; n: Vector3 } | null {
    this.setRay(ev)
    const hit = this.raycaster.intersectObjects([...this.meshes.values()].map((e) => e.mesh), false)[0]
    if (!hit || !hit.face) { this.clearLay(); return null }
    const mesh = hit.object as Mesh
    const m = mesh.matrix
    const pos = mesh.geometry.getAttribute('position')
    const v = (i: number) => new Vector3().fromBufferAttribute(pos, i).applyMatrix4(m)
    const a = v(hit.face.a), b = v(hit.face.b), c = v(hit.face.c)
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
    const d = n.dot(a)
    const key = `${mesh.userData.id}:${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)},${d.toFixed(2)}`
    if (key !== this.layKey) {
      this.clearLay()
      this.layKey = key
      const out: number[] = []
      const p = new Vector3(), q = new Vector3(), r = new Vector3(), e1 = new Vector3(), e2 = new Vector3()
      for (let i = 0; i + 2 < pos.count; i += 3) {
        p.fromBufferAttribute(pos, i).applyMatrix4(m)
        q.fromBufferAttribute(pos, i + 1).applyMatrix4(m)
        r.fromBufferAttribute(pos, i + 2).applyMatrix4(m)
        e1.subVectors(q, p); e2.subVectors(r, p)
        const tn = e1.cross(e2)
        const len = tn.length()
        if (len < 1e-9 || tn.dot(n) / len < 0.9995) continue
        if (Math.abs(n.dot(p) - d) > 0.05 || Math.abs(n.dot(q) - d) > 0.05 || Math.abs(n.dot(r) - d) > 0.05) continue
        // Nudge outward so the overlay doesn't z-fight with the face.
        for (const w of [p, q, r]) out.push(w.x + n.x * 0.05, w.y + n.y * 0.05, w.z + n.z * 0.05)
      }
      const g = new BufferGeometry()
      g.setAttribute('position', new Float32BufferAttribute(out, 3))
      this.layOverlay = new Mesh(g, new MeshBasicMaterial({ color: 0xffc107, transparent: true, opacity: 0.7, side: DoubleSide }))
      this.layOverlay.renderOrder = 5
      this.scene.add(this.layOverlay)
      this.dirty = true
    }
    return { id: mesh.userData.id, n }
  }

  private installPointer() {
    const el = this.renderer.domElement
    let drag: { id: string; offX: number; offY: number; moved: boolean; startX: number; startY: number; last?: Vector3 } | null = null
    let down: { x: number; y: number } | null = null
    let gdrag: { handle: HandleId; center: Vector3; axis: Vector3; s0: number; v0: Vector3 | null; last: GizmoEvent | null } | null = null

    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      down = { x: ev.clientX, y: ev.clientY }
      if (!this.modelGroup.visible) return
      this.setRay(ev)
      const handle = this.gizmo.pick(this.raycaster)
      if (handle && this.gizmo.frame) {
        const center = this.gizmo.frame.center.clone()
        const a = handle === 'su' ? 0 : Number(handle[1])
        const axis = handle === 'su' ? new Vector3() : this.gizmo.axis(a)
        let s0 = 0, v0: Vector3 | null = null
        if (handle[0] === 'm' || handle[0] === 's') {
          if (handle === 'su') {
            const camDir = this.camera.getWorldDirection(new Vector3())
            const p = this.planeHit(camDir, center)
            if (!p) return
            s0 = p.distanceTo(center)
          } else {
            s0 = this.lineParam(center, axis) ?? 0
          }
        } else {
          const p = this.planeHit(axis, center)
          if (!p) return
          v0 = p.sub(center)
        }
        if (handle[0] === 's' && Math.abs(s0) < 1e-3) return
        gdrag = { handle, center, axis, s0, v0, last: null }
        if (handle[0] === 'r') {
          this.gizmo.activeRing = { axis: Number(handle[1]) as 0 | 1 | 2, radius: this.gizmo.ringRadius }
          this.refreshGizmo()
        }
        this.controls.enabled = false
        el.setPointerCapture(ev.pointerId)
        this.onGizmoStart()
        return
      }
      if (this.tool === 'lay') {
        const h = this.layHover(ev)
        if (h) { this.onLay(h.id, h.n); this.clearLay() }
        return
      }
      const { id, point } = this.pick(ev)
      if (id && point) {
        const mesh = this.meshes.get(id)?.mesh
        if (!mesh) return
        const m = mesh.matrix.elements
        drag = { id, offX: m[12] - point.x, offY: m[13] - point.y, moved: false, startX: ev.clientX, startY: ev.clientY }
        this.controls.enabled = false
        el.setPointerCapture(ev.pointerId)
        this.onSelect(id, ev.shiftKey || ev.ctrlKey || ev.metaKey)
      }
    })

    el.addEventListener('pointermove', (ev) => {
      if (gdrag) {
        this.setRay(ev)
        const g = gdrag
        let e: GizmoEvent | null = null
        if (g.handle[0] === 'm') {
          const s = this.lineParam(g.center, g.axis)
          if (s != null) { const d = s - g.s0; e = { kind: 'move', dx: g.axis.x * d, dy: g.axis.y * d } }
        } else if (g.handle[0] === 'r') {
          const p = this.planeHit(g.axis, g.center)
          if (p && g.v0) {
            const v = p.sub(g.center)
            let deg = (Math.atan2(g.axis.dot(g.v0.clone().cross(v)), g.v0.dot(v)) * 180) / Math.PI
            // Orca-style snap zones: on the ring rotates freely, dragging out
            // past it locks to 5° steps, further out to 15° (Shift: always 15°).
            const R = this.gizmo.activeRing?.radius ?? this.gizmo.ringRadius
            const d = v.length() / R
            const snap: 0 | 5 | 15 = ev.shiftKey || d > SNAP_FINE_OUT ? 15 : d > SNAP_FREE_OUT ? 5 : 0
            if (snap) deg = Math.round(deg / snap) * snap
            if (Object.is(deg, -0)) deg = 0
            e = { kind: 'rotate', q: new Quaternion().setFromAxisAngle(g.axis, (deg * Math.PI) / 180), center: g.center.toArray(), degrees: deg, snap, clientX: ev.clientX, clientY: ev.clientY }
          }
        } else if (g.handle === 'su') {
          const p = this.planeHit(this.camera.getWorldDirection(new Vector3()), g.center)
          if (p) { const k = Math.max(0.01, p.distanceTo(g.center) / g.s0); e = { kind: 'scale', k: [k, k, k], center: g.center.toArray() } }
        } else {
          const s = this.lineParam(g.center, g.axis)
          if (s != null) {
            const k = Math.max(0.01, s / g.s0)
            const kk: [number, number, number] = [1, 1, 1]
            kk[Number(g.handle[1])] = k
            e = { kind: 'scale', k: kk, center: g.center.toArray() }
          }
        }
        if (e) { g.last = e; this.onGizmo(e, false) }
        return
      }
      if (drag) {
        if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 3) return
        drag.moved = true
        const { point } = this.pick(ev)
        if (point) { drag.last = point; this.onMove(drag.id, point.x + drag.offX, point.y + drag.offY, false) }
        return
      }
      if (ev.buttons) return
      // Hover feedback.
      if (this.gizmo.group.visible) {
        this.setRay(ev)
        const h = this.gizmo.pick(this.raycaster)
        this.gizmo.setHover(h)
        el.style.cursor = h ? 'pointer' : this.tool === 'lay' ? 'crosshair' : ''
        this.dirty = true
      }
      if (this.tool === 'lay' && this.modelGroup.visible) this.layHover(ev)
    })

    el.addEventListener('pointerup', (ev) => {
      if (gdrag) {
        if (gdrag.last) this.onGizmo(gdrag.last, true)
        gdrag = null
        if (this.gizmo.activeRing) { this.gizmo.activeRing = null; this.refreshGizmo() }
        this.controls.enabled = true
        return
      }
      if (drag) {
        if (drag.moved) {
          const point = this.pick(ev).point ?? drag.last
          if (point) this.onMove(drag.id, point.x + drag.offX, point.y + drag.offY, true)
        }
        drag = null
        this.controls.enabled = true
        return
      }
      // Click on empty space clears the selection (but not after an orbit drag).
      if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 4 && this.modelGroup.visible && this.tool !== 'lay') {
        const { id } = this.pick(ev)
        if (!id) this.onSelect(null, false)
      }
      down = null
    })
    el.addEventListener('pointerleave', () => { if (this.tool === 'lay') this.clearLay() })
  }

  /** Renders the given objects from an iso angle into a PNG (for 3MF plate thumbnails). */
  async thumbnail(list: ModelObject[], colors: string[], size = 512): Promise<Blob> {
    const scene = new Scene()
    scene.add(new HemisphereLight(0xffffff, 0x444455, 1.3))
    const sun = new DirectionalLight(0xffffff, 1.5)
    sun.position.set(-150, -250, 400)
    scene.add(sun)
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)
    const tmp: Object3D[] = []
    for (const o of list) {
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(o.positions, 3))
      g.computeVertexNormals()
      const mesh = new Mesh(g, new MeshStandardMaterial({ color: colors[o.filament] ?? '#cccccc', roughness: 0.55 }))
      mesh.matrixAutoUpdate = false
      mesh.matrix.copy(objectMatrix(o))
      mesh.updateMatrixWorld(true)
      g.computeBoundingBox()
      const bb = g.boundingBox!.clone().applyMatrix4(mesh.matrix)
      min.min(bb.min); max.max(bb.max)
      scene.add(mesh)
      tmp.push(mesh)
    }
    const center = min.clone().add(max).multiplyScalar(0.5)
    const radius = Math.max(10, max.clone().sub(min).length() / 2)
    const cam = new PerspectiveCamera(30, 1, 0.1, 10000)
    cam.up.set(0, 0, 1)
    const dir = new Vector3(-0.45, -1, 0.8).normalize()
    cam.position.copy(center).addScaledVector(dir, radius / Math.sin((15 * Math.PI) / 180))
    cam.lookAt(center)
    const r = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    r.setSize(size, size)
    r.setClearColor(0x000000, 0)
    r.render(scene, cam)
    const blob = await new Promise<Blob>((res, rej) => r.domElement.toBlob((b) => (b ? res(b) : rej(new Error('thumbnail failed'))), 'image/png'))
    for (const m of tmp) (m as Mesh).geometry.dispose()
    r.dispose()
    return blob
  }

  invalidate() { this.dirty = true }
}
