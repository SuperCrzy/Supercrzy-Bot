#!/usr/bin/env bash
# Fetch proot for arm64 Android and place it where Gradle packages native libs.
#
# Why Termux's build: proot upstream publishes x86/static builds, but Android needs
# a bionic-linked arm64 binary, and Termux's is exactly that — built for this OS,
# patched for the quirks (no /bin/sh, seccomp), and reproducible from their apt repo.
#
# Android 10+ blocks execve of files in app-writable storage, so the binary must be
# packaged as a "native library" (jniLibs/libproot.so): the system extracts it to
# nativeLibraryDir with the exec bit, and we exec it from there.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/jniLibs/arm64-v8a"
mkdir -p "$OUT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== fetch termux proot (aarch64) =="
INDEX="$(curl -fsSL --noproxy '*' https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages)"
REL="$(printf '%s' "$INDEX" | awk -v RS='' '/^Package: proot$/{print; exit}' | sed -n 's/^Filename: //p')"
[ -n "$REL" ] || { echo "✘ proot not found in termux index"; exit 1; }
URL="https://packages.termux.dev/apt/termux-main/$REL"
echo "  $URL"
curl -fsSL --noproxy '*' -o "$WORK/proot.deb" "$URL"

echo "== extract =="
cd "$WORK"
ar x proot.deb
tar xf data.tar.xz ./data/data/com.termux/files/usr/bin/proot 2>/dev/null \
  || tar xf data.tar.xz 2>/dev/null
BIN="$(find "$WORK" -type f -path '*usr/bin/proot' | head -1)"
[ -n "$BIN" ] || { echo "✘ proot binary not found inside the deb"; exit 1; }

# The ELF must keep its interpreter-free bionic linkage; sanity-check the magic.
[ "$(head -c 4 "$BIN" | od -An -tx1 | tr -d ' ')" = "7f454c46" ] || { echo "✘ not an ELF"; exit 1; }

cp "$BIN" "$OUT/libproot.so"
echo "✔ $(du -h "$OUT/libproot.so" | cut -f1) → $OUT/libproot.so"
