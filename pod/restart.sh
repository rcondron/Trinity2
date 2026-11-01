#!/usr/bin/env bash
# Restart the supervised PersonaPlex server (e.g. after re-running setup.sh), detached so
# it survives the SSH session:
#
#   bash /root/pod/restart.sh
#
# Processes are matched on their WHOLE command line (anchored), so this never kills the
# shell that runs it (a plain `pkill -f serve.sh` would match `bash -c '... serve.sh ...'`).
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="${PP_LOG:-/root/pp.log}"
# serve.sh's single-instance lock (next to the admin token, as serve.sh computes it).
TOKEN_FILE="${PP_ADMIN_TOKEN_FILE:-${PP_ROOT:-/root}/pod/admin_token}"
LOCK_FILE="$(dirname "$TOKEN_FILE")/serve.lock"

# Supervisors however they were started (`bash pod/serve.sh`, `bash /root/pod/serve.sh`,
# `./serve.sh`): a bash whose command line ENDS with its serve.sh path. Never this shell
# or its parent (e.g. the SSH session's `bash -c '...'`).
supervisors() { pgrep -f '^([^ ]*/)?bash( -[^ ]+)* ([^ ]*/)?serve\.sh$' | grep -vx -e "$$" -e "$PPID"; }
kill_supervisors() {
  local pids
  pids="$(supervisors)"
  [ -n "$pids" ] && kill "$@" $pids 2>/dev/null
}

kill_supervisors
pkill -f "^python3 -m moshi\.server( |$)" 2>/dev/null
sleep 4
# Anything that ignored SIGTERM, plus torch helpers the server leaves behind.
kill_supervisors -9
pkill -9 -f "^python3 -m moshi\.server( |$)" 2>/dev/null
pkill -9 -f "^/usr/bin/python3 .*/torch/_inductor/compile_worker/" 2>/dev/null
pkill -9 -x addr2line 2>/dev/null
# The old supervisor's lock goes once its last child (at most a `sleep 5`) has exited.
mkdir -p "$(dirname "$LOCK_FILE")"
flock -w 15 "$LOCK_FILE" true || echo "warning: $LOCK_FILE is still locked — the new serve.sh will refuse to start" >&2
sleep 2

echo "----- restart $(date -u '+%F %T')" >> "$LOG"
setsid bash "${HERE}/serve.sh" >> "$LOG" 2>&1 < /dev/null &
echo "restarted (log: $LOG) — the model takes ~1 minute to load and warm up"
