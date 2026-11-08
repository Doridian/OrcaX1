import { dismissNotice, processNotices } from '../state/processRules'

/** Corrections Orca's rules made to the process settings after the last change. */
export function ProcessNotices() {
  const list = processNotices.value
  if (!list.length) return null
  return (
    <div class="process-notices">
      {list.map((n) => (
        <div class="process-notice" role="status">
          <span>{n.text}</span>
          <button class="reset" title="Dismiss" onClick={() => dismissNotice(n.id)}>✕</button>
        </div>
      ))}
    </div>
  )
}
