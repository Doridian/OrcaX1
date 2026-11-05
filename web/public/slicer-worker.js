// Classic worker that hosts the OrcaSlicer WASM engine (one-slicer-api 0.7.0).
// The engine spawns its own pthread workers. Keeping it off the main thread
// keeps the UI responsive during the synchronous engine calls.
//
// Protocol: request {id, method, args}, reply {id, ok, result | error}.
// Progress: {id, progress: {percent, stage}}.
'use strict'

const engineUrl = new URL('engine/slicer-mt.js', self.location).href
let engine = null
let session = null
const aborts = new Map()
const enc = new TextEncoder()
const json = (o) => enc.encode(JSON.stringify(o))

function errorInfo(e) {
  if (e && typeof e === 'object') {
    return { code: e.code ?? null, message: e.message ?? String(e), detail: e.detail ?? null }
  }
  return { code: null, message: String(e) }
}

const methods = {
  async load() {
    if (engine) return engine.capabilities
    importScripts(engineUrl)
    engine = await self.OneSlicerEngine.createEngine({
      runtime: {
        mainScriptUrlOrBlob: engineUrl,
        locateFile: (path) => new URL('engine/' + path, self.location).href,
        print: (m) => console.log('[engine]', m),
        printErr: (m) => console.warn('[engine]', m),
      },
    })
    session = await engine.createSession()
    return engine.capabilities
  },

  /** init: object (orca.native-json); fragments: [{format, data}] applied in order. */
  async configure(init, fragments) {
    await session.init(json(init))
    for (const f of fragments) await session.applyProfile(f.format, json(f.data))
    return true
  },

  async setObjects(blob, manifest) {
    await session.setObjects(new Uint8Array(blob), manifest)
    return true
  },

  async getManifest() {
    return session.getManifest()
  },

  async initProfile(format, bytes) {
    await session.initProfile(format, new Uint8Array(bytes))
    return session.getManifest()
  },

  async prepare(request, ctx) {
    return session.prepare(request, ctx)
  },

  async slice(request, ctx) {
    return session.slice(request, ctx)
  },

  async export(format, options, ctx) {
    return session.export(format, options, ctx)
  },

  async getAsset(assetId) {
    const bytes = await session.getAsset(assetId)
    return transfer(bytes)
  },

  async convert(kind, bytes) {
    const input = new Uint8Array(bytes)
    let out
    if (kind === 'obj') out = await engine.objToStl(input)
    else if (kind === 'step') out = await engine.cadToStl(input)
    else if (kind === '3mf') out = await engine.threeMfToStl(input)
    else throw new Error('unknown conversion ' + kind)
    return transfer(out)
  },
}

const transfers = new WeakMap()
function transfer(u8) {
  // Copy out of the engine heap into a standalone, transferable buffer.
  const copy = u8.buffer instanceof ArrayBuffer && u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
    ? u8 : u8.slice()
  const box = { __bytes: copy.buffer }
  transfers.set(box, [copy.buffer])
  return box
}

self.onmessage = async (ev) => {
  const { id, method, args = [], cancel } = ev.data
  if (cancel) {
    aborts.get(cancel)?.abort()
    return
  }
  const fn = methods[method]
  if (!fn) {
    self.postMessage({ id, ok: false, error: { message: 'unknown method ' + method } })
    return
  }
  const controller = new AbortController()
  aborts.set(id, controller)
  const ctx = {
    signal: controller.signal,
    onProgress: (p) => self.postMessage({ id, progress: p }),
  }
  try {
    const takesCtx = method === 'prepare' || method === 'slice' || method === 'export'
    const result = await fn(...args, ...(takesCtx ? [ctx] : []))
    const list = result && typeof result === 'object' ? transfers.get(result) : undefined
    self.postMessage({ id, ok: true, result }, list ?? [])
  } catch (e) {
    self.postMessage({ id, ok: false, error: errorInfo(e) })
  } finally {
    aborts.delete(id)
  }
}
