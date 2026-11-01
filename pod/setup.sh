#!/usr/bin/env bash
# Provision a Runpod pod to serve the PATCHED PersonaPlex streaming server that
# Trinity's real-time voice loop talks to. Idempotent: safe to re-run.
#
#   HF_TOKEN=hf_xxx bash pod/setup.sh
#
# Needs: a CUDA PyTorch image (torch preinstalled), a Hugging Face token with
# access to the gated model nvidia/personaplex-7b-v1, and this script's siblings
# server.patch and patch_voices.py. Tested on runpod/pytorch:...torch280 (torch
# 2.8 / py3.12) on an RTX A4500 (20 GB). The model runs in bf16 (~19 GB); see
# --int8 note in serve.sh.
#
# Re-running it on a live pod applies new patches to the INSTALLED moshi too;
# restart serve.sh afterwards so the server picks them up.
set -euo pipefail

: "${HF_TOKEN:?Set HF_TOKEN to a Hugging Face token with access to nvidia/personaplex-7b-v1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${PP_ROOT:-/root}"
REPO="$ROOT/personaplex"
PIP="pip install -q --break-system-packages"
# Shared secret for the custom-voice upload routes; serve.sh exports it as PP_ADMIN_TOKEN.
TOKEN_FILE="${PP_ADMIN_TOKEN_FILE:-$ROOT/pod/admin_token}"

echo "== 1/6 clone PersonaPlex =="
[ -d "$REPO" ] || git clone --depth 1 https://github.com/nvidia/personaplex "$REPO"

echo "== 2/6 apply streaming patch (say/hold + raw PCM + int8) =="
if ! grep -q "paced_tokens" "$REPO/moshi/moshi/server.py"; then
  ( cd "$REPO" && patch -p1 -F5 --no-backup-if-mismatch < "$HERE/server.patch" )
fi
# sphn 0.2 renamed/removed OpusStreamWriter.read_bytes; only call it in Opus mode.
if ! grep -q 'if raw_pcm else opus_writer.read_bytes()' "$REPO/moshi/moshi/server.py"; then
  sed -i 's/msg = opus_writer.read_bytes()/msg = b"" if raw_pcm else opus_writer.read_bytes()/' \
    "$REPO/moshi/moshi/server.py"
fi
# Custom voices: POST/GET /api/voices (idempotent; exits non-zero if moshi changed shape).
python3 "$HERE/patch_voices.py" "$REPO/moshi/moshi/server.py"
# Barge-in: 0x05 drops words queued for the agent (idempotent).
python3 "$HERE/patch_flush.py" "$REPO/moshi/moshi/server.py"

echo "== 3/6 install deps (keep the image's torch/numpy) =="
$PIP huggingface_hub sphn "einops==0.7" "sentencepiece>=0.2" safetensors aiohttp accelerate pyloudnorm
# moshi itself WITHOUT deps, so it can't downgrade the image's torch 2.8 / numpy 2.x.
$PIP --no-deps "$REPO/moshi"
# The server runs the INSTALLED copy: patch that too (a no-op when pip just installed the
# patched repo, but it covers a pip that kept an older install). find_spec locates the
# package without importing it (and torch with it).
INSTALLED="$(cd / && python3 -c 'import importlib.util as u; s = u.find_spec("moshi"); print(s.submodule_search_locations[0] if s and s.submodule_search_locations else "")' 2>/dev/null || true)"
if [ -n "$INSTALLED" ] && [ -f "$INSTALLED/server.py" ]; then
  python3 "$HERE/patch_voices.py" "$INSTALLED/server.py"
  python3 "$HERE/patch_flush.py" "$INSTALLED/server.py"
else
  echo "warning: can't find the installed moshi package; custom voice uploads and barge-in flush are not set up" >&2
fi

echo "== 4/6 voice-upload admin token =="
if [ -s "$TOKEN_FILE" ]; then
  echo "keeping the existing token in $TOKEN_FILE"
else
  mkdir -p "$(dirname "$TOKEN_FILE")"
  ( umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(24))' > "$TOKEN_FILE" )
  echo "created a new token in $TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

echo "== 5/6 download weights (~17 GB, cached) =="
# Via the Python API (the huggingface-cli entry point isn't always on PATH).
python3 -c "from huggingface_hub import snapshot_download; snapshot_download('nvidia/personaplex-7b-v1', token='$HF_TOKEN')" >/dev/null

echo "== 6/6 done =="
echo "Launch the server with:  bash $HERE/serve.sh   (supervised, auto-restarts; restart it after re-running setup)"
echo "Custom voices: copy the token in $TOKEN_FILE into Trinity's Settings > Models > PersonaPlex admin token."
