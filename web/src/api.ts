// REST calls to orcax1d (see docs/API.md).

const api = (path: string) => new URL(`api/${path}`, document.baseURI).href

async function check(res: Response) {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try { const t = await res.text(); if (t) msg += `: ${t}` } catch { /* ignore */ }
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
      } else reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText}`))
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
