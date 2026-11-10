// The page the service worker serves when the printer doesn't answer (it's
// switched off, or orcax1d is still starting). Kept tiny and separate from
// the main app so the worker can cache it.
//
// It can't show or switch the outlet itself: the outlet device is plain
// HTTP and this page HTTPS, which browsers block (Firefox and Safari
// entirely). So it sends the browser to the device's own page, which goes
// back to OrcaX1 once the printer is up. Meanwhile it keeps checking the
// printer, in case it was only restarting.
import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { cachedDeviceUrl } from './deviceUrl'
import '../styles.css'

const HANDOFF_DELAY_S = 3

async function printerUp(): Promise<boolean> {
  try {
    const res = await fetch(new URL('api/alive', document.baseURI), { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch {
    return false
  }
}

function Offline() {
  const device = cachedDeviceUrl()
  const target = device ? `${device}/orcax1?from=orcax1` : null
  const [left, setLeft] = useState(HANDOFF_DELAY_S)

  useEffect(() => {
    let stop = false
    let t: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (await printerUp()) {
        if (!stop) location.reload()
        return
      }
      if (!stop) t = setTimeout(tick, 3000)
    }
    void tick()
    return () => { stop = true; clearTimeout(t) }
  }, [])

  useEffect(() => {
    if (!target) return
    if (left <= 0) {
      location.href = target
      return
    }
    const t = setTimeout(() => setLeft(left - 1), 1000)
    return () => clearTimeout(t)
  }, [left, target])

  return (
    <div class="login">
      <div class="card offline">
        <div class="brand">Orca<span>X1</span></div>
        <div class="muted outlet-line"><span class="spinner" style={{ width: 14, height: 14 }} /> The printer isn't responding.</div>
        {target ? (
          <>
            {Number.isFinite(left)
              ? <div>Opening the printer's power switch{left > 0 ? ` in ${left} s` : ''}…</div>
              : <div class="muted small-text">Retrying. This page opens OrcaX1 as soon as the printer answers.</div>}
            <div class="btnrow">
              <a href={target}><button class="primary">{Number.isFinite(left) ? 'Open now' : 'Printer power switch'}</button></a>
              {Number.isFinite(left) && <button onClick={() => setLeft(Infinity)}>Stay here</button>}
            </div>
          </>
        ) : (
          <div class="muted small-text">Retrying. To switch the printer on from here, set up its outlet under Settings → Printer outlet.</div>
        )}
      </div>
    </div>
  )
}

render(<Offline />, document.getElementById('app')!)
