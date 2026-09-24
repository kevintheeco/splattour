"""Thesis-quality training on a rented CUDA GPU (RunPod), fully automatic.

    rent pod → upload dataset (tar over ssh) → install gsplat → train
    (MCMC densification, anti-aliasing, bilateral-grid exposure correction,
    full resolution) → download .ply + eval stats → ALWAYS terminate the pod.

The laptop only needs ssh/tar (built into Windows 11). Credentials:
    secrets/runpod.txt          RunPod API key (one line)
    secrets/splattour_ed25519   ssh key, public half is passed to the pod
The pod is deleted in a `finally`, and a watchdog on the pod removes it
after `max_hours` even if this machine loses power mid-run.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Callable

import requests

ROOT = Path(__file__).resolve().parents[2]
SECRETS = ROOT / "secrets"
API = "https://rest.runpod.io/v1"
IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"
# Preference order: 24 GB+ cards that train a 4M-splat room in well under an hour.
GPU_TYPES = ["NVIDIA GeForce RTX 4090", "NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation", "NVIDIA RTX A6000",
             "NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB", "NVIDIA GeForce RTX 5090"]


def api_key() -> str:
    p = SECRETS / "runpod.txt"
    key = p.read_text(encoding="utf-8").strip() if p.exists() else ""
    if not key:
        raise RuntimeError("RunPod API 키가 없습니다: secrets/runpod.txt")
    return key


class RunPod:
    def __init__(self, key: str | None = None):
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {key or api_key()}"

    def _req(self, method: str, path: str, **kw):
        r = self.s.request(method, API + path, timeout=60, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"RunPod {method} {path} → {r.status_code}: {r.text[:500]}")
        return r.json() if r.text else {}

    def create_pod(self, name: str, public_key: str, disk_gb: int = 120, community: bool = False) -> dict:
        body = {
            "name": name,
            "imageName": IMAGE,
            "gpuTypeIds": GPU_TYPES,
            "gpuTypePriority": "custom",
            "gpuCount": 1,
            "containerDiskInGb": disk_gb,
            "volumeInGb": 0,
            "ports": ["22/tcp"],
            "supportPublicIp": True,
            "cloudType": "COMMUNITY" if community else "SECURE",
            "env": {"PUBLIC_KEY": public_key},
        }
        return self._req("POST", "/pods", json=body)

    def pod(self, pod_id: str) -> dict:
        return self._req("GET", f"/pods/{pod_id}")

    def delete(self, pod_id: str) -> None:
        try:
            self._req("DELETE", f"/pods/{pod_id}")
        except RuntimeError as e:
            if "404" not in str(e):
                raise

    def list_pods(self) -> list[dict]:
        r = self._req("GET", "/pods")
        return r if isinstance(r, list) else r.get("pods", [])

    def wait_ssh(self, pod_id: str, timeout: float = 900) -> tuple[str, int, dict]:
        t0 = time.time()
        while time.time() - t0 < timeout:
            p = self.pod(pod_id)
            ip, ports = p.get("publicIp"), p.get("portMappings") or {}
            port = ports.get("22") or ports.get(22)
            if ip and port:
                return ip, int(port), p
            time.sleep(8)
        raise TimeoutError("GPU 서버가 15분 안에 준비되지 않았습니다")


# ---------------------------------------------------------------------------
# Spending guard. Every run is appended to secrets/cloud_ledger.jsonl; a new
# pod is refused once this month's total reaches the budget in
# secrets/cloud_budget.txt (US$, default 30). Stale "splattour-*" pods left by
# a crashed laptop are deleted before renting a new one.
LEDGER = SECRETS / "cloud_ledger.jsonl"


def month_spend(now: float | None = None) -> float:
    ym = time.strftime("%Y-%m", time.localtime(now or time.time()))
    total = 0.0
    if LEDGER.exists():
        for line in LEDGER.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if time.strftime("%Y-%m", time.localtime(r.get("at", 0))) == ym:
                total += float(r.get("cost_usd") or 0)
    return round(total, 2)


def budget() -> float:
    p = SECRETS / "cloud_budget.txt"
    try:
        return float(p.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return 30.0


def record_spend(info: dict) -> None:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    rec = {"at": time.time(), "pod": info.get("pod"), "cost_usd": info.get("cost_usd", 0), "seconds": info.get("seconds"),
           "steps": info.get("steps"), "psnr": info.get("eval_psnr")}
    with open(LEDGER, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


def reap_stale_pods(rp: "RunPod", older_than_h: float = 4.5) -> list[str]:
    gone = []
    for p in rp.list_pods():
        name = p.get("name") or ""
        if not name.startswith("splattour-") or p.get("desiredStatus") != "RUNNING":
            continue
        started = p.get("lastStartedAt") or p.get("createdAt") or ""
        try:
            from datetime import datetime
            age_h = (time.time() - datetime.fromisoformat(started.replace("Z", "+00:00")).timestamp()) / 3600
        except ValueError:
            continue
        if age_h > older_than_h:
            rp.delete(p["id"])
            gone.append(p["id"])
    return gone


class Ssh:
    def __init__(self, host: str, port: int, key: Path):
        self.base = [shutil.which("ssh") or "ssh", "-i", str(key), "-p", str(port),
                     "-o", "StrictHostKeyChecking=no", "-o", f"UserKnownHostsFile={SECRETS / 'known_hosts'}",
                     "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=20", f"root@{host}"]

    def run(self, cmd: str, check: bool = True, timeout: float | None = None, log=None) -> str:
        r = subprocess.run(self.base + [cmd], capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=timeout)
        if log:
            log.write(f"\n$ {cmd}\n{r.stdout[-4000:]}{r.stderr[-4000:]}")
            log.flush()
        if check and r.returncode != 0:
            raise RuntimeError(f"원격 명령 실패 ({r.returncode}): {cmd[:120]}\n{r.stderr[-1500:]}")
        return r.stdout

    def wait_ready(self, timeout: float = 600) -> None:
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                if "ok" in self.run("echo ok", check=False, timeout=40):
                    return
            except subprocess.TimeoutExpired:
                pass
            time.sleep(10)
        raise TimeoutError("GPU 서버에 ssh로 접속하지 못했습니다")

    def upload_dir(self, src: Path, names: list[str], remote_dir: str, streams: int = 8,
                   progress: Callable[[int, int], None] | None = None) -> None:
        """tar-stream the files over `streams` parallel ssh connections.
        GPU hosts are often on another continent: one TCP stream is limited by
        latency (measured 0.1-0.3 MB/s Korea→Montana while the line does
        10 MB/s), so several streams in parallel fill the pipe."""
        files = sorted(str(f.relative_to(src)).replace("\\", "/") for n in names for f in (src / n).rglob("*") if f.is_file())
        sizes = {f: (src / f).stat().st_size for f in files}
        total = sum(sizes.values())
        groups: list[list[str]] = [[] for _ in range(max(1, min(streams, len(files))))]
        loads = [0] * len(groups)
        for f in sorted(files, key=lambda x: -sizes[x]):  # largest first → balanced
            i = loads.index(min(loads))
            groups[i].append(f)
            loads[i] += sizes[f]
        self.run(f"mkdir -p {remote_dir}")
        tar_exe = shutil.which("tar") or "tar"
        procs = []
        for g in groups:
            lst = Path(tempfile.mkstemp(suffix=".txt")[1])
            lst.write_bytes("\n".join(g).encode("utf-8"))  # write_text would add \r on Windows → tar looks for "x.jpg\r"
            tar = subprocess.Popen([tar_exe, "--force-local", "--owner=0", "--group=0", "-cf", "-", "-C", str(src), "-T", str(lst)], stdout=subprocess.PIPE)
            ssh = subprocess.Popen(self.base + [f"tar --no-same-owner --no-same-permissions -xf - -C {remote_dir}"], stdin=tar.stdout,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            tar.stdout.close()
            procs.append((tar, ssh, lst))
        t0 = time.time()
        while any(ssh.poll() is None for _, ssh, _ in procs):
            time.sleep(5)
            if progress:
                done = self.run(f"du -sb {remote_dir} | cut -f1", check=False, timeout=30).strip()
                progress(int(done or 0), total)
        errs = []
        for tar, ssh, lst in procs:
            tar.wait()
            if ssh.returncode != 0 or tar.returncode != 0:
                errs.append(ssh.stderr.read().decode(errors="ignore")[-400:])
            try: lst.unlink()
            except OSError: pass
        if errs:
            raise RuntimeError("업로드 실패: " + " | ".join(errs))
        mb = total / 2**20
        print(f"UPLOAD {mb:.0f} MB in {time.time() - t0:.0f}s = {mb / max(1, time.time() - t0):.2f} MB/s over {len(groups)} streams", flush=True)

    def probe_upload(self, mb_per_stream: int = 3, streams: int = 8) -> float:
        """MB/s this host actually accepts over `streams` parallel ssh streams.
        RunPod hosts vary a lot (measured 0.2 to 9.6 MB/s from Korea)."""
        import os
        import threading
        blob = os.urandom(mb_per_stream * 2**20)
        def one():
            subprocess.run(self.base + ["cat > /dev/null"], input=blob, capture_output=True, timeout=180)
        t0 = time.time()
        ts = [threading.Thread(target=one) for _ in range(streams)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        return streams * mb_per_stream / max(0.01, time.time() - t0)

    def download(self, remote: str, local: Path) -> None:
        scp = [shutil.which("scp") or "scp", "-i", self.base[2], "-P", self.base[4], *self.base[5:-1], f"{self.base[-1]}:{remote}", str(local)]
        r = subprocess.run(scp, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"다운로드 실패: {r.stderr[-800:]}")


SETUP = r"""
set -e
cd /workspace
python -m pip install -q --upgrade pip
# Wheel cache from an earlier run (uploaded to /workspace/wheels): installs in
# a minute instead of compiling fused-ssim & co. for 8-14 minutes.
if ls /workspace/wheels/*.whl >/dev/null 2>&1; then
  pip install -q --no-index --find-links /workspace/wheels gsplat || pip install -q gsplat --index-url https://docs.gsplat.studio/whl/pt24cu124 || pip install -q gsplat
else
  pip install -q gsplat --index-url https://docs.gsplat.studio/whl/pt24cu124 || pip install -q gsplat
fi
V=$(python -c "import gsplat;print(gsplat.__version__)")
[ -d gsplat ] || git clone -q --depth 1 --branch v$V https://github.com/nerfstudio-project/gsplat.git || git clone -q --depth 1 https://github.com/nerfstudio-project/gsplat.git
cd gsplat/examples
pip install -q ninja
if ls /workspace/wheels/*.whl >/dev/null 2>&1; then
  # git+ requirements would rebuild from source even with a cache: install the
  # cached wheels directly, then the rest of the list without the git lines
  pip install -q --no-deps /workspace/wheels/*.whl
  grep -vE "^git\+" requirements.txt > /tmp/req-nogit.txt
  pip install -q --no-build-isolation -r /tmp/req-nogit.txt
  echo WHEELS_USED
else
  pip install -q --no-build-isolation -r requirements.txt
  # build a cache for next time (only the slow, compiled git packages)
  mkdir -p /workspace/wheels_out
  grep -E "^git\+" requirements.txt | xargs -r pip wheel -q --no-deps --no-build-isolation -w /workspace/wheels_out || true
  pip download -q "gsplat==$V" --no-deps -d /workspace/wheels_out || true
fi
echo SETUP_DONE $V
"""


def _flag(help_text: str, name: str) -> str:
    """tyro spells flags with hyphens in new versions, underscores in old."""
    hy = "--" + name.replace("_", "-")
    return hy if hy in help_text else "--" + name


def train_gsplat_cloud(dataset: Path, out: Path, steps: int = 30000, cap_max: int = 2_000_000, max_hours: float = 4.0,
                       bilateral_grid: bool = False, test_every: int = 8,
                       community: bool = False, progress: Callable[[dict], None] | None = None) -> dict:
    """dataset: folder with images/ and sparse/0/ (undistorted PINHOLE)."""
    out.mkdir(parents=True, exist_ok=True)
    log = open(out / "cloud.log", "a", encoding="utf-8")
    note = progress or (lambda d: None)
    key = SECRETS / "splattour_ed25519"
    pub = (SECRETS / "splattour_ed25519.pub").read_text().strip()
    rp = RunPod()
    spent, cap = month_spend(), budget()
    if spent >= cap:
        raise RuntimeError(f"이번 달 클라우드 학습 비용 ${spent}가 한도 ${cap}에 도달했습니다. secrets/cloud_budget.txt 에서 한도를 바꿀 수 있어요.")
    stale = reap_stale_pods(rp, older_than_h=max_hours + 0.5)
    if stale:
        log.write(f"\n[deleted stale pods {stale}]\n")
    t0 = time.time()
    pod = rp.create_pod(f"splattour-{out.parent.name}"[:40], pub, community=community)
    pod_id = pod["id"]
    (out / "pod.json").write_text(json.dumps({"id": pod_id, "created": t0}), encoding="utf-8")
    info: dict = {"backend": "gsplat-cloud", "pod": pod_id}
    try:
        note({"phase": "GPU 빌리는 중"})
        host, port, p = rp.wait_ssh(pod_id)
        info["gpu"] = (p.get("machine") or {}).get("gpuDisplayName") or p.get("gpuTypeId") or ""
        info["cost_per_hr"] = p.get("costPerHr")
        ssh = Ssh(host, port, key)
        ssh.wait_ready()
        data_mb = sum(f.stat().st_size for n in ("images", "sparse") for f in (dataset / n).rglob("*") if f.is_file()) / 2**20
        for attempt in range(3):
            if data_mb < 40:
                break
            mbps = ssh.probe_upload()
            info["upload_probe_mbps"] = round(mbps, 2)
            log.write(f"\n[upload probe {mbps:.2f} MB/s on {host}]\n")
            # re-roll a slow host while the upload would take > 5 min
            if mbps >= 1.5 or data_mb / mbps < 300 or attempt == 2:
                break
            note({"phase": "GPU 빌리는 중", "why": f"느린 서버({mbps:.1f}MB/s) → 다른 서버로"})
            rp.delete(pod_id)
            pod = rp.create_pod(f"splattour-{out.parent.name}"[:40], pub, community=community)
            pod_id = pod["id"]
            info["pod"] = pod_id
            host, port, p = rp.wait_ssh(pod_id)
            info["cost_per_hr"] = p.get("costPerHr")
            ssh = Ssh(host, port, key)
            ssh.wait_ready()
        # watchdog: the pod removes itself even if this laptop dies
        ssh.run(f"nohup bash -c 'sleep {int(max_hours * 3600)}; runpodctl remove pod $RUNPOD_POD_ID' >/dev/null 2>&1 &", check=False, log=log)
        note({"phase": "데이터 올리는 중"})
        ssh.upload_dir(dataset, ["images", "sparse"], "/workspace/data",
                       progress=lambda d, t: note({"phase": "데이터 올리는 중", "step": d, "steps": t}))
        note({"phase": "학습 도구 설치 중"})
        cache = ROOT / "tools" / "wheels" / "pt24cu124"
        if list(cache.glob("*.whl")):
            ssh.upload_dir(cache.parent, [cache.name], "/workspace/_w")
            ssh.run("mkdir -p /workspace/wheels && mv /workspace/_w/pt24cu124/*.whl /workspace/wheels/", log=log)
        t_setup = time.time()
        setup = ssh.run(f"bash -lc {shlex.quote(SETUP)}", timeout=3600, log=log)
        info["setup_seconds"] = round(time.time() - t_setup)
        info["wheel_cache"] = "WHEELS_USED" in setup
        if "WHEELS_USED" not in setup:
            # keep the freshly built wheels for the next run
            names = ssh.run("ls /workspace/wheels_out/*.whl 2>/dev/null", check=False).split()
            if names:
                cache.mkdir(parents=True, exist_ok=True)
                for n in names:
                    ssh.download(n, cache / Path(n).name)
                print(f"WHEEL CACHE saved {len(names)} wheels", flush=True)
        info["gsplat"] = (re.findall(r"SETUP_DONE (\S+)", setup) or [""])[0]
        help_text = ssh.run("cd /workspace/gsplat/examples && python simple_trainer.py mcmc --help", check=False, log=log)
        f = lambda n: _flag(help_text, n)  # noqa: E731
        # Off by default: the per-image bilateral grid soaks up exposure/vignetting,
        # which leaves the *base* colours drifting from the photos (measured on
        # playroom: 20.6 dB vs 24.8 dB, error = smooth brightness field). Locked
        # exposure at capture (docs/CAPTURE_GUIDE.md) is the better fix.
        bilagrid = bilateral_grid and f("use_bilateral_grid") in help_text
        args = ["python simple_trainer.py mcmc", f"{f('data_dir')} /workspace/data",
                f"{f('data_factor')} 1", f"{f('result_dir')} /workspace/result",
                f("no_normalize_world_space") if f("no_normalize_world_space") in help_text else f"{f('normalize_world_space')} False",
                f("antialiased"), f"{f('strategy.cap_max')} {cap_max}", f"{f('max_steps')} {steps}",
                f"{f('eval_steps')} {steps}", f"{f('save_steps')} {steps}", f("save_ply"), f"{f('ply_steps')} {steps}",
                f"{f('test_every')} {test_every}", f("disable_viewer")]
        if bilagrid:
            args.append(f("use_bilateral_grid"))
        # experiment switches, e.g. SPLATTOUR_TRAIN_FLAGS="app_opt" (per-photo appearance, for
        # captures whose exposure changes shot to shot, like Zip-NeRF)
        for flag in os.environ.get("SPLATTOUR_TRAIN_FLAGS", "").split():
            name, _, value = flag.partition("=")
            args.append(f"{f(name)} {value}" if value else f(name))
        cmd = " ".join(args)
        info["command"] = cmd
        ssh.run(f"cd /workspace/gsplat/examples && setsid nohup {cmd} > /workspace/train.log 2>&1 < /dev/null & echo started", log=log)
        note({"phase": "학습 중", "step": 0, "steps": steps})
        last = 0
        while True:
            time.sleep(30)
            try:
                tail = ssh.run("tail -c 4000 /workspace/train.log; echo; pgrep -f '[s]imple_trainer.py' >/dev/null && echo RUNNING || echo EXITED",
                               check=False, timeout=60)
            except subprocess.TimeoutExpired:
                continue
            m = re.findall(r"Step (\d+)|(\d+)/%d" % steps, tail)
            nums = [int(a or b) for a, b in m if (a or b)]
            if nums:
                last = max(last, max(nums))
            note({"phase": "학습 중", "step": last, "steps": steps, "elapsed": round(time.time() - t0)})
            if "EXITED" in tail.splitlines()[-1]:
                break
            if time.time() - t0 > max_hours * 3600:
                raise TimeoutError("학습 시간 한도 초과")
        ply_remote = ssh.run("ls -t /workspace/result/ply/*.ply 2>/dev/null | head -1", check=False).strip()
        if not ply_remote:
            ssh.download("/workspace/train.log", out / "train.log")
            raise RuntimeError(f"학습 결과(.ply)가 없습니다. {out / 'train.log'} 확인")
        note({"phase": "결과 받는 중"})
        ply = out / "splat.ply"
        ssh.download(ply_remote, ply)
        ssh.download("/workspace/train.log", out / "train.log")
        stats = ssh.run("cat $(ls -t /workspace/result/stats/val_step*.json 2>/dev/null | head -1) 2>/dev/null", check=False).strip()
        if stats:
            s = json.loads(stats)
            info.update(eval_psnr=s.get("psnr"), eval_ssim=s.get("ssim"), eval_lpips=s.get("lpips"), num_splats=s.get("num_GS"))
        info.update(ply=str(ply), steps=steps)
        return info
    finally:
        rp.delete(pod_id)
        info["seconds"] = round(time.time() - t0, 1)
        if info.get("cost_per_hr"):
            info["cost_usd"] = round(float(info["cost_per_hr"]) * info["seconds"] / 3600, 2)
        log.write(f"\n[pod {pod_id} deleted after {info['seconds']}s]\n")
        try:
            record_spend(info)
        except OSError:
            pass
        log.close()


def train_gsplat_local(dataset: Path, out: Path, steps: int = 30000, cap_max: int = 2_000_000, test_every: int = 8,
                       progress: Callable[[dict], None] | None = None, workdir: Path = Path("/workspace")) -> dict:
    """Train on *this* machine's GPU (used on the cloud GPU server itself, where
    cloudjob.py runs the whole pipeline). Same setup script and trainer flags as
    train_gsplat_cloud, so results match the SSH-driven path."""
    import subprocess as sp
    out.mkdir(parents=True, exist_ok=True)
    note = progress or (lambda d: None)
    note({"phase": "학습 도구 설치 중"})
    t0 = time.time()
    setup = sp.run(["bash", "-lc", SETUP.replace("/workspace", str(workdir))], capture_output=True, text=True)
    (out / "setup.log").write_text(setup.stdout + setup.stderr, encoding="utf-8")
    if setup.returncode != 0:
        raise RuntimeError("gsplat 설치 실패: " + (setup.stderr or setup.stdout)[-600:])
    ex = workdir / "gsplat" / "examples"
    help_text = sp.run(["python", "simple_trainer.py", "mcmc", "--help"], cwd=ex, capture_output=True, text=True).stdout
    f = lambda n: _flag(help_text, n)  # noqa: E731
    args = ["python", "simple_trainer.py", "mcmc", f("data_dir"), str(dataset), f("data_factor"), "1", f("result_dir"), str(out / "result"),
            f("no_normalize_world_space") if f("no_normalize_world_space") in help_text else f("normalize_world_space"),
            *([] if f("no_normalize_world_space") in help_text else ["False"]),
            f("antialiased"), f("strategy.cap_max"), str(cap_max), f("max_steps"), str(steps), f("eval_steps"), str(steps),
            f("save_steps"), str(steps), f("save_ply"), f("ply_steps"), str(steps), f("test_every"), str(test_every or 10**9), f("disable_viewer")]
    note({"phase": "학습 중", "step": 0, "steps": steps})
    last, t1 = 0, time.time()
    with open(out / "train.log", "w", encoding="utf-8") as logf:
        proc = sp.Popen(args, cwd=ex, stdout=sp.PIPE, stderr=sp.STDOUT, text=True, bufsize=1)
        buf = ""
        while True:
            ch = proc.stdout.read(4096)
            if not ch:
                break
            logf.write(ch)
            buf = (buf + ch)[-8000:]
            nums = [int(a or b) for a, b in re.findall(r"Step (\d+)|(\d+)/%d" % steps, buf) if (a or b)]
            if nums and max(nums) - last >= steps // 100:
                last = max(nums)
                note({"phase": "학습 중", "step": last, "steps": steps})
        proc.wait()
    plys = sorted((out / "result" / "ply").glob("*.ply"), key=lambda p: p.stat().st_mtime)
    if not plys:
        raise RuntimeError(f"학습 결과(.ply)가 없습니다 (exit {proc.returncode}). {out / 'train.log'}")
    info = {"backend": "gsplat-local", "ply": str(plys[-1]), "steps": steps, "setup_seconds": round(t1 - t0), "train_seconds": round(time.time() - t1),
            "command": " ".join(args)}
    stats = sorted((out / "result" / "stats").glob("val_step*.json"))
    if stats:
        s = json.loads(stats[-1].read_text())
        info.update(eval_psnr=s.get("psnr"), eval_ssim=s.get("ssim"), eval_lpips=s.get("lpips"), num_splats=s.get("num_GS"))
    return info


def runner_env() -> dict:
    """Environment for a cloud runner (cloudjob.py): the *scoped* storage key only."""
    def kv(p):
        return {k.strip(): v.strip() for k, v in (l.split("=", 1) for l in (SECRETS / p).read_text(encoding="utf-8-sig").splitlines() if "=" in l)}
    adm, web = kv("r2.txt"), kv("r2-web.txt")
    bundle = (SECRETS / "runner_bundle.txt").read_text().strip()
    return {"R2_ACCOUNT_ID": adm["ACCOUNT_ID"], "R2_ACCESS_KEY_ID": web["ACCESS_KEY_ID"], "R2_SECRET_ACCESS_KEY": web["SECRET_ACCESS_KEY"],
            "BUNDLE_URL": f"{adm['PUBLIC_URL'].rstrip('/')}/{bundle}", "MAX_HOURS": "5",
            "VOCAB_URL": f"{adm['PUBLIC_URL'].rstrip('/')}/{(SECRETS / 'runner_vocab.txt').read_text().strip()}"}


RUNNER_CMD = ('mkdir -p /workspace/st && curl -fsSL "$BUNDLE_URL" | tar xz -C /workspace/st && '
              '(bash /start.sh >/dev/null 2>&1 &) ; bash /workspace/st/runner/boot.sh')


def launch_runner(env: dict | None = None, community: bool = False) -> dict:
    """Start a GPU server that processes every pending web upload and then removes itself.
    The site's upload API does the same (web-api/api/web/[action].js)."""
    rp = RunPod()
    pub = (SECRETS / "splattour_ed25519.pub").read_text().strip()
    body = {
        "name": "splattour-runner", "imageName": IMAGE, "gpuTypeIds": GPU_TYPES, "gpuTypePriority": "custom", "gpuCount": 1,
        "containerDiskInGb": 150, "volumeInGb": 0, "ports": ["22/tcp"], "supportPublicIp": True,
        "cloudType": "COMMUNITY" if community else "SECURE",
        "env": {"PUBLIC_KEY": pub, **(env or runner_env())},
        "dockerStartCmd": ["bash", "-c", RUNNER_CMD],
    }
    return rp._req("POST", "/pods", json=body)
