#!/usr/bin/env bash
# Provision a Runpod pod to serve the PATCHED PersonaPlex streaming server that
# Trinity's real-time voice loop talks to. Idempotent: safe to re-run.
#
#   HF_TOKEN=hf_xxx bash pod/setup.sh
#
# Needs: a CUDA PyTorch image (torch preinstalled), a Hugging Face token with
# access to the gated model nvidia/personaplex-7b-v1, and this script's sibling
# server.patch. Tested on runpod/pytorch:...torch280 (torch 2.8 / py3.12) on an
# RTX A4500 (20 GB). The model runs in bf16 (~19 GB); see --int8 note in serve.sh.
set -euo pipefail

: "${HF_TOKEN:?Set HF_TOKEN to a Hugging Face token with access to nvidia/personaplex-7b-v1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${PP_ROOT:-/root}"
REPO="$ROOT/personaplex"
PIP="pip install -q --break-system-packages"

echo "== 1/5 clone PersonaPlex =="
[ -d "$REPO" ] || git clone --depth 1 https://github.com/nvidia/personaplex "$REPO"

echo "== 2/5 apply streaming patch (say/hold + raw PCM + int8) =="
if ! grep -q "paced_tokens" "$REPO/moshi/moshi/server.py"; then
  ( cd "$REPO" && patch -p1 -F5 --no-backup-if-mismatch < "$HERE/server.patch" )
fi
# sphn 0.2 renamed/removed OpusStreamWriter.read_bytes; only call it in Opus mode.
if ! grep -q 'if raw_pcm else opus_writer.read_bytes()' "$REPO/moshi/moshi/server.py"; then
  sed -i 's/msg = opus_writer.read_bytes()/msg = b"" if raw_pcm else opus_writer.read_bytes()/' \
    "$REPO/moshi/moshi/server.py"
fi

echo "== 3/5 install deps (keep the image's torch/numpy) =="
$PIP huggingface_hub sphn "einops==0.7" "sentencepiece>=0.2" safetensors aiohttp accelerate pyloudnorm
# moshi itself WITHOUT deps, so it can't downgrade the image's torch 2.8 / numpy 2.x.
$PIP --no-deps "$REPO/moshi"

echo "== 4/5 download weights (~17 GB, cached) =="
# Via the Python API (the huggingface-cli entry point isn't always on PATH).
python3 -c "from huggingface_hub import snapshot_download; snapshot_download('nvidia/personaplex-7b-v1', token='$HF_TOKEN')" >/dev/null

echo "== 5/5 done =="
echo "Launch the server with:  bash $HERE/serve.sh   (supervised, auto-restarts)"
