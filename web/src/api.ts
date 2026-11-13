// REST calls to orcax1d (see docs/API.md).
import { sessionExpired } from './state/auth'

const api = (path: string) => new URL(`api/${path}`, document.baseURI).href

async function check(res: Response) {
  if (!res.ok) {
    if (res.status === 401) sessionExpired()
    let msg = `${res.status} ${res.statusText}`
    try {
      const t = await res.text()
      if (t) { try { msg = JSON.parse(t).error ?? `${msg}: ${t}` } catch { msg += `: ${t}` } }
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res
}

export interface FileEntry { name: string; is_dir: boolean; size: number; mtime: number }

export async function listFiles(path: string): Promise<FileEntry[]> {
  return (await check(await fetch(api(`files?path=${encodeURIComponent(path)}`)))).json()
}

export async function deleteFile(path: string) {
  await check(await fetch(api(`files?path=${encodeURIComponent(path)}`), { method: 'DELETE' }))
}

export function downloadUrl(path: string) {
  return api(`files/download?path=${encodeURIComponent(path)}`)
}

/** PUT with upload progress (fetch has no upload progress). */
export function uploadFile(path: string, data: Uint8Array | Blob, onProgress?: (fraction: number) => void): Promise<{ path: string; size: number; md5: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', api(`files/upload?path=${encodeURIComponent(path)}`))
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) } catch { resolve({ path, size: 0, md5: '' }) }
      } else {
        if (xhr.status === 401) sessionExpired()
        reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText}`))
      }
    }
    xhr.onerror = () => reject(new Error('upload failed: network error'))
    xhr.send(data instanceof Blob ? data : new Blob([data as BlobPart]))
  })
}

export interface PrintRequest {
  path: string
  plate: number
  use_ams: boolean
  ams_mapping: number[]
  timelapse: boolean
  bed_leveling: boolean
  flow_cali: boolean
  vibration_cali: boolean
  layer_inspect: boolean
  bed_type: string
}

export type PrintOptions = Pick<PrintRequest, 'bed_leveling' | 'flow_cali' | 'vibration_cali' | 'layer_inspect' | 'timelapse'>

/** OrcaSlicer's defaults for an X1: leveling and flow calibration on, first-layer
 *  inspection on (the printer's own setting still decides), no vibration calibration. */
export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  bed_leveling: true, flow_cali: true, vibration_cali: false, layer_inspect: true, timelapse: false,
}

const OPTIONS_KEY = 'orcax1.printOptions'

/** The options last used to start a print, like Orca remembers them per printer. */
export function loadPrintOptions(): PrintOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}')
    const out = { ...DEFAULT_PRINT_OPTIONS }
    for (const k of Object.keys(out) as (keyof PrintOptions)[]) if (typeof saved?.[k] === 'boolean') out[k] = saved[k]
    return out
  } catch { return { ...DEFAULT_PRINT_OPTIONS } }
}

export function savePrintOptions(o: PrintOptions) {
  try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(o)) } catch { /* private mode */ }
}

export async function startPrint(req: PrintRequest) {
  return (await check(await fetch(api('print'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
  }))).json()
}

export interface DaemonInfo {
  name: string
  version: string
  /** The installed release (VERSION file), null when not installed from a release. */
  release: string | null
  /** Changes whenever the daemon restarts. */
  boot_id: number
  /** Whether a release zip can be uploaded to update (the daemon runs on the printer). */
  update_available: boolean
  serial: string | null
  mqtt_connected: boolean
  camera_available: boolean
  camera_error: string | null
  mode: 'local' | 'remote'
  sd_dir: string
}

export async function info(): Promise<DaemonInfo> {
  return (await check(await fetch(api('info'), { cache: 'no-store' }))).json()
}

/** Uploads a release zip; the daemon installs it and restarts (202 when accepted). */
export function uploadUpdate(zip: Blob, onProgress?: (fraction: number) => void): Promise<{ version: string; log: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', api('update'))
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) } catch { resolve({ version: '', log: '' }) }
      } else {
        if (xhr.status === 401) sessionExpired()
        let msg = `${xhr.status} ${xhr.statusText}`
        try { msg = JSON.parse(xhr.responseText).error ?? msg } catch { /* not JSON */ }
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('upload failed: network error'))
    xhr.send(zip)
  })
}

// ACME certificates (Settings page).

export interface AcmeField { key: string; label: string; secret: boolean; required: boolean; placeholder?: string; help?: string; options?: string[] }
/** `persistent`: dns-persist-01, records set up by hand (see `AcmeView.persist`). `single_value`: one TXT value per name. */
export interface AcmeProvider { id: string; label: string; help: string; fields: AcmeField[]; persistent: boolean; single_value: boolean }
export interface AcmeConfig {
  enabled: boolean
  directory: string
  email: string
  domains: string[]
  eab_kid: string
  eab_hmac: string
  dns_provider: string
  dns: Record<string, string>
  propagation_seconds: number
}
export interface AcmeView {
  config: AcmeConfig
  /** Secrets that are saved but not sent back: "eab_hmac", "dns.<key>". */
  secrets_set: string[]
  providers: AcmeProvider[]
  directories: { label: string; url: string; eab: boolean }[]
  /** Whether the daemon serves HTTPS (so a certificate can be used). */
  tls: boolean
  cert: { domains: string[]; directory: string; issued_at: number; not_after: number } | null
  status: { running: boolean; last_attempt: number | null; last_success: number | null; last_error: string | null; log: [number, string][] }
  /** With a persistent provider saved: the ACME account URL (null before it is created) and the TXT records to add. */
  persist: { account: string | null; records: { name: string; value: string }[]; error: string | null } | null
}

export async function getAcme(): Promise<AcmeView> {
  return (await check(await fetch(api('acme')))).json()
}

export async function saveAcme(config: AcmeConfig, issue: boolean): Promise<AcmeView> {
  return (await check(await fetch(api('acme'), {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, issue }),
  }))).json()
}

export async function issueAcme(): Promise<AcmeView> {
  return (await check(await fetch(api('acme/issue'), { method: 'POST' }))).json()
}

/** Creates (or loads) the ACME account for the saved config. */
export async function registerAcmeAccount(): Promise<AcmeView> {
  return (await check(await fetch(api('acme/account'), { method: 'POST' }))).json()
}

export async function deleteAcmeCert(): Promise<AcmeView> {
  return (await check(await fetch(api('acme/cert'), { method: 'DELETE' }))).json()
}

export interface OidcConfig {
  enabled: boolean
  label: string
  issuer: string
  client_id: string
  /** Always empty when read back; see `OidcView.secret_set`. */
  client_secret: string
  scopes: string
  /** ID token claim names (dotted paths reach into nested objects). */
  user_id_claim: string
  username_claim: string
  groups_claim: string
  /** Matched against the user id and username claims. */
  allowed_users: string[]
  /** Matched against the groups claim. Both lists empty: anyone. */
  allowed_groups: string[]
}
export interface OidcView {
  config: OidcConfig
  secret_set: boolean
  /** false when `--auth` leaves out `oidc`. */
  available: boolean
  callback_path: string
}

export async function getOidc(): Promise<OidcView> {
  return (await check(await fetch(api('oidc')))).json()
}

/** An empty client_secret keeps the saved one unless `clearSecret`. */
export async function saveOidc(config: OidcConfig, clearSecret = false): Promise<OidcView> {
  return (await check(await fetch(api('oidc'), {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, clear_secret: clearSecret }),
  }))).json()
}
