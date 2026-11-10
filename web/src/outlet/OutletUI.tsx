import { useEffect, useState } from 'preact/hooks'
import { formatWatts, openOutletPoll, outletCanTurnOff, outletError, outletLinked, outletOn, outletOnline, outletPending, outletPower, setOutlet } from './outlet'

export function Spinner({ size = 16 }: { size?: number }) {
  return <span class="spinner" style={{ width: size, height: size }} aria-hidden="true" />
}

/** Polls the outlet while mounted. */
export function useOutlet() {
  useEffect(() => openOutletPoll(), [])
}

/** On/off switch, HA style: shows a spinner until the outlet reports the new state. */
export function OutletSwitch({ onBeforeOff }: { onBeforeOff?: () => Promise<boolean> }) {
  const [err, setErr] = useState<string | null>(null)
  const on = outletOn.value
  const pending = outletPending.value
  const noOff = on === true && !outletCanTurnOff.value
  const disabled = !outletOnline.value || on === null || outletLinked.value === false || pending !== null || noOff
  const flip = async () => {
    setErr(null)
    const next = !on
    if (!next && onBeforeOff && !(await onBeforeOff())) return
    try { await setOutlet(next) } catch (e: any) { setErr(e?.message ?? String(e)) }
  }
  return (
    <>
      <button
        class={`outlet-switch ${on ? 'on' : ''} ${pending !== null ? 'pending' : ''}`}
        role="switch"
        aria-checked={on === true}
        disabled={disabled}
        onClick={flip}
        title={noOff ? 'The outlet device has no off_token: it can\'t be switched off from here' : on ? 'Turn the printer off' : 'Turn the printer on'}
      >
        <span class="knob">{pending !== null && <Spinner size={14} />}</span>
      </button>
      {err && <div class="error small-text">{err}</div>}
    </>
  )
}

/** Status lines for the outlet: state, live power, warnings. */
export function OutletStatus() {
  if (!outletOnline.value) {
    return outletError.value
      ? <div class="error small-text">{outletError.value}</div>
      : <div class="muted outlet-line"><Spinner size={12} /> Connecting to the outlet…</div>
  }
  const pending = outletPending.value
  return (
    <>
      <div class="outlet-line">
        <span class={`dot ${outletOn.value ? 'on' : ''}`} />
        <span>{pending === true ? 'Turning on…' : pending === false ? 'Turning off…' : outletOn.value === null ? 'Unknown' : outletOn.value ? 'On' : 'Off'}</span>
        <span class="outlet-watts">{formatWatts(outletPower.value)}</span>
      </div>
      {outletLinked.value === false && <div class="warning small-text">The outlet device has lost its connection to Home Assistant: the values may be stale and switching won't work.</div>}
      {!outletCanTurnOff.value && <div class="muted small-text">The device has no <code>off_token</code>, so the printer can't be switched off from OrcaX1.</div>}
    </>
  )
}
