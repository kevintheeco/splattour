import sys, io, tarfile, json, time, secrets as S
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "pipeline"))
from pathlib import Path
from splattour.cloud import RunPod, IMAGE, runner_env, SECRETS, ROOT
from splattour.inbox import BUCKET
from r2 import s3
name = sys.argv[1]; hours = int(sys.argv[2]) if len(sys.argv) > 2 else 12
gpus = sys.argv[3].split(",") if len(sys.argv) > 3 else ["NVIDIA H100 80GB HBM3", "NVIDIA H100 NVL", "NVIDIA H100 PCIe", "NVIDIA A100-SXM4-80GB", "NVIDIA A100 80GB PCIe", "NVIDIA H200"]
buf = io.BytesIO()
here = Path(__file__).parent
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    for p in sorted((ROOT / "pipeline" / "splattour").rglob("*.py")):
        if "__pycache__" not in p.parts:
            tar.add(p, arcname=f"pipeline/{p.relative_to(ROOT / 'pipeline').as_posix()}")
    for f in [p for p in here.iterdir() if p.is_file()]:
        tar.add(f, arcname=f"bench/{f.name}")
keyf = SECRETS / "runner_bundle_bench.txt"
key = keyf.read_text().strip() if keyf.exists() else f"_runner/{S.token_hex(16)}/bench.tgz"
keyf.write_text(key)
s3.put_object(Bucket=BUCKET, Key=key, Body=buf.getvalue(), ContentType="application/gzip", CacheControl="no-cache")
env = runner_env()
adm = {k.strip(): v.strip() for k, v in (l.split("=", 1) for l in (SECRETS / "r2.txt").read_text(encoding="utf-8-sig").splitlines() if "=" in l)}
env.update(BUNDLE_URL=f"{adm['PUBLIC_URL'].rstrip('/')}/{key}", MAX_HOURS=str(hours), BENCH_JOB="20260925-f0b277376aab")
cmd = ('mkdir -p /workspace/st && curl -fsSL "$BUNDLE_URL" | tar xz -C /workspace/st && '
       '(bash /start.sh >/dev/null 2>&1 &) ; bash /workspace/st/bench/bench_boot.sh')
body = {"name": f"bench-{name}", "imageName": IMAGE, "gpuTypeIds": gpus, "gpuTypePriority": "custom", "gpuCount": 1,
        "containerDiskInGb": 300, "volumeInGb": 0, "ports": ["22/tcp"], "supportPublicIp": True, "cloudType": "SECURE",
        "env": {"PUBLIC_KEY": (SECRETS / "splattour_ed25519.pub").read_text().strip(), **env}, "dockerStartCmd": ["bash", "-c", cmd]}
pod = RunPod()._req("POST", "/pods", json=body)
rec = {"name": name, "pod": pod.get("id"), "gpu": (pod.get("machine") or {}).get("gpuDisplayName") or pod.get("gpuTypeId"), "cost_per_hr": pod.get("costPerHr"), "launched": time.time()}
with open(ROOT / "data" / "bench_pods.jsonl", "a") as f: f.write(json.dumps(rec) + "\n")
print(rec)
