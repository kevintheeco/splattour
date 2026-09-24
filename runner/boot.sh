#!/usr/bin/env bash
# Runs on the RunPod GPU server after the start command unpacked the bundle to /workspace/st.
# Installs what the pipeline needs, then processes every pending web upload (splattour.cloudjob),
# which shuts the server down when the queue is empty.
set -u
cd /workspace
exec > >(tee -a /workspace/boot.log) 2>&1
echo "[boot] $(date -u) pod=${RUNPOD_POD_ID:-?}"
# watchdog: never run longer than MAX_HOURS, whatever happens
( sleep $(( ${MAX_HOURS:-5} * 3600 )); runpodctl remove pod "${RUNPOD_POD_ID:-}" ) >/dev/null 2>&1 &
python -m pip install -q boto3 opencv-python-headless scipy pillow requests || exit 1
(apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null) || echo "[boot] ffmpeg install failed (videos will fail)"
# SfM in its own environment (gsplat's tools install another package named "pycolmap")
python -m venv /workspace/sfmenv && /workspace/sfmenv/bin/pip install -q "pycolmap-cuda12==4.2.0" numpy || exit 1
export SPLATTOUR_SFM_PYTHON=/workspace/sfmenv/bin/python
export SPLATTOUR_PANO_SCRIPT=/workspace/st/runner/panorama_sfm.py
export SPLATTOUR_GPU=1
mkdir -p /workspace/wheels && cp /workspace/st/wheels/*.whl /workspace/wheels/ 2>/dev/null || true
cd /workspace/st/pipeline
python -m splattour.cloudjob
echo "[boot] done $(date -u)"
runpodctl remove pod "${RUNPOD_POD_ID:-}" >/dev/null 2>&1 || true
