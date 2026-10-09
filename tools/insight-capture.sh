#!/usr/bin/env bash
# insight-capture — periodic timestamped snapshot of Rodin's terminal pane, kept
# for troubleshooting/root-cause only, on a rolling 7-day window (per Jean, no
# long-term retention). One dated file per day; anything older than 7 days is
# pruned each run. Local to the box only.
set -euo pipefail
umask 077   # pane snapshots can hold anything a command printed; owner-only

PANE="${INSIGHT_PANE:-relay:0.0}"
DIR="${INSIGHT_LOG_DIR:-$HOME/vessel-writer/insight-log}"
RETAIN_DAYS="${INSIGHT_RETAIN_DAYS:-7}"

mkdir -p "$DIR"
chmod 700 "$DIR"
day="$(date +%F)"
stamp="$(date '+%Y-%m-%d %H:%M:%S %Z')"

{
  echo "===== $stamp ====="
  tmux capture-pane -t "$PANE" -p -S -200 2>/dev/null || echo "(pane $PANE unavailable)"
  echo
} >> "$DIR/$day.log"

# prune snapshots older than the rolling window
find "$DIR" -maxdepth 1 -name '*.log' -type f -mtime "+$RETAIN_DAYS" -delete 2>/dev/null || true
