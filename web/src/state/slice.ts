import { computed, signal } from '@preact/signals'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { parseGcodeAsync } from '../gcode/client'
import type { GcodePreview } from '../gcode/parse'
import { getEngine, type Progress } from '../slicer/engine'
import { buildEngineConfig } from '../slicer/profiles'
import { buildProject, objects, plateCount, projectRev, touch } from './project'
import { bundle, sel } from './settings'

export interface PlateSlice {
  plateIndex: number
  gcode: Uint8Array | null
  statistics: any
  warnings: { code: string; message: string }[]
  preview: GcodePreview | null
}

export const sliceStatus = signal<'idle' | 'loading-engine' | 'slicing' | 'done' | 'error'>('idle')
export const sliceProgress = signal<Progress | null>(null)
export const sliceError = signal<string | null>(null)
export const slicedRev = signal(-1)
export const plates = signal<PlateSlice[]>([])
export const engineReady = signal(false)
export const isStale = computed(() => slicedRev.value !== projectRev.value)

let abort: AbortController | null = null
/** Increments on every successful slice. */
let sliceSerial = 0
/** False once the engine session got a new project (e.g. for a project save), which drops its slice. */
let sessionHoldsSlice = false

export async function configuredEngine() {
  const b = bundle.value
  if (!b) throw new Error('profiles not loaded')
  if (!engineReady.value) {
    const prev = sliceStatus.value
    sliceStatus.value = 'loading-engine'
    try { await getEngine() } finally { sliceStatus.value = prev }
    engineReady.value = true
  }
  const engine = await getEngine()
  sessionHoldsSlice = false
  const cfg = buildEngineConfig(b, sel.value)
  await engine.configure(cfg.init, cfg.fragments)
  const { blob, manifest } = buildProject(objects.value, plateCount.value)
  await engine.setObjects(blob, manifest)
  return engine
}

export async function sliceAll() {
  abort?.abort()
  const controller = new AbortController()
  abort = controller
  const rev = projectRev.value
  sliceError.value = null
  sliceProgress.value = null
  try {
    if (!objects.value.length) throw new Error('Nothing to slice: add a model first.')
    const engine = await configuredEngine()
    sliceStatus.value = 'slicing'
    const used = [...new Set(objects.value.map((o) => o.plate))].sort((a, b) => a - b)
    const result = await engine.slice({
      schemaVersion: '0.7.0',
      plateSelection: 'selected',
      plateIds: used.map((i) => `plate-${i}`),
      includeGcode: true,
      includeStatistics: true,
    }, (p) => { sliceProgress.value = p }, controller.signal)
    const out: PlateSlice[] = []
    for (const pr of result.plateResults ?? []) {
      const idx = Number(String(pr.plateId).replace('plate-', ''))
      const asset = pr.assets?.find((a: any) => a.kind === 'gcode')
      const gcode = asset ? await engine.getAsset(asset.id) : null
      out.push({ plateIndex: idx, gcode, statistics: pr.statistics, warnings: pr.warnings ?? [], preview: null })
    }
    for (const w of result.warnings ?? []) console.warn('slice warning', w)
    sliceProgress.value = { percent: 100, stage: 'Building preview' }
    for (const p of out) if (p.gcode) p.preview = await parseGcodeAsync(p.gcode)
    if (controller.signal.aborted) return
    plates.value = out
    sessionHoldsSlice = true
    sliceSerial++
    slicedRev.value = rev
    sliceStatus.value = 'done'
  } catch (e: any) {
    if (controller.signal.aborted && e?.code === 'CANCELLED') { sliceStatus.value = 'idle'; return }
    sliceError.value = e?.message ?? String(e)
    sliceStatus.value = 'error'
  } finally {
    if (abort === controller) abort = null
  }
}

export function cancelSlice() { abort?.abort() }

/**
 * Exports the sliced project as a Bambu-printable 3MF (G-code embedded per
 * plate). The engine session must still hold the last slice, so this re-slices
 * when anything changed.
 */
// The engine drops its slice artifacts after an export, so keep the export.
let exportCache: { rev: number; bytes: Uint8Array } | null = null

export async function exportPrintable(onProgress?: (p: Progress) => void): Promise<Uint8Array> {
  if (isStale.value || sliceStatus.value !== 'done') await sliceAll()
  if (sliceStatus.value !== 'done') throw new Error(sliceError.value ?? 'slicing failed')
  if (exportCache && exportCache.rev === sliceSerial) return exportCache.bytes
  if (!sessionHoldsSlice) await sliceAll()
  if (sliceStatus.value !== 'done') throw new Error(sliceError.value ?? 'slicing failed')
  const serial = sliceSerial
  const engine = await getEngine()
  const res = await engine.export('project.3mf', {
    schemaVersion: '0.7.0',
    preservation: 'best-effort',
    includeSliceArtifacts: true,
  }, onProgress)
  for (const w of res.warnings ?? []) console.warn('export warning', w)
  const bytes = await engine.getAsset(res.asset.id)
  exportCache = { rev: serial, bytes }
  return bytes
}

/** Engine arrange: lays out all objects across their plates. */
export async function arrange() {
  const engine = await configuredEngine()
  const manifest = await engine.prepare({ schemaVersion: '0.7.0', operation: 'arrange' })
  applyManifestTransforms(manifest)
}

export async function autoOrient() {
  const engine = await configuredEngine()
  const manifest = await engine.prepare({ schemaVersion: '0.7.0', operation: 'auto-orient' })
  applyManifestTransforms(manifest)
}

function applyManifestTransforms(manifest: any) {
  const byObject = new Map<string, any>()
  for (const inst of manifest.instances ?? []) byObject.set(inst.objectId, inst)
  objects.value = objects.value.map((o) => {
    const inst = byObject.get(o.id)
    if (!inst) return o
    const r = inst.transform.matrix as number[]
    const m = new Matrix4().set(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15])
    const p = new Vector3(), q = new Quaternion(), s = new Vector3()
    m.decompose(p, q, s)
    const plate = Number(String(inst.plateId).replace('plate-', ''))
    if (Number.isFinite(plate) && plate + 1 > plateCount.value) plateCount.value = plate + 1
    return { ...o, x: p.x, y: p.y, rot: [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z], plate: Number.isFinite(plate) ? plate : o.plate, rev: o.rev + 1 }
  })
  touch()
}
