import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

// Emits sw.js from sw.template.js with the offline page (outlet.html) and the
// assets it references as the precache list. The list changes whenever any of
// those files' hashes do, so browsers pick up a new worker with each build
// that changes the offline page.
function serviceWorker(): Plugin {
  return {
    name: 'orcax1-sw',
    apply: 'build',
    generateBundle: {
      // After Vite's own HTML plugin has emitted outlet.html.
      order: 'post',
      handler(_, bundle) {
        const page = bundle['outlet.html']
        if (!page || page.type !== 'asset') throw new Error('outlet.html missing from the bundle')
        const html = String(page.source)
        const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
        // CSS can pull in further files (fonts, images) of its own.
        for (const ref of [...refs]) {
          const css = bundle[ref.slice(1)]
          if (css?.type === 'asset' && ref.endsWith('.css')) {
            for (const m of String(css.source).matchAll(/url\(["']?(\/assets\/[^"')]+)/g)) refs.push(m[1])
          }
        }
        const precache = ['/outlet.html', ...new Set(refs)]
        const version = createHash('sha256').update(html).update(precache.join('\n')).digest('hex').slice(0, 16)
        const source = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8')
          .replace('__PRECACHE__', JSON.stringify(precache))
          .replace('__VERSION__', JSON.stringify(version))
        this.emitFile({ type: 'asset', fileName: 'sw.js', source })
      },
    },
  }
}

// During development, run `orcax1d --no-tls` (on the printer or locally
// pointed at the printer) and set ORCAX1_DAEMON to its URL to proxy the API.
const daemon = process.env.ORCAX1_DAEMON ?? 'http://127.0.0.1:8443'

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export default defineConfig({
  plugins: [serviceWorker()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } },
  server: {
    headers: isolation,
    // The daemon refuses state-changing and WebSocket requests from another
    // origin, so present the proxied ones as coming from the daemon itself.
    proxy: { '/api': { target: daemon, ws: true, secure: false, changeOrigin: true, headers: { origin: new URL(daemon).origin } } },
  },
  preview: { headers: isolation },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rolldownOptions: { input: { main: 'index.html', outlet: 'outlet.html' } },
  },
})
