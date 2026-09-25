#!/usr/bin/env bash
# Interactive workbench GPU server: installs SfM + gsplat, fetches the frames, then idles for SSH work.
set -u
cd /workspace
exec > >(tee -a /workspace/boot.log) 2>&1
echo "[bench] $(date -u) pod=${RUNPOD_POD_ID:-?}"
( sleep $(( ${MAX_HOURS:-12} * 3600 )); runpodctl remove pod "${RUNPOD_POD_ID:-}" ) >/dev/null 2>&1 &
( (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg libsm6 libice6 libgl1 htop >/dev/null) || echo apt failed ) &
( python -m venv /workspace/sfmenv && /workspace/sfmenv/bin/pip install -q "pycolmap-cuda12==4.2.0" numpy opencv-python-headless pillow ) &
SFM=$!
python -m pip install -q boto3 opencv-python-headless scipy pillow requests
python - <<'PY'
import os, boto3
from concurrent.futures import ThreadPoolExecutor
from botocore.config import Config
s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto",
    config=Config(max_pool_connections=64))
J = os.environ["BENCH_JOB"]; os.makedirs("/workspace/raw", exist_ok=True)
keys = []
for page in s3.get_paginator("list_objects_v2").paginate(Bucket="hanok360", Prefix=f"inbox/{J}/files/"):
    keys += [o["Key"] for o in page.get("Contents", [])]
def get(k): s3.download_file("hanok360", k, "/workspace/raw/" + k.rsplit("/", 1)[1])
with ThreadPoolExecutor(48) as ex: list(ex.map(get, keys))
print("[bench] frames", len(keys))
PY
wait $SFM
echo "[bench] sfm env ready $(date -u)"; touch /workspace/SFM_READY
bash /workspace/st/bench/gsplat_setup.sh > /workspace/gsplat_setup.log 2>&1 && touch /workspace/GSPLAT_READY
echo "[bench] gsplat ready $(date -u)"
sleep infinity
