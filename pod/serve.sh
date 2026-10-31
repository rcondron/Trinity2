#!/usr/bin/env bash
# Supervise the patched PersonaPlex server: keep it listening, and restart it if
# it crashes or is killed by an out-of-memory (the GPU runs tight in bf16, so a
# long call can OOM — a restart clears the GPU and recovers automatically).
#
#   bash pod/serve.sh            # bf16 (default, ~19 GB on a 20 GB card)
#   PP_INT8=1 bash pod/serve.sh  # int8 weights (~half the VRAM) — needs a torchao
#                                # build matching the image's torch (see README).
#
# Run it detached so it survives an SSH disconnect:
#   setsid bash pod/serve.sh >/root/pp.log 2>&1 < /dev/null &
set -uo pipefail

REPO="${PP_ROOT:-/root}/personaplex"
PORT="${PP_PORT:-8888}"
INT8=""; [ -n "${PP_INT8:-}" ] && INT8="--int8"
cd "$REPO" || exit 1

while true; do
  # Free the port if a stale server is still bound to it.
  PID="$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  if [ -n "$PID" ]; then echo "[serve] killing stale pid $PID on :$PORT"; kill "$PID" 2>/dev/null || true; sleep 3; fi

  echo "[serve] $(date -u '+%F %T') starting moshi on :$PORT ${INT8:-(bf16)}"
  python3 -m moshi.server --host 0.0.0.0 --port "$PORT" $INT8
  code=$?
  echo "[serve] $(date -u '+%F %T') moshi exited (code $code); restarting in 5s"
  sleep 5
done
