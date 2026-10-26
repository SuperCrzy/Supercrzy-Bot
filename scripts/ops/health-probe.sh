#!/usr/bin/env bash
# health-probe.sh — external availability probe for the public sites.
#
# Deployed on the VPS at /opt/supercrzy-v2/health-probe.sh, cron every 5 minutes
# (/etc/cron.d/health-probe). One log line per run in /var/log/health-probe.log:
#     <ts> <code1> <code2> <code3> [ALERT consecutive=N]
#
# A target counts as UP on any 2xx/3xx/401. 000 (timeout/reset) and other
# 4xx/5xx count as failures. Two consecutive failing runs raise an ALERT
# (debounce against transient blips). Alert channel is log-only for now.
set -u

LOG=/var/log/health-probe.log
STATE=/var/tmp/health-probe.consecutive-failures
TARGETS=(
    "https://supercrzy.com"
    "https://cms.supercrzy.com"
    "https://updates.supercrzy.com/releases/latest-mac.yml"
)

ts=$(date '+%Y-%m-%d %H:%M:%S')
line="$ts"
fail=0
for url in "${TARGETS[@]}"; do
    code=$(curl -s -A "supercrzy-health-probe/1.0" -o /dev/null -w '%{http_code}' --max-time 15 "$url")
    line="$line $code"
    case "$code" in
        2*|3*|401) ;;                 # up
        *) fail=$((fail + 1)) ;;      # 000 / 403 / 404 / 5xx => down
    esac
done

prev=$(cat "$STATE" 2>/dev/null || echo 0)
if [ "$fail" -gt 0 ]; then
    n=$((prev + 1))
    echo "$n" > "$STATE"
    [ "$n" -ge 2 ] && line="$line ALERT consecutive=$n"
else
    echo 0 > "$STATE"
fi

echo "$line" >> "$LOG"
