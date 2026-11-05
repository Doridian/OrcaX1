// Login state (see docs/API.md, "Authentication").
import { signal } from '@preact/signals'

export interface AuthProvider {
  id: string
  /** 'secret': one-field form POSTed as {provider, secret}. 'redirect': navigate to `url`. */
  kind: 'secret' | 'redirect' | string
  label: string
  field?: string
  hint?: string
  url?: string
}

export interface AuthStatus {
  enabled: boolean
  authenticated: boolean
  user: { provider: string; name: string; expires: number } | null
  providers: AuthProvider[]
}

/** null until the first /api/auth/status answer. */
export const auth = signal<AuthStatus | null>(null)

const url = (p: string) => new URL(`api/auth/${p}`, document.baseURI).href

async function parse(res: Response): Promise<AuthStatus> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body as AuthStatus
}

export async function refreshAuth() {
  auth.value = await parse(await fetch(url('status')))
  return auth.value
}

export async function login(provider: string, fields: Record<string, string>) {
  auth.value = await parse(await fetch(url('login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, ...fields }),
  }))
}

export async function logout() {
  auth.value = await parse(await fetch(url('logout'), { method: 'POST' }))
}

/** Called when any API request comes back 401: the session ended. */
export function sessionExpired() {
  if (auth.value?.authenticated) refreshAuth().catch(() => {})
}
