#!/usr/bin/env bash
# Supervise the patched PersonaPlex server: keep it listening, and restart it if
# it crashes or is killed by an out-of-memory (the GPU runs tight in bf16, so a
# long call can OOM — a restart clears the GPU and recovers automatically).
#
#   bash pod/serve.sh            # bf16 (default, ~19 GB on a 20 GB card)
#   PP_INT8=1 bash pod/serve.sh  # int8 weights (~half the VRAM) — needs a torchao
#                                # build matching the image's torch (see README).
#
# Normally start it with restart.sh, which stops any running supervisor first and runs
# this one detached (so it survives an SSH disconnect), logging to /root/pp.log:
#   bash pod/restart.sh
# Only one supervisor runs at a time (a second one exits): two would take turns killing
# each other's server as "stale".
set -uo pipefail

REPO="${PP_ROOT:-/root}/personaplex"
PORT="${PP_PORT:-8888}"
INT8=""; [ -n "${PP_INT8:-}" ] && INT8="--int8"
# Custom voice uploads (POST /api/voices, from patch_voices.py) need the token setup.sh made.
TOKEN_FILE="${PP_ADMIN_TOKEN_FILE:-${PP_ROOT:-/root}/pod/admin_token}"
# Single-instance lock, next to the token (restart.sh waits on the same file). moshi gets fd 9
# closed, so the lock goes away with this supervisor even if its server keeps running.
LOCK_FILE="$(dirname "$TOKEN_FILE")/serve.lock"
mkdir -p "$(dirname "$LOCK_FILE")" && exec 9>"$LOCK_FILE" || exit 1
if ! flock -n 9; then
  echo "[serve] another serve.sh is already running (lock $LOCK_FILE) — restart it with: bash $(dirname "$0")/restart.sh"
  exit 1
fi
cd "$REPO" || exit 1

while true; do
  # Free the port if a stale server is still bound to it.
  PID="$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  if [ -n "$PID" ]; then echo "[serve] killing stale pid $PID on :$PORT"; kill "$PID" 2>/dev/null || true; sleep 3; fi

  # Read on every (re)start, so a new token only needs a moshi restart. Never echoed.
  if [ -s "$TOKEN_FILE" ]; then
    PP_ADMIN_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
    export PP_ADMIN_TOKEN
  fi
  if [ -n "${PP_ADMIN_TOKEN:-}" ]; then UPLOADS="voice uploads on"; else UPLOADS="voice uploads off (no $TOKEN_FILE)"; fi

  echo "[serve] $(date -u '+%F %T') starting moshi on :$PORT ${INT8:-(bf16)}, $UPLOADS"
  python3 -m moshi.server --host 0.0.0.0 --port "$PORT" $INT8 9>&-
  code=$?
  echo "[serve] $(date -u '+%F %T') moshi exited (code $code); restarting in 5s"
  sleep 5
done
