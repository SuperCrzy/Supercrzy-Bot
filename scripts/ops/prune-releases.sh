#!/usr/bin/env bash
# prune-releases.sh — remove old release artifacts from the updates mirror.
#
# Runs on the VPS (deployed to /opt/supercrzy-v2/prune-releases.sh, weekly cron).
# Keeps the newest KEEP versions of installers/blockmaps; never touches
# latest-mac.yml / latest.yml (and their .bak-* backups are only pruned when
# older than KEEP days... they are NOT pruned here — see note below).
#
# Usage: prune-releases.sh [--apply]
#   (default) dry-run: prints what would be deleted, logs the plan
#   --apply        : actually deletes and logs the result
#
# Safety:
#   - aborts without deleting anything if no version can be parsed from filenames
#   - every delete is rm -f on an explicit full path, no wildcards
set -u

KEEP="${KEEP:-2}"
REL_DIR="${REL_DIR:-/opt/supercrzy-v2/updates-releases/releases}"
LOG=/var/log/prune-releases.log
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

[ -d "$REL_DIR" ] || { echo "releases dir not found: $REL_DIR" >&2; exit 1; }

ts=$(date '+%Y-%m-%d %H:%M:%S')

# Collect every version token that appears in filenames, e.g.
#   "SUPERCRZY BOT-1.2.2-arm64.dmg", "SUPERCRZY BOT Setup 1.2.2.exe"
versions=$(ls "$REL_DIR" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -uV)
if [ -z "$versions" ]; then
    echo "$ts ABORT: no versions parsed from filenames, deleting nothing" >> "$LOG"
    echo "ABORT: no versions parsed from filenames" >&2
    exit 1
fi

# Newest KEEP versions stay; head -n -K drops the last K lines (GNU coreutils,
# which is what the VPS runs).
keep_list=$(printf '%s\n' "$versions" | tail -n "$KEEP")
delete_list=$(printf '%s\n' "$versions" | head -n -"$KEEP")

if [ -z "$delete_list" ]; then
    echo "$ts nothing to prune (keeping: $(printf '%s' "$keep_list" | tr '\n' ' '))" >> "$LOG"
    echo "nothing to prune (keeping: $(printf '%s' "$keep_list" | tr '\n' ' '))"
    exit 0
fi

# Match concrete files (never latest*.yml) whose embedded version is in delete_list.
files=$(ls "$REL_DIR" | grep -v '^latest' | while IFS= read -r f; do
    v=$(printf '%s' "$f" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)
    [ -n "$v" ] || continue
    if printf '%s\n' "$delete_list" | grep -qx "$v"; then
        printf '%s\n' "$f"
    fi
done)

echo "Versions found: $(printf '%s' "$versions" | tr '\n' ' ')"
echo "Keeping       : $(printf '%s' "$keep_list" | tr '\n' ' ')"
echo "Deleting      :"
printf '%s\n' "$files"

if [ "$APPLY" -eq 1 ]; then
    count=0
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        rm -f -- "$REL_DIR/$f"
        count=$((count + 1))
    done <<EOF2
$files
EOF2
    usage=$(du -sh "$REL_DIR" 2>/dev/null | cut -f1)
    echo "$ts applied: deleted $count files, releases dir now $usage" >> "$LOG"
    echo "APPLIED: deleted $count files, releases dir now $usage"
else
    echo "$ts dry-run: would delete $(printf '%s' "$files" | grep -c .) files" >> "$LOG"
    echo "(dry-run: pass --apply to delete)"
fi
