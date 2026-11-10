// OrcaX1 service worker (template: vite.config.ts fills in the precache
// list and emits it as /sw.js).
//
// Its only job is the "printer is off" page: it keeps outlet.html and its
// assets cached, and serves that page for navigations when the printer
// doesn't answer. That page sends the browser on to the outlet device's own
// page to switch the printer on (docs/OUTLET.md).
// Everything else goes to the network untouched; the app itself (and the
// multi-megabyte slicer engine) is not cached for offline use.
const PRECACHE = __PRECACHE__
const CACHE = `orcax1-offline-${__VERSION__}`
const OFFLINE_PAGE = '/outlet.html'
// How long a navigation may take before the offline page is shown instead.
// That page keeps checking and loads the app as soon as the printer answers.
const NAVIGATE_TIMEOUT_MS = 8000

const abs = (p) => new URL(p, self.registration.scope).href
const precached = new Set(PRECACHE.map(abs))

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.addAll(PRECACHE.map((p) => new Request(abs(p), { cache: 'reload' })))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('orcax1-offline-') && key !== CACHE) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    event.respondWith(navigate(req))
  } else if (precached.has(url.href)) {
    // Hashed, immutable assets of the offline page.
    event.respondWith(caches.match(req, { cacheName: CACHE }).then((r) => r ?? fetch(req)))
  }
})

async function navigate(req) {
  const net = fetch(req)
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NAVIGATE_TIMEOUT_MS, null) })
  try {
    const res = await Promise.race([net, timeout])
    if (res) return res
  } catch {
    // Network error: the printer is off or unreachable.
  } finally {
    clearTimeout(timer)
  }
  net.catch(() => {})
  const offline = await caches.match(abs(OFFLINE_PAGE), { cacheName: CACHE })
  return offline ?? net
}
