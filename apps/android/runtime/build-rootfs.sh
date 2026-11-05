#!/usr/bin/env bash
# Assemble the Alpine rootfs the app boots through proot.
#
# Contents:
#   alpine minirootfs (base userland)
#   + official Node.js linux-arm64 **musl** build under /usr/local
#   + our runtime payload under /bot  (dist/ + node_modules/ + package.json + client/)
#   + resolv.conf + a profile that puts node on PATH
#
# Why musl Node from nodejs.org instead of `apk add nodejs`: it avoids running apk
# cross-arch at build time, pins the exact version, and matches what the chroot
# build has been running on the phone.
#
# Inputs (env):
#   PAYLOAD_DIR   default: ../../packages/desktop/.mobile-payload
#   CLIENT_DIST   default: ../../packages/client/dist
#   NODE_VERSION  default: v26.13.0
# Output:
#   ../app/src/main/assets/runtime/rootfs.tgz   (consumed by the APK at first run)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PAYLOAD_DIR="${PAYLOAD_DIR:-$ROOT/packages/desktop/.mobile-payload}"
CLIENT_DIST="${CLIENT_DIST:-$ROOT/packages/client/dist}"
NODE_VERSION="${NODE_VERSION:-v26.13.0}"
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
  "https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/aarch64/alpine-minirootfs-3.22.1-aarch64.tar.gz"
tar -xzf "$WORK/mini.tar.gz" -C "$ROOTFS"

echo "== node $NODE_VERSION (musl arm64) =="
curl -fsSL --noproxy '*' -o "$WORK/node.tar.xz" \
  "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64-musl.tar.xz"
mkdir -p "$ROOTFS/usr/local"
tar -xJf "$WORK/node.tar.xz" -C "$ROOTFS/usr/local" --strip-components=1
"$ROOTFS/usr/local/bin/node" --version 2>/dev/null || {
  # The binary is aarch64-musl; a mac/linux x86_64 host cannot run it. Presence check only.
  test -f "$ROOTFS/usr/local/bin/node" || { echo "✘ node binary missing after extract"; exit 1; }
  echo "  (cross-arch binary, presence verified)"
}

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
tar -czf "$OUT/rootfs.tgz" -C "$ROOTFS" .
printf '%s\n' "$VERSION@$STAMP" > "$OUT/rootfs.version"

echo "✔ $(du -h "$OUT/rootfs.tgz" | cut -f1) → $OUT/rootfs.tgz"
