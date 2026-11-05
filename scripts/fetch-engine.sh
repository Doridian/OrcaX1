#!/bin/sh
# Downloads the OrcaSlicer WASM engine (https://github.com/Hiosdra/OrcaWeb)
# into web/public/engine/.
set -eu
TAG="${ORCA_WASM_TAG:-wasm-v2.4.2-patch29-multithreaded}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/web/public/engine"
mkdir -p "$OUT"
for f in slicer-mt.js slicer-mt.wasm; do
  if [ ! -s "$OUT/$f" ] || [ "$(cat "$OUT/.tag" 2>/dev/null)" != "$TAG" ]; then
    echo "fetching $f ($TAG)"
    curl -fsSL -o "$OUT/$f.tmp" "https://github.com/Hiosdra/OrcaWeb/releases/download/$TAG/$f"
    mv "$OUT/$f.tmp" "$OUT/$f"
  fi
done
echo "$TAG" > "$OUT/.tag"
