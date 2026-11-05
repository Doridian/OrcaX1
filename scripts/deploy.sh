#!/usr/bin/env bash
# Copies a local build (orcax1d, the web UI, the init script and install.sh)
# to an X1Plus printer's SD card over root SSH, then runs install.sh there.
# For end users, the release zip + install.sh does the same without a build.
#
#   scripts/deploy.sh <printer-ip>
#
# Expects dist/orcax1d-armv7 (scripts/build-daemon.sh) and web/dist (the web
# build). Uses plain `ssh ... 'cat > file'` instead of scp, since the
# printer's SSH server may lack the SFTP subsystem that modern scp uses.
set -euo pipefail

if [ $# -ne 1 ]; then
	echo "usage: $0 <printer-ip>" >&2
	exit 1
fi
HOST=root@$1
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN=$ROOT/dist/orcax1d-armv7
WEB=$ROOT/web/dist
BASE=/mnt/sdcard/orcax1
SSH=(ssh -o ConnectTimeout=10 "$HOST")

[ -f "$BIN" ] || { echo "missing $BIN; run scripts/build-daemon.sh" >&2; exit 1; }
[ -f "$WEB/index.html" ] || { echo "missing $WEB/index.html; build the web UI first" >&2; exit 1; }

echo "==> binary"
"${SSH[@]}" "mkdir -p $BASE/state && cat > $BASE/orcax1d.new && mv $BASE/orcax1d.new $BASE/orcax1d" < "$BIN"

echo "==> web UI"
tar -C "$WEB" -cf - . | "${SSH[@]}" "rm -rf $BASE/www.new && mkdir -p $BASE/www.new && tar -xf - -C $BASE/www.new && rm -rf $BASE/www && mv $BASE/www.new $BASE/www"
(cd "$WEB" && find . -type f | sort) | "${SSH[@]}" "cat > $BASE/www.manifest"
git -C "$ROOT" describe --tags --always --dirty | "${SSH[@]}" "cat > $BASE/VERSION"

echo "==> init script + install"
"${SSH[@]}" "cat > $BASE/S99orcax1d" < "$ROOT/deploy/S99orcax1d"
"${SSH[@]}" "cat > $BASE/install.sh" < "$ROOT/deploy/install.sh"
"${SSH[@]}" "sh $BASE/install.sh"

