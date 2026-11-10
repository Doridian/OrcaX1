import { formatWatts, outletError, outletOn, outletOnline, outletPower, outletView } from './outlet'
import { confirmOutletOff } from './OutletSettings'
import { OutletSwitch, useOutlet } from './OutletUI'

/** Topbar: outlet state, live power and the on/off switch (only when an outlet is set up). */
export function OutletChip() {
  useOutlet()
  if (!outletView.value?.url) return null
  if (!outletOnline.value) {
    return <span class="conn" title={outletError.value ?? 'Connecting to the outlet…'}><span class="dot" /> outlet</span>
  }
  return (
    <span class="conn outlet-chip" title={`Printer outlet: ${outletOn.value === null ? 'unknown' : outletOn.value ? 'on' : 'off'}`}>
      <span class="outlet-watts">{formatWatts(outletPower.value)}</span>
      <OutletSwitch onBeforeOff={confirmOutletOff} />
    </span>
  )
}
