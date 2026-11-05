#!/bin/sh
# Builds everything that goes onto the printer:
#   dist/orcax1d-armv7   static daemon binary (cross-compiled in a container)
#   web/dist/            the web UI, WASM engine and profiles (precompressed)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
./scripts/fetch-engine.sh
node scripts/build-profiles.mjs
(cd web && npm ci && npm run build)
./scripts/build-daemon.sh
echo "done: dist/orcax1d-armv7 + web/dist"
