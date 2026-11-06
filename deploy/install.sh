#!/bin/sh
# Installs or upgrades OrcaX1 on an X1Plus printer.
#
# 1. Unpack the release zip onto the SD card so that this file ends up at
#    /mnt/sdcard/orcax1/install.sh (put the card in a PC, or upload the
#    orcax1 folder over the printer's FTPS server).
# 2. Over SSH, as root:
#      sh /mnt/sdcard/orcax1/install.sh
#
# Run it again after unpacking a newer release to upgrade. To remove OrcaX1:
#      sh /mnt/sdcard/orcax1/install.sh uninstall

BASE=/mnt/sdcard/orcax1
# Internal flash: the binary that runs, orcax1d.conf and state/ (certificates,
# sessions, settings and their credentials). Unlike the SD card, not readable
# or writable over the printer's FTPS server.
HOME_DIR=/userdata/orcax1
INIT=/etc/init.d/S99orcax1d

die() {
	echo "error: $*" >&2
	exit 1
}

[ "$(id -u)" = 0 ] || die "run this as root"

if [ "$1" = uninstall ]; then
	[ -x "$INIT" ] && "$INIT" stop
	rm -f "$INIT" "$HOME_DIR/orcax1d"
	echo "OrcaX1 removed. Delete $BASE and $HOME_DIR to remove its files, settings and certificates too."
	exit 0
fi

[ -f "$BASE/orcax1d" ] || die "$BASE/orcax1d not found; unpack the zip to the SD card root first"
[ -f "$BASE/www/index.html" ] || die "$BASE/www is missing or incomplete"
[ -f "$BASE/S99orcax1d" ] || die "$BASE/S99orcax1d not found"

# Unpacking over an older release leaves its web files behind; remove any
# that are not part of this one.
if [ -f "$BASE/www.manifest" ]; then
	(cd "$BASE/www" && find . -type f) | while read -r f; do
		grep -qxF "$f" "$BASE/www.manifest" || rm -f "$BASE/www/$f"
	done
fi

mkdir -p "$HOME_DIR/state" || die "could not create $HOME_DIR"
chmod 700 "$HOME_DIR" "$HOME_DIR/state"
# Copied while the old one may still be running: write a new file and
# rename it over the old one. The init script then runs it from here.
cp "$BASE/orcax1d" "$HOME_DIR/orcax1d.new" && chmod 755 "$HOME_DIR/orcax1d.new" &&
	mv "$HOME_DIR/orcax1d.new" "$HOME_DIR/orcax1d" || {
	rm -f "$HOME_DIR/orcax1d.new"
	die "could not install $HOME_DIR/orcax1d"
}

cp "$BASE/S99orcax1d" "$INIT.new" && chmod 755 "$INIT.new" && mv "$INIT.new" "$INIT" ||
	die "could not write $INIT"

"$INIT" restart
sleep 2
if ! kill -0 "$(cat /var/run/orcax1d.pid 2>/dev/null)" 2>/dev/null; then
	echo "orcax1d did not stay up; log:" >&2
	tail -n 20 /tmp/orcax1d.log >&2
	exit 1
fi

echo
[ -f "$BASE/VERSION" ] && echo "OrcaX1 $(cat "$BASE/VERSION") is running. Open:"
[ -f "$BASE/VERSION" ] || echo "OrcaX1 is running. Open:"
ip -4 addr show 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | grep -v '^127\.' |
	while read -r ip; do echo "  https://$ip/"; done
echo "sign in with the LAN access code, and accept the certificate warning"
echo "(or get a trusted certificate under Settings; see the README)."
