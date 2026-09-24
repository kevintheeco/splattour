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
            lst.write_text("\n".join(g), encoding="utf-8")
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

    def download(self, remote: str, local: Path) -> None:
        scp = [shutil.which("scp") or "scp", "-i", self.base[2], "-P", self.base[4], *self.base[5:-1], f"{self.base[-1]}:{remote}", str(local)]
        r = subprocess.run(scp, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"다운로드 실패: {r.stderr[-800:]}")


SETUP = r"""
set -e
cd /workspace
python -m pip install -q --upgrade pip
pip install -q gsplat --index-url https://docs.gsplat.studio/whl/pt24cu124 || pip install -q gsplat
V=$(python -c "import gsplat;print(gsplat.__version__)")
[ -d gsplat ] || git clone -q --depth 1 --branch v$V https://github.com/nerfstudio-project/gsplat.git || git clone -q --depth 1 https://github.com/nerfstudio-project/gsplat.git
cd gsplat/examples
pip install -q ninja
pip install -q --no-build-isolation -r requirements.txt
echo SETUP_DONE $V
"""


def _flag(help_text: str, name: str) -> str:
    """tyro spells flags with hyphens in new versions, underscores in old."""
    hy = "--" + name.replace("_", "-")
    return hy if hy in help_text else "--" + name


def train_gsplat_cloud(dataset: Path, out: Path, steps: int = 30000, cap_max: int = 4_000_000, max_hours: float = 4.0,
                       community: bool = False, progress: Callable[[dict], None] | None = None) -> dict:
    """dataset: folder with images/ and sparse/0/ (undistorted PINHOLE)."""
    out.mkdir(parents=True, exist_ok=True)
    log = open(out / "cloud.log", "a", encoding="utf-8")
    note = progress or (lambda d: None)
    key = SECRETS / "splattour_ed25519"
    pub = (SECRETS / "splattour_ed25519.pub").read_text().strip()
    rp = RunPod()
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
        # watchdog: the pod removes itself even if this laptop dies
        ssh.run(f"nohup bash -c 'sleep {int(max_hours * 3600)}; runpodctl remove pod $RUNPOD_POD_ID' >/dev/null 2>&1 &", check=False, log=log)
        note({"phase": "데이터 올리는 중"})
        ssh.upload_dir(dataset, ["images", "sparse"], "/workspace/data",
                       progress=lambda d, t: note({"phase": "데이터 올리는 중", "step": d, "steps": t}))
        note({"phase": "학습 도구 설치 중"})
        setup = ssh.run(f"bash -lc {shlex.quote(SETUP)}", timeout=3600, log=log)
        info["gsplat"] = (re.findall(r"SETUP_DONE (\S+)", setup) or [""])[0]
        help_text = ssh.run("cd /workspace/gsplat/examples && python simple_trainer.py mcmc --help", check=False, log=log)
        f = lambda n: _flag(help_text, n)  # noqa: E731
        bilagrid = f("use_bilateral_grid") in help_text
        args = ["python simple_trainer.py mcmc", f"{f('data_dir')} /workspace/data",
                f"{f('data_factor')} 1", f"{f('result_dir')} /workspace/result",
                f("no_normalize_world_space") if f("no_normalize_world_space") in help_text else f"{f('normalize_world_space')} False",
                f("antialiased"), f"{f('strategy.cap_max')} {cap_max}", f"{f('max_steps')} {steps}",
                f"{f('eval_steps')} {steps}", f"{f('save_steps')} {steps}", f("save_ply"), f"{f('ply_steps')} {steps}",
                f"{f('test_every')} 8", f("disable_viewer")]
        if bilagrid:
            args.append(f("use_bilateral_grid"))
        cmd = " ".join(args)
        info["command"] = cmd
        ssh.run(f"cd /workspace/gsplat/examples && nohup {cmd} > /workspace/train.log 2>&1 & echo started", log=log)
        note({"phase": "학습 중", "step": 0, "steps": steps})
        last = 0
        while True:
            time.sleep(30)
            try:
                tail = ssh.run("tail -c 4000 /workspace/train.log; echo; pgrep -f simple_trainer.py >/dev/null && echo RUNNING || echo EXITED",
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
        log.close()
