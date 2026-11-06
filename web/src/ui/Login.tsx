import { useState } from 'preact/hooks'
import { auth, login, type AuthProvider } from '../state/auth'

function SecretForm({ p }: { p: AuthProvider }) {
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try { await login(p.id, { secret }) } catch (x: any) { setErr(x?.message ?? String(x)) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} class="login-form">
      <label>
        <span>{p.field ?? p.label}</span>
        <input type="password" autocomplete="current-password" autofocus value={secret} onInput={(e) => setSecret(e.currentTarget.value)} />
      </label>
      {p.hint && <div class="muted small-text">{p.hint}</div>}
      {err && <div class="error">{err}</div>}
      <button class="primary" type="submit" disabled={busy || !secret}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  )
}

/** Set by the daemon when a redirect login (OIDC) fails: `/?login_error=…`. */
function takeRedirectError(): string | null {
  const q = new URLSearchParams(location.search)
  const e = q.get('login_error')
  if (e === null) return null
  q.delete('login_error')
  const rest = q.toString()
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash)
  return e
}

export function Login() {
  const providers = auth.value?.providers ?? []
  const [redirectErr] = useState(takeRedirectError)
  return (
    <div class="login">
      <div class="card">
        <div class="brand">Orca<span>X1</span></div>
        {redirectErr && <div class="error">Sign-in failed: {redirectErr}</div>}
        {providers.map((p, i) => (
          <>
            {i > 0 && <div class="login-or muted">or</div>}
            {p.kind === 'secret' && <SecretForm p={p} />}
            {p.kind === 'redirect' && p.url && <a href={p.url}><button class="primary" style={{ width: '100%' }}>Sign in with {p.label}</button></a>}
          </>
        ))}
        {!providers.length && <div class="error">No login methods are configured.</div>}
      </div>
    </div>
  )
}
