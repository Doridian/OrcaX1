#!/usr/bin/env bash
# Cross-builds orcax1d as a static armv7 (musl, hard-float) binary for the
# Bambu Lab X1's RV1126 SoC, inside a container, and writes it to
# dist/orcax1d-armv7.
#
# Env overrides:
#   CONTAINER_ENGINE   podman or docker (default: whichever is installed, podman first)
#   ORCAX1D_BUILD_IMAGE  build image (default: messense/rust-musl-cross:armv7-musleabihf)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=armv7-unknown-linux-musleabihf
IMAGE=${ORCAX1D_BUILD_IMAGE:-docker.io/messense/rust-musl-cross:armv7-musleabihf}
ENGINE=${CONTAINER_ENGINE:-$(command -v podman || command -v docker || true)}
if [ -z "$ENGINE" ]; then
	echo "need podman or docker" >&2
	exit 1
fi

mkdir -p "$ROOT/dist" "$ROOT/build/cargo-registry"

# Rootless podman maps container root to the invoking user; with docker,
# hand the build outputs back to the caller afterwards.
FIXUP=true
if [ "$(basename "$ENGINE")" = docker ]; then
	FIXUP="chown -R $(id -u):$(id -g) /src/target/cross /root/.cargo/registry"
fi

"$ENGINE" run --rm \
	-v "$ROOT/daemon":/src:Z \
	-v "$ROOT/build/cargo-registry":/root/.cargo/registry:Z \
	-w /src \
	-e CARGO_TARGET_DIR=/src/target/cross \
	-e RUSTFLAGS="-C target-cpu=cortex-a7" \
	"$IMAGE" \
	sh -c "cargo build --release --locked --target $TARGET && $FIXUP"

OUT="$ROOT/dist/orcax1d-armv7"
cp "$ROOT/daemon/target/cross/$TARGET/release/orcax1d" "$OUT"
file "$OUT"
ls -l "$OUT"
