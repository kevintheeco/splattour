# train_bench.py <variant> <dataset_dir> <steps> <cap> <test_every> [flag ...]
# One gsplat MCMC run on this pod (same flags as the pipeline: cloud.local_trainer_args), archived to R2 cloud/max/<job>/<variant>/.
import sys, os, json, time
from pathlib import Path
sys.path.insert(0, "/workspace/st/pipeline")
from splattour.cloud import train_gsplat_local
import boto3
v, ds, steps, cap, te = sys.argv[1], Path(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
flags = sys.argv[6:]
scaler = steps // 30000 if steps > 30000 and steps % 30000 == 0 else 1
out = Path("/workspace/train") / v
s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
arch = f"cloud/max/{os.environ['BENCH_JOB']}/{v}/"
def put(obj): s3.put_object(Bucket="hanok360", Key=arch + "result.json", Body=json.dumps(obj).encode(), ContentType="application/json")
res = {"variant": v, "steps": steps, "cap": cap, "test_every": te, "flags": flags, "started": time.time()}
def progress(d):
    res["progress"] = d; print("PROGRESS", json.dumps(d), flush=True)
info = train_gsplat_local(ds, out, steps=steps, cap_max=cap, test_every=te, progress=progress, steps_scaler=scaler, extra=flags)
res["train"] = {k: v2 for k, v2 in info.items() if k != "ply"}
res["ply"] = info["ply"]
put(res)
for f in (out / "result" / "stats").glob("*.json"):
    s3.upload_file(str(f), "hanok360", arch + "stats/" + f.name)
s3.upload_file(str(out / "train.log"), "hanok360", arch + "train.log")
for f in sorted((out / "result" / "renders").glob("val_*.png"))[::3]:
    s3.upload_file(str(f), "hanok360", arch + "renders/" + f.name)
res["done"] = True; res["seconds"] = round(time.time() - res["started"]); put(res)
print("TRAIN_DONE", json.dumps(res["train"]))
