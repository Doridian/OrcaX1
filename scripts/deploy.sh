#!/usr/bin/env bash
# Installs orcax1d, the web UI and the init script on an X1Plus printer over
# root SSH, then (re)starts the service.
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

echo "==> init script"
"${SSH[@]}" "cat > /etc/init.d/S99orcax1d && chmod 755 /etc/init.d/S99orcax1d" < "$ROOT/deploy/S99orcax1d"

echo "==> restart"
"${SSH[@]}" "/etc/init.d/S99orcax1d restart; sleep 2; tail -n 5 /tmp/orcax1d.log"

echo "done: https://$1:8443/"
