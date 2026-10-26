#!/usr/bin/env bash
# release-publish.sh — one-command release publishing (manual release checklist
# sections 11.3-11.4, automated).
#
# What it does:
#   1 preflight       version/tag/release-notes/site page sanity checks
#   2 token           read the GitHub token via git credential fill (in-memory only)
#   3 artifacts       list GitHub Actions artifacts, pick newest mac + windows
#   4 vps-fetch       download + unzip both artifacts on the US VPS (8.1 MB/s
#                     vs 50 KB/s local; see manual section 5.3.1)
#   5 publish         back up old latest*.yml, copy 8 files into the releases
#                     dir, create/reuse the GitHub Release, upload dmg/zip/exe
#                     as assets from the VPS
#   6 bot.html        rewrite the old version string in a LOCAL copy of the
#                     site page, print a diff; only uploaded with
#                     --publish-bot-html (explicit human gate)
#   7 cleanup         rm -rf the VPS temp dir
#   8 verify          all 8 published files must answer over HTTPS
#                     (binaries: HTTP 206, yml: HTTP 200)
#
# Usage:
#   scripts/release-publish.sh <version> [--dry-run] [--publish-bot-html] [--force]
#
# Notes:
#   - git tag/push (checklist 11.1-11.2) stay manual; run this AFTER CI is green.
#   - mobile deployment (checklist 11.5) stays manual (needs USB adb).
#   - VPS target comes from .env (VPS_TARGET=...) — never committed.
set -euo pipefail

REPO="SuperCrzy/Supercrzy-Bot"
REL_DIR="/opt/supercrzy-v2/updates-releases/releases"
WORK="/root/artifacts"
PUBLIC="https://updates.supercrzy.com/releases"
SITE_BOT_HTML="${SITE_BOT_HTML:-$(cd "$(dirname "$0")/../.." && pwd)/SUPERCRZY-v2/bot.html}"

here=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
[ -f "$here/.env" ] && . "$here/.env"
: "${VPS_TARGET:?set VPS_TARGET=root@host in .env}"

VER=""
DRY_RUN=0
PUBLISH_BOT_HTML=0
BOT_ONLY=0
FORCE=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --publish-bot-html) PUBLISH_BOT_HTML=1 ;;
        --publish-bot-html-only) BOT_ONLY=1; PUBLISH_BOT_HTML=1 ;;
        --force) FORCE=1 ;;
        -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
        *) VER="$arg" ;;
    esac
done

log()  { printf '\n=== %s ===\n' "$1"; }
die()  { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

# ssh with one retry — the cross-border link occasionally stalls (observed
# 2026-10-24: banner exchange timeouts on a dead VPN node).
vssh() {
    local attempt=1 rc=0
    while [ $attempt -le 2 ]; do
        if ssh -o BatchMode=yes -o ConnectTimeout=15 "$VPS_TARGET" "$@"; then
            return 0
        fi
        rc=$?
        echo "ssh attempt $attempt failed (rc=$rc), retrying..." >&2
        attempt=$((attempt + 1))
        sleep 3
    done
    return "$rc"
}

# ---------------------------------------------------------------------------
log "1/8 preflight"
[ -n "$VER" ] || die "usage: $0 <version> [--dry-run] [--publish-bot-html] [--force]"
case "$VER" in
    *[!0-9.]*) die "version must be digits and dots, got: $VER" ;;
esac

pkg_ver=$(node -p "require('$here/package.json').version")
if [ "$pkg_ver" != "$VER" ] && [ "$FORCE" -ne 1 ]; then
    die "package.json version ($pkg_ver) != requested version ($VER); bump first or pass --force"
fi

if [ "$BOT_ONLY" -eq 0 ]; then
    if ! git -C "$here" ls-remote --tags origin "refs/tags/v${VER}" | grep -q .; then
        die "tag v${VER} not found on origin — push the tag and wait for CI first"
    fi

    notes_file="$here/docs/release-notes/v${VER}.md"
    [ -f "$notes_file" ] || die "release notes missing: docs/release-notes/v${VER}.md"
fi

# ---------------------------------------------------------------------------
log "2/8 token (in-memory only, never written to disk)"
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' \
    | git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2-)
[ -n "$TOKEN" ] || die "could not read a GitHub token via git credential fill"

api() { # api <method> <path> [jq-filter]
    local method="$1" path="$2" filter="${3:-.}"
    curl -s --max-time 60 -X "$method" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$REPO/$path" | jq -r "$filter"
}

# ---------------------------------------------------------------------------
log "3/8 artifacts (newest mac + windows)"
if [ "$BOT_ONLY" -eq 1 ]; then
    echo "(--publish-bot-html-only: skipping artifact phases)"
else
arts=$(curl -s --max-time 60 \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/actions/artifacts?per_page=100")

MAC_ID=$(printf '%s' "$arts" | jq -r '[.artifacts[] | select(.expired==false) | select(.name | test("mac|darwin|osx"; "i"))] | sort_by(.created_at) | last | .id // empty')
WIN_ID=$(printf '%s' "$arts" | jq -r '[.artifacts[] | select(.expired==false) | select(.name | test("win|nsis|exe"; "i"))] | sort_by(.created_at) | last | .id // empty')
[ -n "$MAC_ID" ] || die "no mac artifact found in the latest 100"
[ -n "$WIN_ID" ] || die "no windows artifact found in the latest 100"

printf '%s\n' "$arts" | jq -r --arg m "$MAC_ID" --arg w "$WIN_ID" \
    '.artifacts[] | select((.id|tostring)==$m or (.id|tostring)==$w) | "\(.name)\t\(.id)\t\(.created_at)\t\(.size_in_bytes)"'
printf 'MAC_ID=%s WIN_ID=%s\n' "$MAC_ID" "$WIN_ID"

if [ "$DRY_RUN" -eq 1 ]; then
    echo "(dry-run: stopping before any download or publish)"
    exit 0
fi
fi  # BOT_ONLY gate for phase 3-5

if [ "$BOT_ONLY" -eq 0 ]; then

# ---------------------------------------------------------------------------
log "4/8 vps-fetch: download + unzip on VPS"
vssh "rm -rf $WORK && mkdir -p $WORK/mac $WORK/win"
vssh "GH_TOKEN='$TOKEN' MAC_ID='$MAC_ID' bash -s" <<'EOS'
set -euo pipefail
curl -sL --retry 2 --max-time 900 \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -o mac.zip \
    -w "mac: %{speed_download} B/s | %{size_download}B | %{time_total}s\n" \
    "https://api.github.com/repos/SuperCrzy/Supercrzy-Bot/actions/artifacts/$MAC_ID/zip"
unzip -o -q mac.zip && rm mac.zip
EOS
vssh "GH_TOKEN='$TOKEN' WIN_ID='$WIN_ID' bash -s" <<'EOS'
set -euo pipefail
curl -sL --retry 2 --max-time 900 \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -o win.zip \
    -w "win: %{speed_download} B/s | %{size_download}B | %{time_total}s\n" \
    "https://api.github.com/repos/SuperCrzy/Supercrzy-Bot/actions/artifacts/$WIN_ID/zip"
unzip -o -q win.zip && rm win.zip
EOS

# sanity: latest-mac.yml must contain the dmg entry (Actions-built yml does,
# a locally-produced zip build does not — manual section 5.4 / 11.3).
vssh "YML=\$(find $WORK/mac -name 'latest-mac.yml' | head -1); test -n \"\$YML\" && grep -q dmg \"\$YML\" || { echo 'latest-mac.yml missing or has no dmg entry (wrong yml?)' >&2; exit 1; }"
vssh "ls -l $WORK/mac $WORK/win | grep -vE '^total|^d'"

# ---------------------------------------------------------------------------
log "5/8 publish: yml backup -> 8 files -> GitHub Release"
vssh "PUB_VER='$VER' bash -s" <<'EOS'
set -euo pipefail
REL_DIR="/opt/supercrzy-v2/updates-releases/releases"
ts=$(date +%Y%m%d-%H%M%S)
for f in latest-mac.yml latest.yml; do
    [ -f "$REL_DIR/$f" ] && cp -a "$REL_DIR/$f" "$REL_DIR/$f.bak-$ts"
done
MAC_DIR=$(find /root/artifacts/mac -name '*.dmg' | head -1 | xargs dirname)
WIN_DIR=$(find /root/artifacts/win -name '*.exe' | head -1 | xargs dirname)
cp -v "$MAC_DIR/SUPERCRZY BOT-$PUB_VER-arm64.dmg"         "$REL_DIR/"
cp -v "$MAC_DIR/SUPERCRZY BOT-$PUB_VER-arm64.dmg.blockmap"     "$REL_DIR/"
cp -v "$MAC_DIR/SUPERCRZY BOT-$PUB_VER-arm64-mac.zip"         "$REL_DIR/"
cp -v "$MAC_DIR/SUPERCRZY BOT-$PUB_VER-arm64-mac.zip.blockmap" "$REL_DIR/"
cp -v "$MAC_DIR/latest-mac.yml"                              "$REL_DIR/"
cp -v "$WIN_DIR/SUPERCRZY BOT Setup $PUB_VER.exe"            "$REL_DIR/"
cp -v "$WIN_DIR/SUPERCRZY BOT Setup $PUB_VER.exe.blockmap"   "$REL_DIR/"
cp -v "$WIN_DIR/latest.yml"                                  "$REL_DIR/"
EOS

NOTES_B64=$(base64 < "$notes_file" | tr -d '\n')
rel_json=$(vssh "PUB_VER='$VER' NOTES_B64='$NOTES_B64' GH_TOKEN='$TOKEN' bash -s" <<'EOS'
set -euo pipefail
body=$(printf '%s' "$NOTES_B64" | base64 -d)
payload=$(python3 -c 'import json,sys;print(json.dumps({"tag_name":"v"+sys.argv[1],"name":"v"+sys.argv[1],"body":sys.argv[2]}))' "$PUB_VER" "$body")
code=$(curl -s -o /tmp/rel.json -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "$payload" \
    "https://api.github.com/repos/SuperCrzy/Supercrzy-Bot/releases")
if [ "$code" = "422" ]; then
    # already exists -> reuse
    curl -s -H "Authorization: Bearer $GH_TOKEN" \
        "https://api.github.com/repos/SuperCrzy/Supercrzy-Bot/releases/tags/v$PUB_VER" > /tmp/rel.json
fi
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("id",""))' /tmp/rel.json
EOS
) || die "release create/reuse failed"
[ -n "$rel_json" ] && [ "$rel_json" != "null" ] || die "could not resolve a GitHub Release id"
REL_ID="$rel_json"
echo "release id: $REL_ID"

vssh "REL_ID='$REL_ID' PUB_VER='$VER' GH_TOKEN='$TOKEN' bash -s" <<'EOS'
set -euo pipefail
cd /root/artifacts
# mac + win dirs still hold the artifacts; re-locate the binaries
DMG=$(find mac -name "SUPERCRZY BOT-$PUB_VER-arm64.dmg" | head -1)
ZIP=$(find mac -name "SUPERCRZY BOT-$PUB_VER-arm64-mac.zip" | head -1)
EXE=$(find win -name "SUPERCRZY BOT Setup $PUB_VER.exe" | head -1)
for f in "$DMG" "$ZIP" "$EXE"; do
    base=$(basename "$f")
    enc=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$base")
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $GH_TOKEN" \
        -H "Content-Type: application/octet-stream" \
        --data-binary @"$f" \
        "https://uploads.github.com/repos/SuperCrzy/Supercrzy-Bot/releases/$REL_ID/assets?name=$enc")
    echo "$base: HTTP $code"
    [ "$code" = "201" ] || exit 1
done
EOS
fi  # BOT_ONLY gate for phases 4-5

# ---------------------------------------------------------------------------
log "6/8 bot.html (local rewrite + diff; upload gated by --publish-bot-html)"
[ -f "$SITE_BOT_HTML" ] || die "site page not found: $SITE_BOT_HTML (set SITE_BOT_HTML to override)"
old_ver=$(grep -oE 'BOT-[0-9]+\.[0-9]+\.[0-9]+' "$SITE_BOT_HTML" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
[ -n "$old_ver" ] || die "could not detect the current version in bot.html"
tmp_html=$(mktemp)
sed "s/$old_ver/$VER/g" "$SITE_BOT_HTML" > "$tmp_html"
replaced=$(diff -U0 "$SITE_BOT_HTML" "$tmp_html" | grep -c '^+[^+]' || true)
echo "bot.html: $old_ver -> $VER, $replaced changed lines"
if [ "$replaced" -eq 0 ]; then
    echo "nothing to change in bot.html (already at $VER?)"
    rm -f "$tmp_html"
else
    diff -u "$SITE_BOT_HTML" "$tmp_html" || true
    if [ "$PUBLISH_BOT_HTML" -eq 1 ]; then
        cp "$tmp_html" "$SITE_BOT_HTML"
        scp -o BatchMode=yes "$SITE_BOT_HTML" "$VPS_TARGET:/opt/supercrzy-v2/bot.html"
        echo "bot.html uploaded"
    else
        echo "(temp copy kept at $tmp_html — review the diff, then run:"
        echo "  scripts/release-publish.sh $VER --publish-bot-html-only)"
    fi
fi

# ---------------------------------------------------------------------------
log "7/8 cleanup"
vssh "rm -rf $WORK && echo 'VPS temp dir removed'"

# ---------------------------------------------------------------------------
log "8/8 verify (binaries 206, yml 200)"
fail=0
check() {
    code=$(curl -s -o /dev/null -w '%{http_code}' -L -r 0-1023 --max-time 20 "$1")
    printf '%-58s %s\n' "$2" "$code"
    case "$3" in
        206) [ "$code" = "206" ] || fail=1 ;;
        200) [ "$code" = "200" ] || fail=1 ;;
    esac
}
check "$PUBLIC/SUPERCRZY%20BOT-$VER-arm64.dmg"                 "dmg"           206
check "$PUBLIC/SUPERCRZY%20BOT-$VER-arm64.dmg.blockmap"        "dmg.blockmap"  206
check "$PUBLIC/SUPERCRZY%20BOT-$VER-arm64-mac.zip"             "zip"           206
check "$PUBLIC/SUPERCRZY%20BOT-$VER-arm64-mac.zip.blockmap"    "zip.blockmap"  206
check "$PUBLIC/SUPERCRZY%20BOT%20Setup%20$VER.exe"             "exe"           206
check "$PUBLIC/SUPERCRZY%20BOT%20Setup%20$VER.exe.blockmap"    "exe.blockmap"  206
check "$PUBLIC/latest-mac.yml"                                 "latest-mac.yml" 200
check "$PUBLIC/latest.yml"                                     "latest.yml"     200
[ "$fail" -eq 0 ] || die "verification FAILED — see codes above (latest*.yml backups are on the VPS)"
echo "ALL CHECKS PASSED — v$VER published"
