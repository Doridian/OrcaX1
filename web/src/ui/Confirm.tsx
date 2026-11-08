import { useEffect, useRef } from 'preact/hooks'
import { confirmRequest, type Choice } from '../state/confirm'

export function ConfirmHost() {
  const r = confirmRequest.value
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (r && !ref.current?.open) ref.current?.showModal() }, [r])
  if (!r) return null
  const done = (c: Choice) => {
    if (confirmRequest.value !== r) return
    confirmRequest.value = null
    r.resolve(c)
  }
  return (
    <dialog ref={ref} class="confirm" onClose={() => done('cancel')}>
      <header>{r.title}</header>
      {r.body && <div class={typeof r.body === 'string' ? 'body pre-line' : 'body'}>{r.body}</div>}
      <footer>
        <button onClick={() => done('cancel')}>{r.cancel ?? 'Cancel'}</button>
        {r.alt && <button onClick={() => done('alt')}>{r.alt}</button>}
        <button class={r.danger ? 'danger' : 'primary'} autoFocus onClick={() => done('confirm')}>{r.confirm ?? 'OK'}</button>
      </footer>
    </dialog>
  )
}
