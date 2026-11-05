import { defineConfig } from 'vite'

// During development, run `orcax1d --no-tls` (on the printer or locally
// pointed at the printer) and set ORCAX1_DAEMON to its URL to proxy the API.
const daemon = process.env.ORCAX1_DAEMON ?? 'http://127.0.0.1:8443'

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } },
  server: {
    headers: isolation,
    proxy: { '/api': { target: daemon, ws: true, secure: false, changeOrigin: true } },
  },
  preview: { headers: isolation },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
})
