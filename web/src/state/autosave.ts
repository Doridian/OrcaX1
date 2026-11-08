// Keeps the current project in IndexedDB so a reload brings it back:
// objects with their transforms, plates, support volumes and filament
// assignment. (The preset selection and its overrides already persist in
// localStorage, see state/settings.ts.)
//
// Meshes are stored once each as binary (Float32Array, structured clone) in
// their own store, keyed per geometry; the project record only references
// them, so moving an object rewrites a few hundred bytes, not the meshes.
// Primitive volume shapes are not stored at all. Everything is best effort:
// without IndexedDB (private mode, blocked storage) the app works as before.
import { effect } from '@preact/signals'
import { primitive, type ModelVolume } from '../model/volumes'
import { currentPlate, loadProject, objects, plateCount, type ModelObject } from './project'

const DB_NAME = 'orcax1-project'
const MESHES = 'meshes'
const PROJECT = 'project'
const KEY = 'current'
const SAVE_DELAY_MS = 1000

type SavedVolume = Omit<ModelVolume, 'positions'> & { mesh?: string }
type SavedObject = Omit<ModelObject, 'positions' | 'volumes' | 'rev'> & { mesh: string; volumes?: SavedVolume[] }
interface SavedProject { version: 1; savedAt: number; plateCount: number; currentPlate: number; objects: SavedObject[] }

const meshKeys = new WeakMap<Float32Array, string>()
let keySeq = 0
const meshKey = (p: Float32Array) => {
  let k = meshKeys.get(p)
  if (!k) { k = `m-${Date.now().toString(36)}-${(keySeq++).toString(36)}`; meshKeys.set(p, k) }
  return k
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
})

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1)
      r.onupgradeneeded = () => {
        const db = r.result
        if (!db.objectStoreNames.contains(MESHES)) db.createObjectStore(MESHES)
        if (!db.objectStoreNames.contains(PROJECT)) db.createObjectStore(PROJECT)
      }
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      r.onblocked = () => reject(new Error('IndexedDB blocked'))
    })
    dbPromise.catch(() => { dbPromise = null })
  }
  return dbPromise
}

/** Standalone copy of a mesh (a view into a larger buffer would store the whole buffer). */
const compact = (p: Float32Array) => (p.byteOffset === 0 && p.byteLength === p.buffer.byteLength ? p : p.slice())

async function save() {
  const list = objects.value
  const meshes = new Map<string, Float32Array>()
  const saved: SavedProject = {
    version: 1,
    savedAt: Date.now(),
    plateCount: plateCount.value,
    currentPlate: currentPlate.value,
    objects: list.map(({ positions, volumes, rev: _rev, ...rest }) => {
      const mesh = meshKey(positions)
      meshes.set(mesh, positions)
      return {
        ...rest,
        mesh,
        volumes: volumes?.map(({ positions: vp, ...v }) => {
          if (v.shape !== 'mesh') return v
          const k = meshKey(vp)
          meshes.set(k, vp)
          return { ...v, mesh: k }
        }),
      }
    }),
  }
  const db = await openDb()
  const tx = db.transaction([MESHES, PROJECT], 'readwrite')
  const store = tx.objectStore(MESHES)
  const existing = new Set((await req(store.getAllKeys())).map(String))
  for (const [k, p] of meshes) if (!existing.has(k)) store.put(compact(p), k)
  for (const k of existing) if (!meshes.has(k)) store.delete(k)
  tx.objectStore(PROJECT).put(saved, KEY)
  await done(tx)
}

/** Loads the saved project, if any. Returns true when something was restored. */
async function restore(): Promise<boolean> {
  const db = await openDb()
  const tx = db.transaction([MESHES, PROJECT], 'readonly')
  const saved = await req(tx.objectStore(PROJECT).get(KEY)) as SavedProject | undefined
  if (!saved || saved.version !== 1 || !saved.objects?.length) return false
  const meshes = new Map<string, Float32Array>()
  const get = async (k: string) => {
    let p = meshes.get(k)
    if (!p) {
      const v = await req(tx.objectStore(MESHES).get(k))
      if (!(v instanceof Float32Array)) throw new Error(`autosave: mesh ${k} missing`)
      p = v
      meshes.set(k, p)
      meshKeys.set(p, k) // so the next save does not rewrite it
    }
    return p
  }
  const list: ModelObject[] = []
  for (const { mesh, volumes, ...o } of saved.objects) {
    const vols: ModelVolume[] = []
    for (const { mesh: vm, ...v } of volumes ?? []) {
      vols.push({ ...v, positions: v.shape === 'mesh' ? await get(vm!) : primitive(v.shape) })
    }
    list.push({ ...o, positions: await get(mesh), volumes: vols.length ? vols : undefined, rev: 0 })
  }
  await done(tx).catch(() => {})
  if (objects.value.length) return false // the user already started a new project
  loadProject(list, saved.plateCount)
  currentPlate.value = Math.min(saved.currentPlate ?? 0, Math.max(1, saved.plateCount) - 1)
  return true
}

let timer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()
function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, SAVE_DELAY_MS)
}
function flush() {
  if (timer) { clearTimeout(timer); timer = null }
  saving = saving.then(save).catch((e) => console.warn('autosave failed', e))
}

let started = false
/** Restores the last project, then saves every change (debounced). */
export async function initAutosave() {
  if (started) return
  started = true
  if (typeof indexedDB === 'undefined') return
  try {
    if (await restore()) console.info('Restored the project from the last session.')
  } catch (e) {
    console.warn('autosave restore failed', e)
  }
  let first = true
  effect(() => {
    void objects.value
    void plateCount.value
    if (first) { first = false; return }
    schedule()
  })
  const flushNow = () => { if (timer) flush() }
  addEventListener('pagehide', flushNow)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow() })
}
