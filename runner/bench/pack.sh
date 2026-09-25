#!/bin/bash
# pack.sh <model_dir>: dataset for gsplat from the chosen SfM model, uploaded with the SfM database for later extension
set -e
. /workspace/env.sh
M=$1
cd /workspace/st/bench
/workspace/sfmenv/bin/python make_dataset.py $M /workspace/dataset > /workspace/dataset.json
cd /workspace/dataset && tar cf /workspace/dataset.tar images sparse/0
cd /workspace
mkdir -p /workspace/keep && cp -r $M /workspace/keep/sparse_distorted && cp /workspace/sfm/_db_OPENCV_seq.db /workspace/keep/database.db
tar czf /workspace/sfm_keep.tgz -C /workspace/keep . 
python - <<'PY'
import os, boto3
s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
a = f"cloud/max/{os.environ['BENCH_JOB']}/sfm-A/"
for f, k in [("/workspace/dataset.tar", "dataset.tar"), ("/workspace/sfm_keep.tgz", "sfm_keep.tgz"), ("/workspace/dataset.json", "dataset.json"),
             ("/workspace/sfm/A_opencv/summary.json", "summary.json")]:
    s3.upload_file(f, "hanok360", a + k)
print("PACK_DONE")
PY
