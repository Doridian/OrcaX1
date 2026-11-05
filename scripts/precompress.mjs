#!/usr/bin/env node
// Replaces compressible files in a directory with gzipped copies (<file>.gz,
// original removed), so the printer's SD card holds and writes each asset
// once. The daemon serves the .gz as-is to clients that accept gzip (all
// browsers) and decompresses on the fly for the rest. index.html stays
// uncompressed (install checks and the SPA fallback look for it), as do
// files gzip doesn't shrink.
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const dir = process.argv[2] ?? 'dist'
const EXT = /\.(js|mjs|css|html|json|wasm|svg|txt|map)$/
let before = 0
let after = 0
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (!EXT.test(name) || (d === dir && name === 'index.html')) continue
    const data = readFileSync(p)
    const gz = gzipSync(data, { level: 9 })
    if (gz.length > data.length * 0.9) continue
    writeFileSync(p + '.gz', gz)
    unlinkSync(p)
    before += data.length
    after += gz.length
  }
}
walk(dir)
console.log(`gzipped ${dir}: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`)
