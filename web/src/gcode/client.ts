import type { GcodePreview } from './parse'

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (p: GcodePreview) => void; reject: (e: Error) => void }>()

export function parseGcodeAsync(bytes: Uint8Array): Promise<GcodePreview> {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'gcode-parser' })
    worker.onmessage = (ev) => {
      const p = pending.get(ev.data.id)
      if (!p) return
      pending.delete(ev.data.id)
      if (ev.data.ok) p.resolve(ev.data.preview)
      else p.reject(new Error(ev.data.error))
    }
  }
  const id = ++seq
  const copy = bytes.slice()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, bytes: copy.buffer }, [copy.buffer])
  })
}
