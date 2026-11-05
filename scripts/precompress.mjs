#!/usr/bin/env node
// Writes .br and .gz siblings for compressible files in a directory, so the
// daemon on the printer never compresses anything at runtime.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const dir = process.argv[2] ?? 'dist'
const EXT = /\.(js|mjs|css|html|json|wasm|svg|txt|map)$/
let saved = 0
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (!EXT.test(name)) continue
    const data = readFileSync(p)
    if (data.length < 1024) continue
    const br = brotliCompressSync(data, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_LGWIN]: 24,
        [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    })
    writeFileSync(p + '.br', br)
    writeFileSync(p + '.gz', gzipSync(data, { level: 9 }))
    saved += data.length - br.length
  }
}
walk(dir)
console.log(`precompressed ${dir}: saved ${(saved / 1e6).toFixed(1)} MB with brotli`)
