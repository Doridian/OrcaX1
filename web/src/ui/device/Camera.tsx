// Live camera: orcax1d forwards raw H.264 access units over a websocket
// (docs/API.md), decoded here with WebCodecs. No transcoding on the printer.
import { useEffect, useRef, useState } from 'preact/hooks'

export function Camera() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState('connecting…')
  const [fps, setFps] = useState(0)

  useEffect(() => {
    if (typeof VideoDecoder === 'undefined') {
      setState('This browser has no WebCodecs support (needs a secure context, e.g. HTTPS)')
      return
    }
    let closed = false
    let ws: WebSocket | null = null
    let decoder: VideoDecoder | null = null
    let codec: string | null = null
    let frames = 0
    let retry: ReturnType<typeof setTimeout> | null = null
    const fpsTimer = setInterval(() => { setFps(frames); frames = 0 }, 1000)

    const makeDecoder = () => {
      decoder?.close()
      decoder = new VideoDecoder({
        output: (frame) => {
          const c = canvas.current
          if (c) {
            if (c.width !== frame.displayWidth) c.width = frame.displayWidth
            if (c.height !== frame.displayHeight) c.height = frame.displayHeight
            c.getContext('2d')!.drawImage(frame, 0, 0)
          }
          frame.close()
          frames++
        },
        error: (e) => { setState(`decoder error: ${e.message}`); waitingKey = true; if (codec) makeDecoder() },
      })
      // Annex-B input: no "description", SPS/PPS come in-band with each keyframe.
      decoder.configure({ codec: codec!, optimizeForLatency: true, hardwareAcceleration: 'no-preference' })
    }
    let waitingKey = true

    const connect = () => {
      const url = new URL('api/camera', document.baseURI)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => setState('waiting for video…')
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'config' && msg.codec !== codec) {
            codec = msg.codec
            waitingKey = true
            makeDecoder()
          } else if (msg.type === 'error') setState(msg.message)
          return
        }
        if (!decoder || decoder.state !== 'configured') return
        const buf = new Uint8Array(ev.data)
        const key = (buf[0] & 1) === 1
        if (waitingKey && !key) return
        waitingKey = false
        const ts = Number(new DataView(buf.buffer, 1, 8).getBigUint64(0))
        // Drop frames if the decoder falls behind instead of building latency.
        if (decoder.decodeQueueSize > 8 && !key) return
        decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: buf.subarray(9) }))
        setState('')
      }
      ws.onclose = () => {
        if (closed) return
        setState('camera disconnected, retrying…')
        retry = setTimeout(connect, 3000)
      }
    }
    connect()
    return () => {
      closed = true
      clearInterval(fpsTimer)
      if (retry) clearTimeout(retry)
      ws?.close()
      try { decoder?.close() } catch { /* already closed */ }
    }
  }, [])

  return (
    <div class="camera">
      <canvas ref={canvas} />
      {state ? <div class="overlay">{state}</div> : <div class="overlay">{fps} fps</div>}
    </div>
  )
}
