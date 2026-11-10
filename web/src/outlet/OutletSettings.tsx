import { useEffect, useState } from 'preact/hooks'
import { ask } from '../state/confirm'
import { isPrinting } from '../state/printer'
import { outletOnline, outletView, saveOutletSettings } from './outlet'
import { OutletStatus, OutletSwitch, useOutlet } from './OutletUI'

const DOCS_URL = 'https://github.com/Doridian/OrcaX1/blob/main/docs/OUTLET.md'

/** Asks before cutting power, more insistently while printing. */
export async function confirmOutletOff(): Promise<boolean> {
  return ask(isPrinting.value
    ? { title: 'Cut power to the printer?', body: 'A print is running. Switching the outlet off stops it immediately and it can\'t be resumed.', confirm: 'Turn off', danger: true }
    : { title: 'Turn the printer off?', body: 'This switches its outlet off. Until it is switched on again, opening OrcaX1 takes you to the outlet device\'s page to do that.', confirm: 'Turn off', danger: true })
}

export function OutletSettings() {
  useOutlet()
  const view = outletView.value
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (view) setUrl(view.url) }, [view?.url])

  if (!view) return <div class="card"><h2>Printer outlet</h2><div class="muted">Loading…</div></div>

  const save = async (clearToken = false) => {
    setBusy(true)
    setErr(null)
    setSaved(false)
    try {
      await saveOutletSettings(url, token, clearToken)
      setToken('')
      setSaved(true)
    } catch (e: any) { setErr(e?.message ?? String(e)) } finally { setBusy(false) }
  }
  const dirty = url.trim().replace(/\/+$/, '') !== view.url || !!token

  return (
    <div class="card">
      <h2>Printer outlet</h2>
      <p class="muted small-text">
        Show and switch the printer's power outlet. It goes through an always-on ESPHome device with the{' '}
        <code>orcax1_outlet</code> component, which relays the outlet from Home Assistant or is the plug itself (see{' '}
        <a href={DOCS_URL} target="_blank" rel="noreferrer">the setup</a>). While the printer is off, opening OrcaX1 in a
        browser that has been here before takes you to that device's page, which can switch it on. Switching it off
        needs a login here.
      </p>
      <div class="form-grid">
        <label>Device address</label>
        <div>
          <input type="text" value={url} placeholder="http://192.168.1.60" onInput={(e) => { setUrl(e.currentTarget.value); setSaved(false) }} />
          <div class="muted small-text">Empty to turn this off.</div>
        </div>
        <label>Off token</label>
        <div>
          <input type="password" autocomplete="off" value={token} placeholder={view.token_set ? '(saved, unchanged)' : 'the device\'s off_token'} onInput={(e) => { setToken(e.currentTarget.value); setSaved(false) }} />
          <div class="muted small-text">Lets OrcaX1 switch the printer off. Kept on the printer, never sent to browsers.</div>
          {view.token_set && <div><button disabled={busy} onClick={async () => { if (await ask({ title: 'Remove the saved off token?', body: 'OrcaX1 can then only switch the printer on.', confirm: 'Remove', danger: true })) save(true) }}>Remove saved token</button></div>}
        </div>
      </div>
      {err && <div class="error">{err}</div>}
      <div class="btnrow">
        <button class="primary" disabled={busy || !dirty} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>
        {saved && <span class="muted">Saved.</span>}
      </div>
      {view.url && (
        <div class="outlet-settings-status">
          <div class="outlet-row">
            <div class="outlet-title">Printer power</div>
            {outletOnline.value && <OutletSwitch onBeforeOff={confirmOutletOff} />}
          </div>
          <OutletStatus />
        </div>
      )}
    </div>
  )
}
