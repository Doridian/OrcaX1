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

export async function startPrint(req: PrintRequest) {
  return (await check(await fetch(api('print'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
  }))).json()
}

export async function info() {
  return (await check(await fetch(api('info')))).json()
}

// ACME certificates (Settings page).

export interface AcmeField { key: string; label: string; secret: boolean; required: boolean; placeholder?: string; help?: string; options?: string[] }
export interface AcmeProvider { id: string; label: string; help: string; fields: AcmeField[] }
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

export async function deleteAcmeCert(): Promise<AcmeView> {
  return (await check(await fetch(api('acme/cert'), { method: 'DELETE' }))).json()
}
