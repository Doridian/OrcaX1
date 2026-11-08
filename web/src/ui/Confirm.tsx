import { useEffect, useRef } from 'preact/hooks'
import { confirmRequest } from '../state/confirm'

export function ConfirmHost() {
  const r = confirmRequest.value
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (r && !ref.current?.open) ref.current?.showModal() }, [r])
  if (!r) return null
  const done = (ok: boolean) => {
    if (confirmRequest.value !== r) return
    confirmRequest.value = null
    r.resolve(ok)
  }
  return (
    <dialog ref={ref} class="confirm" onClose={() => done(false)}>
      <header>{r.title}</header>
      {r.body && <div class="body">{r.body}</div>}
      <footer>
        <button onClick={() => done(false)}>{r.cancel ?? 'Cancel'}</button>
        <button class={r.danger ? 'danger' : 'primary'} autoFocus onClick={() => done(true)}>{r.confirm ?? 'OK'}</button>
      </footer>
    </dialog>
  )
}
