#!/usr/bin/env bash
# Runs on the RunPod GPU server after the start command unpacked the bundle to /workspace/st.
# Installs what the pipeline needs, then processes every pending web upload (splattour.cloudjob),
# which shuts the server down when the queue is empty.
set -u
cd /workspace
exec > >(tee -a /workspace/boot.log) 2>&1
echo "[boot] $(date -u) pod=${RUNPOD_POD_ID:-?}"
# whatever happens (a failed install included), the server removes itself on exit
trap 'echo "[boot] exit $(date -u)"; runpodctl remove pod "${RUNPOD_POD_ID:-}" >/dev/null 2>&1' EXIT
# watchdog: never run longer than MAX_HOURS, whatever happens
( sleep $(( ${MAX_HOURS:-5} * 3600 )); runpodctl remove pod "${RUNPOD_POD_ID:-}" ) >/dev/null 2>&1 &
# three installs in parallel (apt alone took 15 min on one host)
( (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg libsm6 libice6 libgl1 >/dev/null) || echo "[boot] apt install failed (ffmpeg/libSM for pycolmap)" ) &
APT=$!
# SfM in its own environment (gsplat's tools install another package named "pycolmap")
( python -m venv /workspace/sfmenv && /workspace/sfmenv/bin/pip install -q "pycolmap-cuda12==4.2.0" numpy ) &
SFM=$!
python -m pip install -q boto3 opencv-python-headless scipy pillow requests || exit 1
wait $SFM || { echo "[boot] pycolmap install failed"; exit 1; }
wait $APT
echo "[boot] installs done $(date -u)"
export SPLATTOUR_SFM_PYTHON=/workspace/sfmenv/bin/python
# vocabulary tree for photo matching, from our storage (a download from GitHub failed on a GPU host)
if [ -n "${VOCAB_URL:-}" ]; then
  mkdir -p /root/.cache/colmap && V=/root/.cache/colmap/$(basename "$VOCAB_URL")
  curl -fsSL -o "$V" "$VOCAB_URL" && export SPLATTOUR_VOCAB="$V" || echo "[boot] vocab download failed"
fi
export SPLATTOUR_PANO_SCRIPT=/workspace/st/runner/panorama_sfm.py
export SPLATTOUR_GPU=1
# faiss (vocabulary-tree search) crashed in an OpenMP worker on a many-core GPU host
export OMP_NUM_THREADS=16
mkdir -p /workspace/wheels && cp /workspace/st/wheels/*.whl /workspace/wheels/ 2>/dev/null || true
cd /workspace/st/pipeline
python -m splattour.cloudjob
echo "[boot] done $(date -u)"
