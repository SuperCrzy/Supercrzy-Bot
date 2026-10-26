#!/usr/bin/env bash
# vps-fetch.sh — download a large file via the US VPS relay instead of the
# slow direct route from mainland China.
#
# Measured 2026-10-23: local -> GitHub Artifacts ~50 KB/s (80 min for 334MB);
# VPS -> same artifact 8.1 MB/s (43 s). Only useful for FOREIGN sources —
# mainland mirrors (npmmirror etc.) are already fast locally.
#
# Usage:
#   scripts/vps-fetch.sh <url> [-o <local-dir>] [--keep-on-vps]
#
# Options:
#   -o <dir>        local destination directory (default: current directory)
#   --keep-on-vps   leave the file on the VPS (/root/fetch-tmp) instead of
#                   rsyncing it back
#
# Env (read from repo .env when present):
#   VPS_TARGET  e.g. root@1.2.3.4            (required)
#   GH_TOKEN    optional; sent as an Authorization header for api.github.com
#               URLs. Passed through ssh argv only — never written to disk.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
[ -f "$here/.env" ] && . "$here/.env"
: "${VPS_TARGET:?set VPS_TARGET=root@host in .env}"

url=""
dest="."
keep=0
while [ $# -gt 0 ]; do
    case "$1" in
        -o) dest="$2"; shift 2 ;;
        --keep-on-vps) keep=1; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) url="$1"; shift ;;
    esac
done
[ -n "$url" ] || { echo "usage: $0 <url> [-o dir] [--keep-on-vps]" >&2; exit 1; }

REMOTE_DIR=/root/fetch-tmp
fname=$(basename "${url%%\?*}")
[ -n "$fname" ] || { echo "cannot derive a filename from the url" >&2; exit 1; }

# GitHub artifact/API downloads need a token; everything else is fetched bare.
auth_header=""
case "$url" in
    https://api.github.com/*)
        if [ -n "${GH_TOKEN:-}" ]; then
            auth_header="-H 'Authorization: Bearer ${GH_TOKEN}'"
        else
            echo "warning: api.github.com url without GH_TOKEN — may 404" >&2
        fi
        ;;
esac

echo "[1/3] downloading on VPS: $fname"
# shellcheck disable=SC2086
ssh -o BatchMode=yes "$VPS_TARGET" \
    "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR && cd $REMOTE_DIR && \
     curl -sL --max-time 3600 $auth_header \
       -o '$fname' \
       -w 'speed: %{speed_download} B/s | size: %{size_download}B | time: %{time_total}s\n' \
       '$url'"

if [ "$keep" -eq 1 ]; then
    echo "[2/3] kept on VPS: $REMOTE_DIR/$fname (clean it up yourself: ssh $VPS_TARGET rm -rf $REMOTE_DIR)"
    exit 0
fi

echo "[2/3] rsync back to $dest/"
mkdir -p "$dest"
rsync -a -e "ssh -o BatchMode=yes" \
    "$VPS_TARGET:$REMOTE_DIR/$fname" "$dest/"

echo "[3/3] verifying md5..."
local_md5=$(md5 -q "$dest/$fname" 2>/dev/null || md5sum "$dest/$fname" | cut -d' ' -f1)
remote_md5=$(ssh -o BatchMode=yes "$VPS_TARGET" "md5sum '$REMOTE_DIR/$fname' | cut -d' ' -f1")
if [ "$local_md5" != "$remote_md5" ]; then
    echo "MD5 MISMATCH local=$local_md5 remote=$remote_md5" >&2
    exit 1
fi
echo "md5 OK: $local_md5"

ssh -o BatchMode=yes "$VPS_TARGET" "rm -rf $REMOTE_DIR"
echo "done: $dest/$fname (VPS temp cleaned)"
