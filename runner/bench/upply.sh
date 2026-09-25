#!/bin/bash
. /workspace/env.sh
python - "$1" <<'PY'
import os, sys, glob, boto3
v = sys.argv[1]
s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
p = sorted(glob.glob(f"/workspace/train/{v}/result/ply/*.ply"))[-1]
s3.upload_file(p, "hanok360", f"cloud/max/{os.environ['BENCH_JOB']}/{v}/scene.ply")
print("PLY_UP", p)
PY
