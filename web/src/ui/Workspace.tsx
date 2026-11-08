import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { FEATURES } from '../gcode/parse'
import { importFile } from '../model/mesh'
import { getEngine } from '../slicer/engine'
import {
  addMeshes, clearProject, currentPlate, duplicateObjects, objects, plateCount, plateObjects, removeObjects,
  selectedObjects, selection, touch, worldBounds, undo, redo, canUndo, canRedo, beginGesture, endGesture,
  activeTool, patchObjects, translated, rotated, scaled, layOnFace, type ModelObject,
} from '../state/project'
import { bed, sel } from '../state/settings'
import { trayShort } from '../state/hardware'
import { ask } from '../state/confirm'
import {
  arrange, autoOrient, cancelSlice, isStale, plates, sliceAll, sliceError, sliceProgress, sliceStatus,
} from '../state/slice'
import { SceneView, type GizmoEvent } from '../view3d/scene'
import { activeVolume, patchVolume, removeVolume, scaledVolume, selectVolume, selectedVolume, transformedVolume } from '../state/volumes'
import { Matrix4 } from 'three'
import { page } from './App'
import { ToolPanel, ToolStrip, toolForKey } from './Tools'
import { PrintDialog } from './PrintDialog'
import { AddVolume, VolumePanel, VolumeRows } from './ObjectVolumes'

/** Live angle shown next to the cursor while dragging a rotation ring. */
const rotateReadout = signal<Extract<GizmoEvent, { kind: 'rotate' }> | null>(null)

export let sceneView: SceneView | null = null

export function Workspace({ mode }: { mode: 'prepare' | 'preview' }) {
  const host = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [printOpen, setPrintOpen] = useState(false)
  const [colorBy, setColorBy] = useState<'feature' | 'tool'>('feature')
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [layers, setLayers] = useState<[number, number]>([0, 1e9])

  useEffect(() => {
    const v = new SceneView(host.current!)
    sceneView = v
    if (import.meta.env.DEV) (window as any).__sceneView = v
    v.onSelect = (id, additive) => {
      selectedVolume.value = null
      if (!id) { selection.value = []; return }
      selection.value = additive
        ? (selection.value.includes(id) ? selection.value.filter((x) => x !== id) : [...selection.value, id])
        : (selection.value.includes(id) ? selection.value : [id])
    }
    v.onMove = (id, x, y, final) => {
      const o = objects.value.find((p) => p.id === id)
      if (!o) return
      if (final) endGesture()
      else beginGesture()
      const dx = x - o.x, dy = y - o.y
      // Move the whole selection together.
      const ids = selection.value.includes(id) ? selection.value : [id]
      objects.value = objects.value.map((p) => (ids.includes(p.id) ? { ...p, x: p.x + dx, y: p.y + dy, rev: p.rev + 1 } : p))
      if (final) touch()
    }
    v.onSelectVolume = (obj, vol) => selectVolume(obj, vol)
    let gizmoBase: ModelObject[] = []
    let volumeBase: NonNullable<typeof activeVolume.value> | null = null
    v.onGizmoStart = () => { gizmoBase = selectedObjects.value; volumeBase = activeVolume.value; beginGesture() }
    v.onGizmo = (e, final) => {
      if (volumeBase) {
        // The gizmo is on a volume: move/rotate in world space, scale along its own axes.
        const { o, v: vol } = volumeBase
        const patch = e.kind === 'move' ? transformedVolume(o, vol, new Matrix4().makeTranslation(e.dx, e.dy, e.dz))
          : e.kind === 'rotate' ? transformedVolume(o, vol, new Matrix4().makeTranslation(e.center[0], e.center[1], e.center[2])
            .multiply(new Matrix4().makeRotationFromQuaternion(e.q))
            .multiply(new Matrix4().makeTranslation(-e.center[0], -e.center[1], -e.center[2])))
            : scaledVolume(vol, e.k)
        if (final) endGesture()
        patchVolume(o.id, vol.id, patch, final)
        rotateReadout.value = e.kind === 'rotate' && !final ? e : null
        return
      }
      const patches = e.kind === 'move' ? translated(gizmoBase, e.dx, e.dy)
        : e.kind === 'rotate' ? rotated(gizmoBase, e.q, e.center)
          : scaled(gizmoBase, e.k, e.center)
      if (final) endGesture()
      patchObjects(patches, final)
      rotateReadout.value = e.kind === 'rotate' && !final ? e : null
    }
    v.onLay = (id, n) => {
      const o = objects.value.find((p) => p.id === id)
      if (!o) return
      if (!selection.value.includes(id)) selection.value = [id]
      layOnFace(o, n)
    }
    return () => { v.dispose(); sceneView = null }
  }, [])

  // Keep the scene in sync with state.
  const colors = sel.value.filaments.map((f) => f.color)
  const plateSlice = plates.value.find((p) => p.plateIndex === currentPlate.value) ?? null
  const preview = plateSlice?.preview ?? null
  useEffect(() => { sceneView?.setBed(bed.value) }, [bed.value])
  useEffect(() => { sceneView?.setMode(mode) }, [mode])
  useEffect(() => { sceneView?.setTool(activeTool.value) }, [activeTool.value])
  useEffect(() => {
    sceneView?.setObjects(plateObjects.value, selection.value, colors)
    sceneView?.setVolumes(plateObjects.value, selection.value, activeVolume.value ? selectedVolume.value : null)
  }, [plateObjects.value, selection.value, activeVolume.value, colors.join()])
  useEffect(() => {
    if (!preview) { sceneView?.setPreview(null, null as any); return }
    sceneView?.setPreview(preview, { colorBy, hidden, toolColors: colors, minLayer: layers[0], maxLayer: Math.min(layers[1], preview.layerCount - 1) })
  }, [preview, colorBy, hidden, layers, colors.join()])
  useEffect(() => { setLayers([0, 1e9]) }, [preview])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input, select, textarea')) return
      if (page.value === 'device') return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
      const av = activeVolume.value
      if ((e.key === 'Delete' || e.key === 'Backspace') && av) removeVolume(av.o.id, av.v.id)
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.value.length) removeObjects(selection.value)
      else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { selection.value = plateObjects.value.map((o) => o.id); e.preventDefault() }
      else if (e.key === 'Escape') { if (activeTool.value) activeTool.value = null; else if (av) selectedVolume.value = null; else selection.value = [] }
      else if (!mod && !e.altKey && toolForKey[e.key.toLowerCase()] && page.value === 'prepare') {
        const t = toolForKey[e.key.toLowerCase()]
        activeTool.value = activeTool.value === t ? null : t
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null)
    try { await fn() } catch (e: any) { setError(e?.message ?? String(e)) } finally { setBusy(null) }
  }

  const importFiles = (files: FileList | File[]) => run('Importing…', async () => {
    for (const f of Array.from(files)) {
      const meshes = await importFile(f, async (kind, bytes) => (await getEngine()).convert(kind, bytes))
      addMeshes(meshes, bed.value)
    }
  })

  const outOfBed = plateObjects.value.filter((o) => {
    const b = worldBounds(o)
    return b.min[0] < 0 || b.min[1] < 0 || b.max[0] > bed.value.x || b.max[1] > bed.value.y || b.max[2] > bed.value.z
  })

  const status = sliceStatus.value
  const slicing = status === 'slicing' || status === 'loading-engine'
  const stats = plateSlice?.statistics

  return (
    <div class="main">
      <div
        class="viewport"
        ref={host}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files) }}
      >
        {drag && <div class="dropzone">Drop STL / 3MF / OBJ / STEP</div>}
        {mode === 'prepare' && objects.value.length === 0 && (
          <div class="empty-hint">Drop STL, 3MF, OBJ or STEP files here<br />or use Import</div>
        )}
        {mode === 'preview' && !preview && (
          <div class="empty-hint">{slicing ? 'Slicing…' : 'Slice the plate to see the toolpath preview'}</div>
        )}

        <div class="toolbar">
          {mode === 'prepare' && (
            <>
              <div class="group">
                <button onClick={() => fileInput.current!.click()} title="Import models">Import</button>
                <button disabled={!selection.value.length} onClick={() => duplicateObjects(selection.value)} title="Duplicate">Duplicate</button>
                <button disabled={!selection.value.length} onClick={() => removeObjects(selection.value)} title="Delete (Del)">Delete</button>
                <button disabled={!objects.value.length} onClick={async () => { if (await ask({ title: 'Remove all objects?', confirm: 'Remove', danger: true })) clearProject() }}>Clear</button>
                <button disabled={!canUndo.value} onClick={undo} title="Undo (Ctrl+Z)">Undo</button>
                <button disabled={!canRedo.value} onClick={redo} title="Redo (Ctrl+Shift+Z / Ctrl+Y)">Redo</button>
              </div>
              <div class="group">
                <button disabled={!objects.value.length || !!busy || slicing} onClick={() => run('Arranging…', arrange)}>Arrange</button>
                <button disabled={!objects.value.length || !!busy || slicing} onClick={() => run('Orienting…', autoOrient)}>Auto-orient</button>
              </div>
            </>
          )}
          <div class="group">
            {Array.from({ length: plateCount.value }, (_, i) => (
              <button class={currentPlate.value === i ? 'active' : ''} onClick={() => { currentPlate.value = i; selection.value = [] }}>Plate {i + 1}</button>
            ))}
            {mode === 'prepare' && <button onClick={() => { plateCount.value++; currentPlate.value = plateCount.value - 1; touch() }} title="Add plate">+</button>}
            {mode === 'prepare' && plateCount.value > 1 && (
              <button title="Delete this plate (objects on it are removed)" onClick={() => {
                const p = currentPlate.value
                removeObjects(objects.value.filter((o) => o.plate === p).map((o) => o.id))
                objects.value = objects.value.map((o) => (o.plate > p ? { ...o, plate: o.plate - 1 } : o))
                plateCount.value--
                currentPlate.value = Math.max(0, p - 1)
                touch()
              }}>−</button>
            )}
          </div>
          <div class="spacer" />
          <div class="group">
            <button onClick={() => sceneView?.resetCamera('iso')}>Iso</button>
            <button onClick={() => sceneView?.resetCamera('top')}>Top</button>
            <button onClick={() => sceneView?.resetCamera('front')}>Front</button>
          </div>
          {busy && <div class="group"><span class="muted" style={{ padding: '4px 8px' }}>{busy}</span></div>}
        </div>

        {mode === 'prepare' && <ToolStrip />}
        {rotateReadout.value && host.current && (() => {
          const r = rotateReadout.value, box = host.current.getBoundingClientRect()
          return (
            <div class="gizmo-readout" style={{ left: `${r.clientX - box.left + 16}px`, top: `${r.clientY - box.top + 16}px` }}>
              {r.degrees.toFixed(r.snap ? 0 : 1)}°{r.snap ? <span class="muted"> · {r.snap}° steps</span> : null}
            </div>
          )
        })()}
        {mode === 'prepare' && <ToolPanel />}
        {mode === 'prepare' && plateObjects.value.length > 0 && <ObjectsPanel />}

        {mode === 'preview' && preview && preview.layerCount > 0 && (
          <>
            <div class="layer-slider">
              <div class="lbl">{Math.min(layers[1], preview.layerCount - 1) + 1}<br />{preview.layerZ[Math.min(layers[1], preview.layerCount - 1)]?.toFixed(2)}</div>
              <input type="range" min={0} max={preview.layerCount - 1} value={Math.min(layers[1], preview.layerCount - 1)}
                onInput={(e) => setLayers([Math.min(layers[0], +e.currentTarget.value), +e.currentTarget.value])} />
              <input type="range" min={0} max={preview.layerCount - 1} value={layers[0]} style={{ flex: '0 0 25%' }}
                onInput={(e) => setLayers([Math.min(+e.currentTarget.value, Math.min(layers[1], preview.layerCount - 1)), layers[1]])} />
              <div class="lbl">{layers[0] + 1}</div>
            </div>
            <div class="float-panel legend">
              <div class="row" style={{ marginTop: 0 }}>
                <select value={colorBy} onChange={(e) => setColorBy(e.currentTarget.value as any)}>
                  <option value="feature">Line type</option>
                  <option value="tool">Filament</option>
                </select>
              </div>
              {colorBy === 'feature'
                ? FEATURES.map(([name, color], i) => (
                  <label>
                    <input type="checkbox" checked={!hidden.has(i)} onChange={() => {
                      const h = new Set(hidden); if (h.has(i)) h.delete(i); else h.add(i); setHidden(h)
                    }} />
                    <span class="sw" style={{ background: color }} /> {name}
                  </label>
                ))
                : colors.map((c, i) => <label><span class="sw" style={{ background: c }} /> Filament {i + 1}</label>)}
            </div>
          </>
        )}

        <div class="float-panel slice-panel">
          {outOfBed.length > 0 && mode === 'prepare' && <div class="warning small-text">{outOfBed.length} object(s) outside the build volume</div>}
          {error && <div class="error small-text">{error}</div>}
          {sliceError.value && <div class="error small-text">Slicing failed: {sliceError.value}</div>}
          {slicing && (
            <>
              <div class="small-text muted">{status === 'loading-engine' ? 'Loading slicer engine (~29 MB)…' : sliceProgress.value?.stage ?? 'Slicing…'}</div>
              <div class="progress"><div style={{ width: `${sliceProgress.value?.percent ?? 0}%` }} /></div>
            </>
          )}
          {stats && !slicing && <Stats stats={stats} stale={isStale.value} warnings={plateSlice?.warnings ?? []} />}
          <div class="actions" style={{ marginTop: '8px' }}>
            {slicing
              ? <button onClick={cancelSlice}>Cancel</button>
              : <button class={isStale.value || !plates.value.length ? 'primary' : ''} disabled={!objects.value.length || !!busy}
                onClick={async () => { await sliceAll(); if (sliceStatus.value === 'done') page.value = 'preview' }}>
                Slice all
              </button>}
            <button class={!isStale.value && plates.value.length ? 'primary' : ''} disabled={!objects.value.length || slicing || !!busy}
              onClick={() => setPrintOpen(true)}>Print…</button>
          </div>
        </div>
      </div>
      <input ref={fileInput} type="file" multiple accept=".stl,.3mf,.obj,.step,.stp" style={{ display: 'none' }}
        onChange={(e) => { const f = e.currentTarget.files; if (f?.length) importFiles(f); e.currentTarget.value = '' }} />
      {printOpen && <PrintDialog onClose={() => setPrintOpen(false)} />}
    </div>
  )
}

export function fmtTime(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec)) return '–'
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`
}

function Stats({ stats, stale, warnings }: { stats: any; stale: boolean; warnings: { code: string; message: string }[] }) {
  const f = stats.filament ?? {}
  return (
    <>
      {stale && <div class="warning small-text">Settings or models changed since the last slice.</div>}
      <dl class="stats">
        <dt>Print time</dt><dd>{fmtTime(stats.timeSeconds?.normal)}</dd>
        <dt>Filament</dt><dd>{f.totalMassG != null ? `${f.totalMassG.toFixed(1)} g` : '–'} · {f.totalLengthMm != null ? `${(f.totalLengthMm / 1000).toFixed(2)} m` : ''}</dd>
        {f.totalCost > 0 && <><dt>Cost</dt><dd>{f.totalCost.toFixed(2)}</dd></>}
        {stats.toolChanges > 0 && <><dt>Filament changes</dt><dd>{stats.toolChanges}</dd></>}
      </dl>
      {warnings.filter((w) => w.code !== 'empty-plate').map((w) => <div class="warning small-text">{w.message}</div>)}
    </>
  )
}


function ObjectsPanel() {
  const list = plateObjects.value
  const selObjs = selectedObjects.value
  const fils = sel.value.filaments
  return (
    <div class="float-panel objects-panel">
      <ul>
        {list.map((ob) => (
          <>
            <li class={selection.value.includes(ob.id) && !activeVolume.value ? 'sel' : ''} onClick={(e) => {
              selectedVolume.value = null
              selection.value = e.shiftKey || e.ctrlKey ? [...selection.value, ob.id] : [ob.id]
            }}>
              <span class="swatch" style={{ background: fils[ob.filament]?.color ?? '#888', width: '12px', height: '12px' }} />
              <span class="name" title={ob.name}>{ob.name}</span>
            </li>
            <VolumeRows o={ob} />
          </>
        ))}
      </ul>
      {activeVolume.value && <VolumePanel />}
      {selObjs.length > 0 && !activeVolume.value && (
        <>
          <div class="row">
            <label>Filament</label>
            <div class="control">
              <select value={String(selObjs[0].filament)} onChange={(e) => patchObjects(new Map(selObjs.map((ob) => [ob.id, { filament: +e.currentTarget.value }])))}>
                {fils.map((f, i) => <option value={i}>{i + 1} · {trayShort(f.tray)}: {f.empty ? 'empty' : f.preset.replace(/ @.*$/, '')}</option>)}
              </select>
            </div>
          </div>
          {plateCount.value > 1 && (
            <div class="row">
              <label>Plate</label>
              <div class="control">
                <select value={String(selObjs[0].plate)} onChange={(e) => patchObjects(new Map(selObjs.map((ob) => [ob.id, { plate: +e.currentTarget.value }])))}>
                  {Array.from({ length: plateCount.value }, (_, i) => <option value={i}>Plate {i + 1}</option>)}
                </select>
              </div>
            </div>
          )}
          <div class="actions">
            <button class="small" onClick={() => patchObjects(new Map(selObjs.map((ob) => [ob.id, { rot: [0, 0, 0, 1] as ModelObject['rot'], scale: [1, 1, 1] as ModelObject['scale'] }])))}>Reset transform</button>
          </div>
          {selObjs.length === 1 && <AddVolume o={selObjs[0]} />}
        </>
      )}
    </div>
  )
}
