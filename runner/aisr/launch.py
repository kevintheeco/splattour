"""Launch the autonomous AI-SR retrain pod (runner/aisr/job.sh) on one RunPod GPU.
    python runner/aisr/launch.py [max_hours=5] [gpu ids, comma]
Refuses to start unless the RunPod balance covers max_hours at the pod's price plus a margin.
The pod removes itself at the end of job.sh, and in any case after max_hours."""
import io
import json
import secrets as S
import sys
import tarfile
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from splattour.cloud import IMAGE, SECRETS, RunPod, api_key, runner_env  # noqa: E402
from splattour.inbox import BUCKET, client, keys  # noqa: E402

hours = float(sys.argv[1]) if len(sys.argv) > 1 else 5
gpus = sys.argv[2].split(",") if len(sys.argv) > 2 else ["NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation", "NVIDIA GeForce RTX 4090"]
MAX_PRICE = 1.0  # $/h: hours * price is the worst case


def balance() -> float:
    r = requests.post("https://api.runpod.io/graphql", headers={"Authorization": "Bearer " + api_key()},
                      json={"query": "query { myself { clientBalance currentSpendPerHr } }"}, timeout=30)
    return r.json()["data"]["myself"]


b = balance()
print("balance", b)
if b["clientBalance"] - b["currentSpendPerHr"] * hours < hours * MAX_PRICE + 2:
    raise SystemExit("balance too low for a worst-case run plus margin")

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    for p in sorted((ROOT / "pipeline" / "splattour").glob("*.py")):
        tar.add(p, arcname=f"pipeline/splattour/{p.name}")
    for p in sorted((ROOT / "runner" / "aisr").iterdir()):
        if p.is_file():
            tar.add(p, arcname=f"aisr/{p.name}")
    for p in sorted((ROOT / "tools" / "wheels" / "pt24cu124").glob("*.whl")):
        tar.add(p, arcname=f"aisr/wheels/{p.name}")
key = f"_runner/{S.token_hex(16)}/aisr.tgz"
client(keys()).put_object(Bucket=BUCKET, Key=key, Body=buf.getvalue(), ContentType="application/gzip", CacheControl="no-cache")
adm = {k.strip(): v.strip() for k, v in (l.split("=", 1) for l in (SECRETS / "r2.txt").read_text(encoding="utf-8-sig").splitlines() if "=" in l)}
env = runner_env()
env.update(BUNDLE_URL=f"{adm['PUBLIC_URL'].rstrip('/')}/{key}", MAX_HOURS=str(int(hours)), BENCH_JOB="20260925-f0b277376aab",
           SR_MODEL="RealESRGAN_x2plus.pth", SR_URL="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth")
cmd = ('mkdir -p /workspace/st && curl -fsSL "$BUNDLE_URL" | tar xz -C /workspace/st && '
       '(bash /start.sh >/dev/null 2>&1 &) ; bash /workspace/st/aisr/job.sh')
body = {"name": "aisr-wolhajeong", "imageName": IMAGE, "gpuTypeIds": gpus, "gpuTypePriority": "custom", "gpuCount": 1,
        "containerDiskInGb": 120, "volumeInGb": 0, "ports": ["22/tcp"], "supportPublicIp": True, "cloudType": "SECURE",
        "env": {"PUBLIC_KEY": (SECRETS / "splattour_ed25519.pub").read_text().strip(), **env}, "dockerStartCmd": ["bash", "-c", cmd]}
pod = RunPod()._req("POST", "/pods", json=body)
rec = {"name": "aisr-wolhajeong", "pod": pod.get("id"), "gpu": (pod.get("machine") or {}).get("gpuDisplayName") or pod.get("gpuTypeId"),
       "cost_per_hr": pod.get("costPerHr"), "launched": time.time(), "balance_before": b["clientBalance"]}
with open(ROOT / "data" / "bench_pods.jsonl", "a") as f:
    f.write(json.dumps(rec) + "\n")
print(json.dumps(rec))
if float(pod.get("costPerHr") or 0) > MAX_PRICE:
    RunPod().delete(pod["id"])
    raise SystemExit(f"pod price {pod.get('costPerHr')} > {MAX_PRICE}: deleted")
