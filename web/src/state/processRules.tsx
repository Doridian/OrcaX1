// Connects Orca's process rules (slicer/configRules.ts) to the selection:
// after the user changes a process value, the rules may correct other values,
// ask (state/confirm.ts) or leave a notice for the process panel.
import { signal } from '@preact/signals'
import { newRuleState, processChanged, type FilamentInfo, type RuleHost } from '../slicer/configRules'
import { ask } from './confirm'
import { objects } from './project'
import { bundle, currentPrinter, onProcessChange, processScalar, sel, settingsMode, writeProcessScalar } from './settings'

export interface Notice { id: number; text: string }
/** Warnings from the last change (Orca's "... Reset to X." message boxes). */
export const processNotices = signal<Notice[]>([])
let nextNotice = 1
export const dismissNotice = (id: number) => { processNotices.value = processNotices.value.filter((n) => n.id !== id) }

const state = newRuleState()
let queue: Promise<void> = Promise.resolve()

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

function filaments(): FilamentInfo[] {
  const b = bundle.value
  return sel.value.filaments.map((slot) => {
    const s = b?.filaments.find((f) => f.name === slot.preset)?.settings ?? {}
    return { type: first(s.filament_type), support: first(s.filament_is_support) === '1', soluble: first(s.filament_soluble) === '1' }
  })
}

function host(): RuleHost {
  const fils = filaments()
  return {
    get: processScalar,
    set: writeProcessScalar,
    printer: currentPrinter.value?.settings ?? {},
    filaments: fils,
    usedFilamentTypes: () => objects.value.map((o) => fils[o.filament]?.type ?? 'PLA'),
    simpleMode: settingsMode.value === 0,
    ask: (q) => ask({ title: q.title, body: <p class="pre-line">{q.body}</p>, confirm: q.yes, cancel: q.no }),
    notify: (text) => {
      if (!processNotices.value.some((n) => n.text === text)) processNotices.value = [...processNotices.value, { id: nextNotice++, text }]
    },
  }
}

onProcessChange((key, prev) => {
  queue = queue.then(async () => {
    processNotices.value = []
    await processChanged(key, prev, host(), state)
  }).catch((e) => console.error('process rules', e))
})
