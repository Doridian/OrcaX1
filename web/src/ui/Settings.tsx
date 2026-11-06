import { useEffect, useState } from 'preact/hooks'
import { ask } from '../state/confirm'
import { deleteAcmeCert, getAcme, getOidc, info, issueAcme, registerAcmeAccount, saveAcme, saveOidc, uploadUpdate, type AcmeConfig, type AcmeView, type DaemonInfo, type OidcConfig, type OidcView } from '../api'
import { auth, logout, refreshAuth } from '../state/auth'

export function Settings() {
  return (
    <div class="settings">
      <Account />
      {auth.value?.enabled && <SingleSignOn />}
      <Certificate />
      <Update />
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

function SingleSignOn() {
  const [view, setView] = useState<OidcView | null>(null)
  const [cfg, setCfg] = useState<OidcConfig | null>(null)
  const [allowed, setAllowed] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = (v: OidcView) => {
    setView(v)
    setCfg(v.config)
    setAllowed(v.config.allowed.join('\n'))
  }
  useEffect(() => { getOidc().then(load).catch((e) => setErr(e.message)) }, [])

  if (!view || !cfg) return <div class="card"><h2>Single sign-on (OpenID Connect)</h2>{err ? <div class="error">{err}</div> : <div class="muted">Loading…</div>}</div>

  const set = (patch: Partial<OidcConfig>) => { setCfg({ ...cfg, ...patch }); setSaved(false) }
  const callback = `${location.origin}${view.callback_path}`
  const save = async (clearSecret = false) => {
    setBusy(true)
    setErr(null)
    setSaved(false)
    try {
      load(await saveOidc({ ...cfg, allowed: allowed.split(/[\s,]+/).filter(Boolean) }, clearSecret))
      setSaved(true)
      refreshAuth().catch(() => {})
    } catch (e: any) { setErr(e?.message ?? String(e)) } finally { setBusy(false) }
  }

  return (
    <div class="card">
      <h2>Single sign-on (OpenID Connect)</h2>
      <p class="muted small-text">
        Log in through your identity provider (Kanidm, Authelia, Keycloak, authentik, …). Register a confidential
        client (or a public one with PKCE) with this redirect URL, and one for every other address you open the
        printer by:
      </p>
      <pre class="callback">{callback}</pre>
      {!view.available && <div class="warning small-text">The daemon was started with <code>--auth</code> leaving out <code>oidc</code>; these settings are saved but not offered on the login page.</div>}

      <div class="form-grid">
        <label>Issuer</label>
        <div>
          <input type="text" value={cfg.issuer} placeholder="https://idm.example.com/oauth2/openid/orcax1" onInput={(e) => set({ issuer: e.currentTarget.value })} />
          <div class="muted small-text">The URL in front of <code>/.well-known/openid-configuration</code>. Kanidm: <code>https://&lt;idm&gt;/oauth2/openid/&lt;client id&gt;</code>.</div>
        </div>

        <label>Client ID</label>
        <input type="text" value={cfg.client_id} onInput={(e) => set({ client_id: e.currentTarget.value })} />

        <label>Client secret</label>
        <div>
          <input type="password" autocomplete="off" value={cfg.client_secret} placeholder={view.secret_set ? '(saved, unchanged)' : 'empty for a public client'} onInput={(e) => set({ client_secret: e.currentTarget.value })} />
          {view.secret_set && <div><button disabled={busy} onClick={async () => { if (await ask({ title: 'Remove the saved client secret?', body: 'OpenID Connect will log in as a public client.', confirm: 'Remove', danger: true })) save(true) }}>Remove saved secret</button></div>}
        </div>

        <label>Scopes</label>
        <div>
          <input type="text" value={cfg.scopes} onInput={(e) => set({ scopes: e.currentTarget.value })} />
          <div class="muted small-text">Add <code>groups</code> to allow by group (the provider has to grant it).</div>
        </div>

        <label>Allowed users and groups</label>
        <div>
          <textarea rows={3} value={allowed} placeholder="anyone the provider lets through" onInput={(e) => { setAllowed(e.currentTarget.value); setSaved(false) }} />
          <div class="muted small-text">
            One per line: a username (<code>preferred_username</code>), verified email, <code>sub</code>, or an entry of the{' '}
            <code>groups</code> claim (Kanidm: <code>printer_users@idm.example.com</code>). Empty lets in everyone who can
            get a token for this client, so restrict access at the provider (Kanidm: the client's scope map) in that case.
          </div>
        </div>

        <label>Button label</label>
        <input type="text" value={cfg.label} placeholder="single sign-on" onInput={(e) => set({ label: e.currentTarget.value })} />

        <label />
        <label class="check">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
          Offer on the login page
        </label>
      </div>

      {err && <div class="error">{err}</div>}
      {saved && <div class="muted small-text">Saved. Changing the issuer, client or allow list signs out existing single sign-on sessions.</div>}
      <div class="btnrow">
        <button class="primary" disabled={busy} onClick={() => save()}>{busy ? 'Checking provider…' : 'Save'}</button>
      </div>
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
  const persistent = !!provider?.persistent
  const persist = view.persist
  // The records shown are for the saved config; edits change them only once saved.
  const unsaved = JSON.stringify(current()) !== JSON.stringify(view.config)

  return (
    <div class="card">
      <h2>HTTPS certificate (ACME)</h2>
      <p class="muted small-text">
        Gets a browser-trusted certificate from Let's Encrypt or another ACME CA, proven with a DNS TXT record (DNS-01, or
        dns-persist-01 with a record you set up once),
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

        {persistent ? <>
          <label>TXT records</label>
          <div>
            {persist?.error ? (
              <div class="error small-text">{persist.error}</div>
            ) : persist?.account && persist.records.length > 0 ? <>
              <div class="muted small-text">Add these with your DNS provider and leave them in place:</div>
              <table class="records">
                <tbody>{persist.records.map((r) => <tr><td><code>{r.name}</code></td><td>TXT</td><td><code>{r.value}</code></td></tr>)}</tbody>
              </table>
            </> : persist?.account ? (
              <div class="muted small-text">Add a domain and save to see the records.</div>
            ) : (
              <div class="muted small-text">The records name the CA account, so create it first (accepts the CA's terms of service).</div>
            )}
            {unsaved && <div class="warning small-text">Save to update the records for your changes.</div>}
            <div class="btnrow">
              <button disabled={busy || running} onClick={() => act(async () => { await saveAcme(current(), false); return registerAcmeAccount() })}>
                {persist?.account ? 'Save and show records' : 'Save and create account'}
              </button>
            </div>
          </div>
        </> : <>
          <label>DNS propagation wait</label>
          <div class="control-inline">
            <input type="number" min={0} max={900} value={cfg.propagation_seconds} onInput={(e) => set({ propagation_seconds: Math.max(0, Number(e.currentTarget.value) || 0) })} />
            <span class="unit">s</span>
          </div>
        </>}

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
        {cert && <button class="danger" disabled={busy || running} onClick={async () => { if (await ask({ title: 'Delete the certificate?', body: 'Renewal is turned off and the printer goes back to its self-signed certificate.', confirm: 'Delete', danger: true })) act(deleteAcmeCert) }}>Remove certificate</button>}
        {cert && <button disabled={busy || running} onClick={() => act(issueAcme, false)}>Renew now</button>}
      </div>
      <p class="muted small-text">
        Requesting a certificate accepts the CA's terms of service. Credentials are stored on the printer's SD card
        (<code>orcax1/state/acme/</code>); give the DNS credentials as little access as your provider allows.
      </p>
    </div>
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function Update() {
  const [inf, setInf] = useState<DaemonInfo | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'restarting'>('idle')
  const [progress, setProgress] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { info().then(setInf).catch((e) => setErr(e.message)) }, [])

  const run = async () => {
    if (!file || !inf) return
    setErr(null)
    setMsg(null)
    setProgress(0)
    setPhase('uploading')
    try {
      const r = await uploadUpdate(file, setProgress)
      setPhase('restarting')
      setMsg(`Installed ${r.version || 'the update'}; waiting for the printer to restart OrcaX1…`)
      // Wait for a daemon with a different boot id, then load the new UI.
      const deadline = Date.now() + 180e3
      while (Date.now() < deadline) {
        await sleep(2000)
        try {
          const now = await info()
          if (now.boot_id !== inf.boot_id) {
            location.reload()
            return
          }
        } catch { /* restarting */ }
      }
      throw new Error(`OrcaX1 did not come back within 3 minutes. Over SSH, check ${r.log || '/tmp/orcax1d-update.log'} and /tmp/orcax1d.log.`)
    } catch (e: any) {
      setErr(e?.message ?? String(e))
      setPhase('idle')
    }
  }

  const version = inf ? inf.release ?? `${inf.version} (no release installed)` : '…'
  return (
    <div class="card">
      <h2>Update</h2>
      <dl class="kv">
        <dt>Installed version</dt><dd>{version}</dd>
      </dl>
      {inf && !inf.update_available ? (
        <p class="muted small-text">
          Updating from here needs OrcaX1 installed on the printer with <code>install.sh</code>
          {inf.mode === 'remote' ? ' (this daemon runs in remote mode)' : ''}.
        </p>
      ) : (
        <>
          <p class="muted small-text">
            Upload a release zip (<code>orcax1-&lt;version&gt;.zip</code> from{' '}
            <a href="https://github.com/Doridian/OrcaX1/releases" target="_blank" rel="noopener">Releases</a>).
            The printer unpacks it to <code>orcax1/</code> on the SD card, keeping your settings and certificates,
            and restarts OrcaX1. A running print is not affected.
          </p>
          <div class="btnrow">
            <input type="file" accept=".zip,application/zip" disabled={phase !== 'idle'}
              onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
            <button class="primary" disabled={!file || !inf || phase !== 'idle'} onClick={run}>Install update</button>
          </div>
          {phase === 'uploading' && (
            <>
              <div class="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
              <div class="muted small-text">{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Unpacking and checking…'}</div>
            </>
          )}
          {msg && <div class="muted">{msg}</div>}
        </>
      )}
      {err && <div class="error">{err}</div>}
    </div>
  )
}
