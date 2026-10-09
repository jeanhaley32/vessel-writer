#!/usr/bin/env bash
# Run vessel-writer. Documents/blobs live under $WRITER_ROOT (default ~/vessel-log/writing).
set -euo pipefail
cd "$(dirname "$0")"
export WRITER_ROOT="${WRITER_ROOT:-$HOME/vessel-log/writing}"
export WRITER_HOST="${WRITER_HOST:-127.0.0.1}"   # the app refuses a non-loopback host without a token
exec .venv/bin/uvicorn app:app --app-dir backend --host "$WRITER_HOST" --port "${WRITER_PORT:-8791}" --timeout-graceful-shutdown 3
