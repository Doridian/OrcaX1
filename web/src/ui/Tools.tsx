// Orca-style object manipulation tools: the vertical tool strip on the left of
// the viewport and the value-entry panel for the active tool.
import { useState } from 'preact/hooks'
import { Euler, Quaternion, Vector3 } from 'three'
import {
  activeTool, groupBounds, localSize, patchObjects, rotated, scaled, selectedObjects, translated, updateObject,
  type ModelObject, type Tool,
} from '../state/project'

const ICONS: Record<Exclude<Tool, null>, preact.JSX.Element> = {
  move: (
    <svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3" /></svg>
  ),
  rotate: (
    <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg>
  ),
  scale: (
    <svg viewBox="0 0 24 24"><path d="M3 9V3h6M21 15v6h-6M3 3l7 7M21 21l-7-7M14 3h7v7M10 21H3v-7" /></svg>
  ),
  lay: (
    <svg viewBox="0 0 24 24"><path d="M4 18h16M7 14h10l-2-6H9zM12 2v4M10 4l2 2 2-2" /></svg>
  ),
}

const TOOLS: { id: Exclude<Tool, null>; label: string; key: string }[] = [
  { id: 'move', label: 'Move', key: 'M' },
  { id: 'rotate', label: 'Rotate', key: 'R' },
  { id: 'scale', label: 'Scale', key: 'S' },
  { id: 'lay', label: 'Lay on face', key: 'F' },
]

export const toolForKey: Record<string, Exclude<Tool, null>> = { m: 'move', r: 'rotate', s: 'scale', f: 'lay' }

export function ToolStrip() {
  return (
    <div class="toolstrip">
      {TOOLS.map((t) => (
        <button class={activeTool.value === t.id ? 'active' : ''} title={`${t.label} (${t.key})`}
          onClick={() => { activeTool.value = activeTool.value === t.id ? null : t.id }}>
          {ICONS[t.id]}
        </button>
      ))}
    </div>
  )
}

const r2 = (v: number, d = 2) => Number(v.toFixed(d))
const RAD = Math.PI / 180

function NumField({ value, onCommit, step = 1, unit }: { value: number; onCommit: (v: number) => void; step?: number; unit?: string }) {
  return (
    <span class="numfield">
      <input type="number" step={step} value={r2(value)}
        onChange={(e) => { const v = parseFloat(e.currentTarget.value); if (Number.isFinite(v)) onCommit(v) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur() }} />
      {unit && <span class="unit">{unit}</span>}
    </span>
  )
}

const AXES = ['X', 'Y', 'Z'] as const

export function ToolPanel() {
  const tool = activeTool.value
  if (!tool) return null
  const list = selectedObjects.value
  const label = TOOLS.find((t) => t.id === tool)!.label
  return (
    <div class="float-panel tool-panel">
      <div class="tool-title">{label}</div>
      {!list.length
        ? <div class="muted small-text">Select an object first.</div>
        : tool === 'move' ? <MovePanel list={list} />
          : tool === 'rotate' ? <RotatePanel list={list} />
            : tool === 'scale' ? <ScalePanel list={list} />
              : <div class="muted small-text">Hover over a flat face of the selected model and click it to place that face on the bed.</div>}
    </div>
  )
}

function MovePanel({ list }: { list: ModelObject[] }) {
  const single = list.length === 1 ? list[0] : null
  const g = groupBounds(list)
  const pos = single ? [single.x, single.y] : [g.center[0], g.center[1]]
  const [by, setBy] = useState([0, 0])
  const moveTo = (a: 0 | 1, v: number) => patchObjects(translated(list, a === 0 ? v - pos[0] : 0, a === 1 ? v - pos[1] : 0))
  return (
    <>
      <div class="grid3">
        <span class="muted small-text">{single ? 'Position' : 'Center'}</span>
        {[0, 1].map((a) => <label><b class={`ax${a}`}>{AXES[a]}</b><NumField value={pos[a]} unit="mm" onCommit={(v) => moveTo(a as 0 | 1, v)} /></label>)}
        <label><b class="ax2">Z</b><span class="numfield"><input type="number" value={r2(g.min[2])} disabled /><span class="unit">mm</span></span></label>
      </div>
      <div class="grid3">
        <span class="muted small-text">Move by</span>
        {[0, 1].map((a) => <label><b class={`ax${a}`}>{AXES[a]}</b><NumField value={by[a]} unit="mm" onCommit={(v) => setBy(a === 0 ? [v, by[1]] : [by[0], v])} /></label>)}
        <button class="small" onClick={() => patchObjects(translated(list, by[0], by[1]))}>Apply</button>
      </div>
    </>
  )
}

function RotatePanel({ list }: { list: ModelObject[] }) {
  const single = list.length === 1 ? list[0] : null
  const center = groupBounds(list).center
  const [by, setBy] = useState([0, 0, 90])
  const euler = single ? new Euler().setFromQuaternion(new Quaternion(...single.rot), 'XYZ') : null
  const rotateBy = (deg: number[]) => {
    // Applied X, then Y, then Z about world axes, around the selection center.
    const q = new Quaternion()
    for (const a of [0, 1, 2]) {
      if (!deg[a]) continue
      const axis = new Vector3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0)
      q.premultiply(new Quaternion().setFromAxisAngle(axis, deg[a] * RAD))
    }
    patchObjects(rotated(list, q, center))
  }
  return (
    <>
      {single && euler && (
        <div class="grid3">
          <span class="muted small-text">Rotation</span>
          {[0, 1, 2].map((a) => (
            <label><b class={`ax${a}`}>{AXES[a]}</b>
              <NumField value={[euler.x, euler.y, euler.z][a] / RAD} unit="°" onCommit={(v) => {
                const e = [euler.x, euler.y, euler.z]
                e[a] = v * RAD
                const q = new Quaternion().setFromEuler(new Euler(e[0], e[1], e[2], 'XYZ'))
                updateObject(single.id, { rot: [q.x, q.y, q.z, q.w] })
              }} />
            </label>
          ))}
        </div>
      )}
      <div class="grid3">
        <span class="muted small-text">Rotate by</span>
        {[0, 1, 2].map((a) => (
          <label><b class={`ax${a}`}>{AXES[a]}</b><NumField value={by[a]} unit="°" onCommit={(v) => { const n = [...by]; n[a] = v; setBy(n) }} /></label>
        ))}
      </div>
      <div class="actions">
        <button class="small" onClick={() => rotateBy(by)}>Apply</button>
        <button class="small" onClick={() => rotateBy(by.map((v) => -v))}>Apply reversed</button>
        <button class="small" onClick={() => patchObjects(new Map(list.map((o) => [o.id, { rot: [0, 0, 0, 1] as ModelObject['rot'] }])))}>Reset rotation</button>
      </div>
      <div class="muted small-text">Drag a ring to rotate freely; drag outward past the ring to lock to 5° steps, further out for 15° (or hold Shift).</div>
    </>
  )
}

function ScalePanel({ list }: { list: ModelObject[] }) {
  const single = list.length === 1 ? list[0] : null
  const [uniform, setUniform] = useState(true)
  const center = groupBounds(list).center
  if (!single) {
    return (
      <>
        <div class="grid3">
          <span class="muted small-text">Scale</span>
          <label><b>All</b><NumField value={100} unit="%" onCommit={(v) => { if (v > 0) { const k = v / 100; patchObjects(scaled(list, [k, k, k], center)) } }} /></label>
        </div>
        <div class="muted small-text">Multiple objects scale uniformly about their common center.</div>
        <div class="actions"><button class="small" onClick={() => patchObjects(new Map(list.map((o) => [o.id, { scale: [1, 1, 1] as ModelObject['scale'] }])))}>Reset scale</button></div>
      </>
    )
  }
  const size = localSize(single)
  const apply = (a: number, k: number) => {
    if (!(k > 0) || !Number.isFinite(k)) return
    const kk: [number, number, number] = uniform ? [k, k, k] : [1, 1, 1]
    kk[a] = k
    patchObjects(scaled([single], kk, center))
  }
  return (
    <>
      <div class="grid3">
        <span class="muted small-text">Scale</span>
        {[0, 1, 2].map((a) => <label><b class={`ax${a}`}>{AXES[a]}</b><NumField value={single.scale[a] * 100} unit="%" onCommit={(v) => apply(a, v / 100 / single.scale[a])} /></label>)}
      </div>
      <div class="grid3">
        <span class="muted small-text">Size</span>
        {[0, 1, 2].map((a) => <label><b class={`ax${a}`}>{AXES[a]}</b><NumField value={size[a]} unit="mm" onCommit={(v) => apply(a, v / size[a])} /></label>)}
      </div>
      <label class="check"><input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.currentTarget.checked)} /> Uniform scale</label>
      <div class="actions"><button class="small" onClick={() => updateObject(single.id, { scale: [1, 1, 1] })}>Reset scale</button></div>
      <div class="muted small-text">Grey corner handles scale uniformly, colored handles scale one axis.</div>
    </>
  )
}
