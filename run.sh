#!/usr/bin/env bash
# Run vessel-writer. Configuration is environment; see the README (data defaults to ./data).
set -euo pipefail
cd "$(dirname "$0")"
export WRITER_HOST="${WRITER_HOST:-127.0.0.1}"   # the app refuses a non-loopback host without a token
exec .venv/bin/uvicorn app:app --app-dir backend --host "$WRITER_HOST" --port "${WRITER_PORT:-8791}" --timeout-graceful-shutdown 3
