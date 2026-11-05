import { parseGcode } from './parse'

self.onmessage = (ev: MessageEvent<{ id: number; bytes: ArrayBuffer }>) => {
  const { id, bytes } = ev.data
  try {
    const p = parseGcode(new TextDecoder().decode(bytes))
    ;(self as unknown as Worker).postMessage({ id, ok: true, preview: p }, [
      p.segments.buffer, p.feature.buffer, p.tool.buffer, p.layerStart.buffer, p.layerZ.buffer,
    ])
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id, ok: false, error: String(e) })
  }
}
