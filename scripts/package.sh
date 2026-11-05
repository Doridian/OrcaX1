#!/bin/sh
# Packages a release zip, dist/orcax1-<version>.zip, holding an orcax1/
# folder to unpack at the SD card root:
#   orcax1/orcax1d       daemon (from dist/orcax1d-armv7)
#   orcax1/www/          web UI (from web/dist)
#   orcax1/S99orcax1d    init script
#   orcax1/install.sh    run over SSH to install/upgrade
#
#   scripts/package.sh [version]     (default: git describe)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="${1:-$(git describe --tags --always --dirty)}"
[ -f dist/orcax1d-armv7 ] || { echo "missing dist/orcax1d-armv7; run scripts/build-daemon.sh" >&2; exit 1; }
[ -f web/dist/index.html ] || { echo "missing web/dist; build the web UI first" >&2; exit 1; }

STAGE="$ROOT/build/package"
rm -rf "$STAGE"
mkdir -p "$STAGE/orcax1"
cp dist/orcax1d-armv7 "$STAGE/orcax1/orcax1d"
cp -R web/dist "$STAGE/orcax1/www"
cp deploy/S99orcax1d deploy/install.sh "$STAGE/orcax1/"
echo "$VERSION" > "$STAGE/orcax1/VERSION"
(cd "$STAGE/orcax1/www" && find . -type f | sort) > "$STAGE/orcax1/www.manifest"

OUT="$ROOT/dist/orcax1-$VERSION.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -q -r -X "$OUT" orcax1)
ls -l "$OUT"
