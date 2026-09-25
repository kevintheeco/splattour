#!/bin/bash
# fetch_train.sh <variant> <steps> <cap> <test_every> [flags...]
set -e
. /workspace/env.sh
if [ ! -f /workspace/dataset/sparse/0/images.bin ]; then
python - <<'PY'
import os, boto3
s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
s3.download_file("hanok360", f"cloud/max/{os.environ['BENCH_JOB']}/sfm-A/dataset.tar", "/workspace/dataset.tar")
PY
mkdir -p /workspace/dataset && tar xf /workspace/dataset.tar -C /workspace/dataset
fi
cd /workspace/st/bench
python train_bench.py $1 /workspace/dataset "${@:2}"
