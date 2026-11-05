import { computed, effect, signal } from '@preact/signals'
import {
  bedSize, compatibleFilaments, compatibleProcesses, loadBundle,
  type FilamentSlot, type ProfileBundle, type Selection,
} from '../slicer/profiles'
import { touch } from './project'

const STORAGE_KEY = 'orcax1.selection.v1'

export const bundle = signal<ProfileBundle | null>(null)
export const bundleError = signal<string | null>(null)

const DEFAULT: Selection = {
  printer: 'Bambu Lab X1 Carbon 0.4 nozzle',
  process: '0.20mm Standard @BBL X1C',
  filaments: [{ preset: 'Bambu PLA Basic @BBL X1C', color: '#F2F2F2' }],
  bedType: 'Textured PEI Plate',
  flow: 'Standard',
  processOverrides: {},
  printerOverrides: {},
}

function loadSaved(): Selection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT, ...JSON.parse(raw) }
  } catch { /* storage unavailable */ }
  return DEFAULT
}

export const sel = signal<Selection>(loadSaved())

effect(() => {
  const v = sel.value
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch { /* ignore */ }
})

export function updateSel(patch: Partial<Selection>) {
  sel.value = { ...sel.value, ...patch }
  touch()
}

export const bed = computed(() => (bundle.value ? bedSize(bundle.value, sel.value.printer) : { x: 256, y: 256, z: 250, exclude: [] as [number, number][] }))
export const processList = computed(() => (bundle.value ? compatibleProcesses(bundle.value, sel.value.printer) : []))
export const filamentList = computed(() => (bundle.value ? compatibleFilaments(bundle.value, sel.value.printer) : []))
export const currentProcess = computed(() => bundle.value?.processes.find((p) => p.name === sel.value.process) ?? null)
export const currentPrinter = computed(() => bundle.value?.printers.find((p) => p.name === sel.value.printer) ?? null)

/** Effective value of a process setting (preset + override). */
export function processValue(key: string): string | string[] | undefined {
  return sel.value.processOverrides[key] ?? currentProcess.value?.settings[key]
}

export function setProcessOverride(key: string, value: string | string[] | null) {
  const o = { ...sel.value.processOverrides }
  const base = currentProcess.value?.settings[key]
  if (value === null || JSON.stringify(value) === JSON.stringify(base) || (base === undefined && value === '')) delete o[key]
  else o[key] = value
  updateSel({ processOverrides: o })
}

export function setPrinter(name: string) {
  const b = bundle.value
  if (!b) return
  const p = b.printers.find((x) => x.name === name)
  if (!p) return
  const procs = compatibleProcesses(b, name)
  const process = procs.some((x) => x.name === sel.value.process)
    ? sel.value.process
    : (procs.find((x) => x.name === p.settings.default_print_profile)?.name ?? procs[0]?.name ?? '')
  const fils = compatibleFilaments(b, name)
  const filaments = sel.value.filaments.map((f) => {
    if (fils.some((x) => x.name === f.preset)) return f
    // Same filament for the new nozzle/printer, e.g. "Bambu PLA Basic @BBL X1C 0.2 nozzle".
    const stem = f.preset.replace(/ @.*$/, '')
    const match = fils.find((x) => x.name.startsWith(stem + ' @')) ?? fils[0]
    return { ...f, preset: match?.name ?? f.preset }
  })
  updateSel({ printer: name, process, filaments, processOverrides: {} })
}

export function setFilaments(filaments: FilamentSlot[]) {
  updateSel({ filaments })
}

export async function initSettings() {
  try {
    const b = await loadBundle()
    bundle.value = b
    // Repair a stale saved selection.
    if (!b.printers.some((p) => p.name === sel.value.printer)) sel.value = { ...sel.value, printer: DEFAULT.printer }
    setPrinter(sel.value.printer)
  } catch (e) {
    bundleError.value = String(e)
  }
}
