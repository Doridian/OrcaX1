// The outlet device's address, remembered in this browser so the offline
// page (served by the service worker while the printer is off) knows where
// to send the user. The setting itself lives in orcax1d.
const KEY = 'orcax1.outletDevice'

export function cachedDeviceUrl(): string | null {
  try {
    return localStorage.getItem(KEY) || null
  } catch {
    return null
  }
}

export function cacheDeviceUrl(url: string | null) {
  try {
    if (url) localStorage.setItem(KEY, url)
    else localStorage.removeItem(KEY)
  } catch {}
}
