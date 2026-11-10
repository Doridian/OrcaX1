// Printer power outlet (see docs/OUTLET.md). All through orcax1d, which
// talks to the ESPHome device: no mixed content, no CORS, and switching the
// printer off needs a login. While the printer is off, the service worker
// sends the browser to the device's own page instead (see offline.tsx).
import { signal } from '@preact/signals'
import { getOutlet, getOutletState, saveOutlet, switchOutlet, type OutletView } from '../api'
import { cacheDeviceUrl } from './deviceUrl'

/** null until loaded; url '' when no outlet is set up. */
export const outletView = signal<OutletView | null>(null)

/** The device answered the last poll. */
export const outletOnline = signal(false)
/** Last problem reaching it; null while fine. */
export const outletError = signal<string | null>(null)
/** null: unknown (Home Assistant doesn't know, or not loaded yet). */
export const outletOn = signal<boolean | null>(null)
/** Watts; null when unknown. */
export const outletPower = signal<number | null>(null)
/** The device's link to Home Assistant; null when unknown or it has none. */
export const outletLinked = signal<boolean | null>(null)
/** The device has an off token configured. */
export const outletCanTurnOff = signal(false)
/** Switching to this state was asked for and the outlet hasn't reported it yet. */
export const outletPending = signal<boolean | null>(null)

const POLL_MS = 2000
const POLL_PENDING_MS = 700
const PENDING_TIMEOUT_MS = 20000

let users = 0
let timer: ReturnType<typeof setTimeout> | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0

function apply(view: OutletView) {
  outletView.value = view
  cacheDeviceUrl(view.url || null)
}

export async function loadOutlet() {
  apply(await getOutlet())
  restart()
}

export async function saveOutletSettings(url: string, token: string, clearToken = false) {
  apply(await saveOutlet(url, token, clearToken))
  restart()
}

/** Polls the outlet while at least one caller needs it. Returns the release function. */
export function openOutletPoll(): () => void {
  if (users++ === 0) {
    if (outletView.value === null) loadOutlet().catch((e) => { outletError.value = e?.message ?? String(e) })
    else restart()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--users === 0) stop()
  }
}

function stop() {
  generation++
  if (timer) clearTimeout(timer)
  timer = null
}

function restart() {
  stop()
  outletOnline.value = false
  outletError.value = null
  outletOn.value = null
  outletPower.value = null
  outletLinked.value = null
  setPending(null)
  if (users > 0 && outletView.value?.url) void poll(generation)
}

async function poll(gen: number) {
  try {
    const s = await getOutletState()
    if (gen !== generation) return
    if (outletPending.value !== null && s.on === outletPending.value) setPending(null)
    outletOn.value = s.on
    outletPower.value = typeof s.power === 'number' && Number.isFinite(s.power) ? s.power : null
    outletLinked.value = s.linked
    outletCanTurnOff.value = s.can_turn_off
    outletOnline.value = true
    outletError.value = null
  } catch (e: any) {
    if (gen !== generation) return
    outletOnline.value = false
    outletError.value = e?.message ?? String(e)
  }
  if (gen !== generation) return
  timer = setTimeout(() => void poll(gen), outletPending.value !== null ? POLL_PENDING_MS : POLL_MS)
}

function setPending(v: boolean | null) {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = null
  outletPending.value = v
  // Stop waiting if the outlet never reports the change (say Home Assistant
  // couldn't reach it), so the switch doesn't spin forever.
  if (v !== null) pendingTimer = setTimeout(() => { outletPending.value = null }, PENDING_TIMEOUT_MS)
}

/** Asks for the outlet to switch; resolves once the request is accepted, not when the outlet has switched. */
export async function setOutlet(on: boolean) {
  setPending(on)
  try {
    await switchOutlet(on)
  } catch (e) {
    setPending(null)
    throw e
  }
  // Poll sooner than the regular interval.
  if (users > 0 && outletView.value?.url) {
    stop()
    void poll(generation)
  }
}

export function formatWatts(w: number | null): string {
  if (w === null) return '— W'
  return w >= 100 ? `${Math.round(w)} W` : `${w.toFixed(1)} W`
}
