import { useEffect, useState } from 'preact/hooks'
import { deleteAcmeCert, getAcme, issueAcme, saveAcme, type AcmeConfig, type AcmeView } from '../api'
import { auth, logout } from '../state/auth'

export function Settings() {
  return (
    <div class="settings">
      <Account />
      <Certificate />
    </div>
  )
}

function Account() {
  const a = auth.value
  return (
    <div class="card">
      <h2>Account</h2>
      {a?.enabled ? (
        <>
          <dl class="kv">
            <dt>Signed in with</dt><dd>{a.user?.name ?? '—'}</dd>
            {a.user && <><dt>Session expires</dt><dd>{new Date(a.user.expires * 1000).toLocaleString()}</dd></>}
          </dl>
          <div class="btnrow"><button onClick={() => logout()}>Sign out</button></div>
        </>
      ) : (
        <div class="warning">Authentication is disabled (<code>--auth none</code>): anyone who can reach this page controls the printer.</div>
      )}
    </div>
  )
}

const fmtDate = (t: number) => new Date(t * 1000).toLocaleString()

function Certificate() {
  const [view, setView] = useState<AcmeView | null>(null)
  const [cfg, setCfg] = useState<AcmeConfig | null>(null)
  const [domains, setDomains] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (v: AcmeView, resetForm: boolean) => {
    setView(v)
    if (resetForm) {
      setCfg(v.config)
      setDomains(v.config.domains.join('\n'))
    }
  }
  useEffect(() => { getAcme().then((v) => load(v, true)).catch((e) => setErr(e.message)) }, [])
  // Follow a running request.
  const running = !!view?.status.running
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => getAcme().then((v) => load(v, false)).catch(() => {}), 2000)
    return () => clearInterval(t)
  }, [running])

  if (!view || !cfg) return <div class="card"><h2>HTTPS certificate</h2>{err ? <div class="error">{err}</div> : <div class="muted">Loading…</div>}</div>

  const set = (patch: Partial<AcmeConfig>) => setCfg({ ...cfg, ...patch })
  const setDns = (k: string, v: string) => setCfg({ ...cfg, dns: { ...cfg.dns, [k]: v } })
  const provider = view.providers.find((p) => p.id === cfg.dns_provider)
  const preset = view.directories.find((d) => d.url === cfg.directory)
  const custom = !preset
  const showEab = custom || preset?.eab || !!cfg.eab_kid
  const secretSet = (k: string) => view.secrets_set.includes(k) && view.config.dns_provider === cfg.dns_provider

  const act = async (f: () => Promise<AcmeView>, resetForm = true) => {
    setBusy(true)
    setErr(null)
    try { load(await f(), resetForm) } catch (e: any) { setErr(e?.message ?? String(e)) } finally { setBusy(false) }
  }
  const current = () => ({ ...cfg, domains: domains.split(/[\s,]+/).filter(Boolean) })
  const st = view.status
  const cert = view.cert
  const daysLeft = cert ? Math.floor((cert.not_after * 1000 - Date.now()) / 86400e3) : 0

  return (
    <div class="card">
      <h2>HTTPS certificate (ACME)</h2>
      <p class="muted small-text">
        Gets a browser-trusted certificate from Let's Encrypt or another ACME CA, proven with a DNS TXT record (DNS-01),
        so the printer never has to be reachable from the internet. Point the domain at the printer's LAN address in your
        DNS, then open <code>https://&lt;domain&gt;{location.port ? `:${location.port}` : ''}/</code>. Access by IP address keeps using the
        self-signed certificate.
      </p>
      {!view.tls && <div class="warning small-text">The daemon is running without TLS (<code>--no-tls</code>); a certificate is saved but not served until TLS is enabled.</div>}

      <div class="cert-status">
        {cert ? (
          <dl class="kv">
            <dt>Current certificate</dt><dd>{cert.domains.join(', ')}</dd>
            <dt>Expires</dt><dd class={daysLeft < 14 ? 'warning' : ''}>{fmtDate(cert.not_after)} ({daysLeft} days)</dd>
            <dt>Issued</dt><dd>{fmtDate(cert.issued_at)}</dd>
          </dl>
        ) : <div class="muted">No certificate yet.</div>}
        {st.last_error && !st.running && <div class="error small-text">Last attempt ({st.last_attempt ? fmtDate(st.last_attempt) : '?'}) failed: {st.last_error}</div>}
        {(st.running || st.log.length > 0) && (
          <details open={st.running || !!st.last_error}>
            <summary>{st.running ? 'Requesting certificate…' : 'Log of the last request'}</summary>
            <div class="log">{st.log.map(([t, m]) => <div>{new Date(t * 1000).toLocaleTimeString()} {m}</div>)}</div>
          </details>
        )}
      </div>

      <div class="form-grid">
        <label>Domains</label>
        <div>
          <textarea rows={2} value={domains} placeholder="printer.example.com" onInput={(e) => setDomains(e.currentTarget.value)} />
          <div class="muted small-text">One per line. Wildcards like <code>*.lan.example.com</code> work.</div>
        </div>

        <label>Certificate authority</label>
        <div>
          <select value={custom ? '' : cfg.directory} onChange={(e) => set({ directory: e.currentTarget.value || 'https://' })}>
            {view.directories.map((d) => <option value={d.url}>{d.label}</option>)}
            <option value="">Custom ACME directory…</option>
          </select>
          {custom && <input type="text" value={cfg.directory} placeholder="https://ca.example.com/acme/directory" onInput={(e) => set({ directory: e.currentTarget.value })} />}
        </div>

        {showEab && <>
          <label>EAB key ID</label>
          <input type="text" value={cfg.eab_kid} onInput={(e) => set({ eab_kid: e.currentTarget.value })} placeholder={preset?.eab ? 'required by this CA' : 'only if the CA requires it'} />
          <label>EAB HMAC key</label>
          <input type="password" autocomplete="off" value={cfg.eab_hmac} onInput={(e) => set({ eab_hmac: e.currentTarget.value })} placeholder={view.secrets_set.includes('eab_hmac') ? '(saved, unchanged)' : ''} />
        </>}

        <label>Email</label>
        <div>
          <input type="text" value={cfg.email} placeholder="optional" onInput={(e) => set({ email: e.currentTarget.value })} />
          <div class="muted small-text">For the CA's account (expiry notices, if the CA sends them).</div>
        </div>

        <label>DNS provider</label>
        <div>
          <select value={cfg.dns_provider} onChange={(e) => set({ dns_provider: e.currentTarget.value, dns: {} })}>
            {view.providers.map((p) => <option value={p.id}>{p.label}</option>)}
          </select>
          {provider && <div class="muted small-text">{provider.help}</div>}
        </div>

        {provider?.fields.map((f) => <>
          <label>{f.label}</label>
          <div>
            {f.options ? (
              <select value={cfg.dns[f.key] || f.options[0]} onChange={(e) => setDns(f.key, e.currentTarget.value)}>
                {f.options.map((o) => <option value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                type={f.secret ? 'password' : 'text'}
                autocomplete="off"
                value={cfg.dns[f.key] ?? ''}
                placeholder={f.secret && secretSet(`dns.${f.key}`) ? '(saved, unchanged)' : (f.placeholder ?? (f.required ? '' : 'optional'))}
                onInput={(e) => setDns(f.key, e.currentTarget.value)}
              />
            )}
            {f.help && <div class="muted small-text">{f.help}</div>}
          </div>
        </>)}

        <label>DNS propagation wait</label>
        <div class="control-inline">
          <input type="number" min={0} max={900} value={cfg.propagation_seconds} onInput={(e) => set({ propagation_seconds: Math.max(0, Number(e.currentTarget.value) || 0) })} />
          <span class="unit">s</span>
        </div>

        <label />
        <label class="check">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
          Renew automatically (30 days before expiry; also requests one when the domains change)
        </label>
      </div>

      {err && <div class="error">{err}</div>}
      <div class="btnrow">
        <button disabled={busy || running} onClick={() => act(() => saveAcme(current(), false))}>Save</button>
        <button class="primary" disabled={busy || running} onClick={() => act(() => saveAcme(current(), true))}>Save and request certificate</button>
        <span class="spacer" />
        {cert && <button class="danger" disabled={busy || running} onClick={() => { if (confirm('Delete the certificate and turn off renewal? The printer goes back to its self-signed certificate.')) act(deleteAcmeCert) }}>Remove certificate</button>}
        {cert && <button disabled={busy || running} onClick={() => act(issueAcme, false)}>Renew now</button>}
      </div>
      <p class="muted small-text">
        Requesting a certificate accepts the CA's terms of service. Credentials are stored on the printer's SD card
        (<code>orcax1/state/acme/</code>); give the DNS credentials as little access as your provider allows.
      </p>
    </div>
  )
}
