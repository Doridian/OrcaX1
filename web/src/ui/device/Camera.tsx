// Live camera over WebRTC (WHEP, docs/API.md). orcax1d passes the printer's
// H.264 stream through untouched; the browser does jitter buffering, loss
// recovery and (hardware) decoding into a <video>. Needs a UDP route to the
// printer (port 8443 by default).
import { useEffect, useRef, useState } from 'preact/hooks'

/** Treat the feed as stalled when no frame has arrived for this long. */
const STALL_MS = 3000
const RETRY_MS = 3000

export function Camera() {
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState('connecting…')
  const [fps, setFps] = useState(0)

  useEffect(() => {
    if (typeof RTCPeerConnection === 'undefined') {
      setState('This browser has no WebRTC support')
      return
    }
    let closed = false
    let pc: RTCPeerConnection | null = null
    let session: string | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let frames = 0
    let lastFrame = 0
    let ticks = 0

    const v = video.current!
    const hasFrameCallback = typeof v.requestVideoFrameCallback === 'function'
    const onFrame = () => {
      if (closed) return
      frames++
      lastFrame = performance.now()
      v.requestVideoFrameCallback(onFrame)
    }
    if (hasFrameCallback) v.requestVideoFrameCallback(onFrame)
    else v.onplaying = () => { lastFrame = performance.now() }

    // While no video arrives, ask the daemon why (camera_error).
    const showUpstreamError = async () => {
      try {
        const info = await (await fetch(new URL('api/info', document.baseURI))).json()
        if (!closed && info.camera_error) setState(`camera: ${info.camera_error}`)
      } catch { /* daemon unreachable: the connection state will say so */ }
    }

    const timer = setInterval(() => {
      setFps(frames)
      frames = 0
      ticks++
      const flowing = hasFrameCallback ? performance.now() - lastFrame < STALL_MS : lastFrame > 0
      if (flowing) { setState(''); return }
      if (pc?.connectionState === 'connected') setState((s) => s.startsWith('camera:') ? s : 'waiting for video…')
      if (ticks % 3 === 0) showUpstreamError()
    }, 1000)

    const teardown = () => {
      if (session) {
        // Best effort; the daemon also drops peers whose ICE checks stop.
        fetch(new URL(session, document.baseURI), { method: 'DELETE', keepalive: true }).catch(() => {})
        session = null
      }
      pc?.close()
      pc = null
    }

    const reconnect = (why: string) => {
      if (closed) return
      teardown()
      setState(`${why}, retrying…`)
      if (retry) clearTimeout(retry)
      retry = setTimeout(connect, RETRY_MS)
    }

    const connect = async () => {
      if (closed) return
      const conn = new RTCPeerConnection()
      pc = conn
      const tr = conn.addTransceiver('video', { direction: 'recvonly' })
      // Offer only H.264 (what the camera sends) plus RTX for retransmits.
      const caps = RTCRtpReceiver.getCapabilities?.('video')
      if (caps && tr.setCodecPreferences) {
        const codecs = caps.codecs.filter((c) => /^video\/(h264|rtx)$/i.test(c.mimeType))
        if (codecs.some((c) => /h264/i.test(c.mimeType))) tr.setCodecPreferences(codecs)
      }
      // Ask for minimal buffering: this is a live view, not a movie.
      const rx = tr.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null, playoutDelayHint?: number }
      try { rx.jitterBufferTarget = 0 } catch { /* unsupported */ }
      try { rx.playoutDelayHint = 0 } catch { /* unsupported */ }

      conn.ontrack = (e) => {
        v.srcObject = e.streams[0] ?? new MediaStream([e.track])
      }
      conn.onconnectionstatechange = () => {
        if (conn !== pc) return
        if (conn.connectionState === 'connected') setState('waiting for video…')
        else if (conn.connectionState === 'failed') reconnect('camera connection lost (is UDP 8443 on the printer reachable?)')
      }

      try {
        setState('connecting…')
        await conn.setLocalDescription(await conn.createOffer())
        // The daemon is ICE-lite with host candidates in its answer, so
        // there's no need to wait for our own candidate gathering.
        const res = await fetch(new URL('api/camera/whep', document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/sdp' },
          body: conn.localDescription!.sdp,
        })
        const body = await res.text()
        if (res.status !== 201) {
          let msg = body.trim()
          try { msg = JSON.parse(body).error ?? msg } catch { /* plain text */ }
          throw new Error(msg || `HTTP ${res.status}`)
        }
        if (conn !== pc) return
        session = res.headers.get('location')
        await conn.setRemoteDescription({ type: 'answer', sdp: body })
      } catch (e) {
        if (conn === pc) reconnect(`camera: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    connect()
    return () => {
      closed = true
      clearInterval(timer)
      if (retry) clearTimeout(retry)
      teardown()
    }
  }, [])

  return (
    <div class="camera">
      <video ref={video} autoplay muted playsInline disablePictureInPicture />
      <div class="overlay">{state || `${fps} fps`}</div>
    </div>
  )
}
