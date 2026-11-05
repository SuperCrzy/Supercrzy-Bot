#!/usr/bin/env bash
# Assemble the Alpine rootfs the app boots through proot.
#
# Contents:
#   alpine minirootfs (base userland)
#   + nodejs / npm / git installed with apk.static --arch aarch64 (cross-arch)
#   + our runtime payload under /bot  (dist/ + node_modules/ + package.json + client/)
#   + resolv.conf + a root profile
#
# Why apk.static instead of nodejs.org: upstream dropped musl builds, and a glibc
# node will not run on Alpine. apk.static is a static x86_64 binary that can populate
# an aarch64 rootfs from the CDN with dependency resolution — the standard way to
# build Alpine images from a Linux CI host. (This script cannot run on macOS.)
#
# Inputs (env):
#   PAYLOAD_DIR   default: ../../packages/desktop/.mobile-payload
#   CLIENT_DIST   default: ../../packages/client/dist
# Output:
#   ../app/src/main/assets/runtime/rootfs.tgz + rootfs.version
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PAYLOAD_DIR="${PAYLOAD_DIR:-$ROOT/packages/desktop/.mobile-payload}"
CLIENT_DIST="${CLIENT_DIST:-$ROOT/packages/client/dist}"
MIRROR="https://dl-cdn.alpinelinux.org/alpine"
ALPINE_BRANCH="v3.22"
OUT="$HERE/../app/src/main/assets/runtime"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -d "$PAYLOAD_DIR" ] || { echo "✘ payload missing: $PAYLOAD_DIR (run: pnpm build:mobile-payload)"; exit 1; }
[ -d "$CLIENT_DIST" ] || { echo "✘ client dist missing: $CLIENT_DIST (run: pnpm --filter @supercrzy/client build)"; exit 1; }

mkdir -p "$OUT"
ROOTFS="$WORK/rootfs"
mkdir -p "$ROOTFS"

echo "== alpine minirootfs =="
curl -fsSL --noproxy '*' -o "$WORK/mini.tar.gz" \
  "$MIRROR/$ALPINE_BRANCH/releases/aarch64/alpine-minirootfs-3.22.1-aarch64.tar.gz"
tar -xzf "$WORK/mini.tar.gz" -C "$ROOTFS"

echo "== apk.static (x86_64, runs on the CI host) =="
APK_APK_URL="$(curl -fsSL --noproxy '*' "$MIRROR/$ALPINE_BRANCH/main/x86_64/" | grep -oE 'apk-tools-static-[0-9.r-]+\.apk' | sort -V | tail -1)"
[ -n "$APK_APK_URL" ] || { echo "✘ apk-tools-static not found on the mirror"; exit 1; }
curl -fsSL --noproxy '*' -o "$WORK/apk-tools-static.apk" "$MIRROR/$ALPINE_BRANCH/main/x86_64/$APK_APK_URL"
tar -xzf "$WORK/apk-tools-static.apk" -C "$WORK" sbin/apk.static 2>/dev/null \
  || tar -xzf "$WORK/apk-tools-static.apk" -C "$WORK"
APK="$WORK/sbin/apk.static"
[ -x "$APK" ] || { echo "✘ apk.static missing after extract"; exit 1; }

echo "== install nodejs / npm / git (aarch64) =="
"$APK" --arch aarch64 -X "$MIRROR/$ALPINE_BRANCH/main" -U \
  --root "$ROOTFS" --initdb --no-cache add nodejs npm git bash ca-certificates
"$ROOTFS/usr/bin/node" --version 2>/dev/null || true # cross-arch: presence check only
test -x "$ROOTFS/usr/bin/node" || { echo "✘ node missing after apk add"; exit 1; }
rm -rf "$ROOTFS/var/cache/apk"/*

echo "== payload + client =="
mkdir -p "$ROOTFS/bot/data"
cp -R "$PAYLOAD_DIR/dist" "$ROOTFS/bot/dist"
cp -R "$PAYLOAD_DIR/node_modules" "$ROOTFS/bot/node_modules"
cp "$PAYLOAD_DIR/package.json" "$ROOTFS/bot/package.json"
mkdir -p "$ROOTFS/bot/client"
cp -R "$CLIENT_DIST" "$ROOTFS/bot/client/dist"

echo "== base config =="
printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > "$ROOTFS/etc/resolv.conf"
cat > "$ROOTFS/root/.profile" <<'PROFILE'
export HOME=/root
export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
export TERM=xterm-256color
export LANG=C.UTF-8
PROFILE

echo "== pack =="
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAMP="$(date +%Y%m%d-%H%M%S)"
tar --format=gnu -czf "$OUT/rootfs.tgz" -C "$ROOTFS" .
printf '%s\n' "$VERSION@$STAMP" > "$OUT/rootfs.version"

echo "✔ $(du -h "$OUT/rootfs.tgz" | cut -f1) → $OUT/rootfs.tgz"
