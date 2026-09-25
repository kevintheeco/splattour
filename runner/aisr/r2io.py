"""R2 I/O for the AI-SR pod job (keys come from the pod environment).
    r2io.py status '<json>' | logs | fetch | final"""
import os, sys, json, glob, time, subprocess
import boto3
from concurrent.futures import ThreadPoolExecutor
from botocore.config import Config

s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                  aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                  region_name="auto", config=Config(max_pool_connections=32))
B = "hanok360"
J = f"cloud/max/{os.environ['BENCH_JOB']}/"
A = J + os.environ.get("AI_VARIANT", "ai-x2") + "/"


def put(key, body, ct="application/json"):
    s3.put_object(Bucket=B, Key=A + key, Body=body if isinstance(body, bytes) else body.encode(), ContentType=ct)


cmd = sys.argv[1]
if cmd == "status":
    d = json.loads(sys.argv[2]); d["t"] = time.time(); put("status.json", json.dumps(d))
elif cmd == "logs":
    for f in ("job.log", "train.log", "eval.log", "setup.log"):
        p = "/workspace/" + f
        if os.path.exists(p):
            put("logs/" + f, open(p, "rb").read()[-200000:], "text/plain")
elif cmd == "fetch":
    os.makedirs("/workspace/sparse_clean", exist_ok=True)
    jobs = [(J + "sfm-A/dataset.tar", "/workspace/dataset.tar"), (J + "mcmc5m-60k-off/scene.ply", "/workspace/old.ply")]
    jobs += [(J + "sfm-A/sparse_clean/" + f, "/workspace/sparse_clean/" + f)
             for f in ("cameras.bin", "frames.bin", "images.bin", "points3D.bin", "rigs.bin")]
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda kv: s3.download_file(B, kv[0], kv[1]), jobs))
    os.makedirs("/workspace/models", exist_ok=True)
    for u in os.environ["SR_URL"].split():
        subprocess.run(["curl", "-sSfL", "-o", "/workspace/models/" + u.rsplit("/", 1)[1], u], check=True)
    print("[ai] fetched", flush=True)
elif cmd == "final":
    plys = sorted(glob.glob("/workspace/result/ply/*.ply"))
    ups = [(plys[-1], "scene.ply")] if plys else []
    ups += [(p, "stats/" + os.path.basename(p)) for p in glob.glob("/workspace/result/stats/*.json")]
    ups += [(p, "eval/" + os.path.basename(p)) for p in glob.glob("/workspace/evalout/*")]
    ups += [(p, "sr_samples/" + os.path.basename(p)) for p in sorted(glob.glob("/workspace/ds2/images/*.png"))[::40]]
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda u: s3.upload_file(u[0], B, A + u[1]), ups))
    put("status.json", json.dumps({"phase": "uploading sr tar", "t": time.time(), "uploaded": len(ups)}))
    subprocess.run("tar cf /workspace/sr_images.tar -C /workspace/ds2 images sparse", shell=True)
    s3.upload_file("/workspace/sr_images.tar", B, A + "sr_images.tar")
    put("status.json", json.dumps({"phase": "done", "t": time.time(), "uploaded": len(ups)}))
    print("[ai] final uploaded", len(ups), flush=True)
