// Main-thread client for public/slicer-worker.js.

export interface Progress { percent: number | null; stage: string }

export class EngineError extends Error {
  code: string | null
  constructor(info: { code?: string | null; message: string }) {
    super(info.code ? `${info.code}: ${info.message}` : info.message)
    this.code = info.code ?? null
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; onProgress?: (p: Progress) => void }

export class Engine {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, Pending>()
  capabilities: any = null

  constructor() {
    this.worker = new Worker(new URL('slicer-worker.js', document.baseURI), { name: 'orca-engine' })
    this.worker.onmessage = (ev) => {
      const msg = ev.data
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.progress) { p.onProgress?.(msg.progress); return }
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(unbox(msg.result))
      else p.reject(new EngineError(msg.error))
    }
    this.worker.onerror = (ev) => {
      const err = new EngineError({ message: ev.message || 'engine worker crashed' })
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
  }

  private call<T>(method: string, args: unknown[], opts: { transfer?: Transferable[]; onProgress?: (p: Progress) => void; signal?: AbortSignal } = {}): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: opts.onProgress })
      opts.signal?.addEventListener('abort', () => this.worker.postMessage({ cancel: id }), { once: true })
      this.worker.postMessage({ id, method, args }, opts.transfer ?? [])
    })
  }

  async load() {
    this.capabilities = await this.call('load', [])
    return this.capabilities
  }
  configure(init: unknown, fragments: unknown[]) { return this.call<boolean>('configure', [init, fragments]) }
  setObjects(blob: Uint8Array, manifest: unknown) {
    const copy = blob.slice()
    return this.call<boolean>('setObjects', [copy.buffer, manifest], { transfer: [copy.buffer] })
  }
  getManifest() { return this.call<any>('getManifest', []) }
  initProfile(format: string, bytes: Uint8Array) {
    const copy = bytes.slice()
    return this.call<any>('initProfile', [format, copy.buffer], { transfer: [copy.buffer] })
  }
  prepare(request: unknown, onProgress?: (p: Progress) => void, signal?: AbortSignal) {
    return this.call<any>('prepare', [request], { onProgress, signal })
  }
  slice(request: unknown, onProgress?: (p: Progress) => void, signal?: AbortSignal) {
    return this.call<any>('slice', [request], { onProgress, signal })
  }
  export(format: string, options: unknown, onProgress?: (p: Progress) => void, signal?: AbortSignal) {
    return this.call<any>('export', [format, options], { onProgress, signal })
  }
  async getAsset(id: string): Promise<Uint8Array> {
    return new Uint8Array(await this.call<ArrayBuffer>('getAsset', [id]))
  }
  async convert(kind: 'obj' | 'step' | '3mf', bytes: Uint8Array): Promise<Uint8Array> {
    const copy = bytes.slice()
    return new Uint8Array(await this.call<ArrayBuffer>('convert', [kind, copy.buffer], { transfer: [copy.buffer] }))
  }
}

function unbox(v: any) {
  return v && typeof v === 'object' && v.__bytes instanceof ArrayBuffer ? v.__bytes : v
}

let shared: Promise<Engine> | null = null
/** The engine is ~29 MB; it loads once, on first use. */
export function getEngine(): Promise<Engine> {
  if (!shared) {
    shared = (async () => {
      if (!crossOriginIsolated) {
        throw new Error('This page is not cross-origin isolated (needs HTTPS + COOP/COEP), so the multithreaded slicer cannot start.')
      }
      const e = new Engine()
      await e.load()
      return e
    })()
    shared.catch(() => { shared = null })
  }
  return shared
}
