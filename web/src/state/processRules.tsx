// Connects Orca's process rules (slicer/configRules.ts) to the selection:
// after the user changes a process value, the rules may correct other values,
// ask (state/confirm.ts) or leave a notice for the process panel.
//
// Orca also runs the print tab's update() on its own (TabPrint::update, the
// same checks without a changed key):
//   - when a process preset is loaded, which includes the printer switch and
//     startup (Tab::load_current_preset);
//   - when filaments are added or removed (Sidebar::add_filament /
//     delete_filament), which clamps the support filaments to the new count;
//   - after some printer changes (single-extruder multi-material, purge in
//     prime tower; see slicer/printerRules.ts).
// Here that is `queueProcessUpdate`, run by an effect for the first three.
// The stock presets pass it unchanged and without questions
// (scripts/config-rules-check.mjs checks every X1 process on every printer),
// so loading the page asks nothing unless saved overrides contradict each
// other, which Orca would also flag on load.
import { effect } from '@preact/signals'
import { newRuleState, processChanged, processUpdate, type FilamentInfo, type RuleHost } from '../slicer/configRules'
import { ask } from './confirm'
import { clearNotices, notify } from './notices'
import { objects } from './project'
import { bundle, currentPrinter, onProcessChange, processScalar, sel, settingsMode, writeProcessScalar } from './settings'

const state = newRuleState()
let queue: Promise<void> = Promise.resolve()

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const isTrue = (v: string) => v === '1' || v === 'true'

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
    printer: { ...(currentPrinter.value?.settings ?? {}), ...sel.value.printerOverrides },
    filaments: fils,
    usedFilamentTypes: () => objects.value.map((o) => fils[o.filament]?.type ?? 'PLA'),
    simpleMode: settingsMode.value === 0,
    ask: (q) => ask({ title: q.title, body: <p class="pre-line">{q.body}</p>, confirm: q.yes, cancel: q.no }),
    notify,
  }
}

function enqueue(job: () => Promise<void>) {
  queue = queue.then(job).catch((e) => console.error('process rules', e))
  return queue
}

/** Runs TabPrint::update() on the current selection, after any rules still running. */
export function queueProcessUpdate() {
  return enqueue(() => processUpdate(host(), state))
}

onProcessChange((key, prev) => {
  enqueue(async () => {
    clearNotices()
    await processChanged(key, prev, host(), state)
  })
})

/** Starts running the process update on preset load, printer switch and filament count changes. */
export function initProcessRules() {
  let last = ''
  effect(() => {
    if (!bundle.value) return
    const s = sel.value
    const sig = `${s.printer}|${s.process}|${s.filaments.length}`
    if (sig === last) return
    const loaded = !last.startsWith(`${s.printer}|${s.process}|`)
    last = sig
    if (loaded) {
      // TabPrint::update's support_material_overhangs_queried starts out set
      // for a saved user preset with support on and overhang detection off,
      // so loading one doesn't turn the detection back on.
      state.overhangsQueried = Object.keys(s.processOverrides).length > 0
        && isTrue(processScalar('enable_support')) && !isTrue(processScalar('detect_overhang_wall'))
    }
    queueProcessUpdate()
  })
}
