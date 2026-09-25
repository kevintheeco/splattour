"""Max-quality path for a large, high-resolution capture (opt-in; the automatic web path is unchanged).

What differs from the default job (run.run_job):
  * photos are kept at up to `hi_side` px (default 3200) for training; SfM still runs on
    1600 px copies (poses need no more), and the SfM model is rescaled to the large photos
    (sfm.hires_dataset, checked pixel-exact on Dr Johnson: pipeline/tests/test_hires_dataset.py);
  * gsplat MCMC with up to 5.5 M Gaussians for 60 k steps (the whole schedule stretched
    x2 with --steps-scaler), bilateral grid off, opacity/scale regularisation scaled with
    the photo count (cloud.mcmc_reg_flags);
  * a scored run first (every 8th photo held out -> PSNR/SSIM/LPIPS for the report), published
    at once, then a final run on every photo that replaces it;
  * the phone file keeps the 1.5 M most visible splats (SH degree 1); the full PLY is archived
    (cloud/max/<id>/scene.ply) so the viewer's LoD build can be made from it.

Runs on a cloud GPU server (cloudjob.py with SPLATTOUR_QUALITY=max). Started from the laptop:

    python -m splattour.maxq launch <inbox-id> [--side 3200] [--cap 5500000] [--steps 60000]
                                    [--no-final] [--scene NAME] [--title TITLE] [--hours 16] [--dry-run]
    python -m splattour.maxq status <inbox-id>       # progress / result / cost of a launched run
    python -m splattour.maxq fetch <inbox-id>        # download scene (+ full PLY) into scenes/<name>
    python -m splattour.maxq smoke                   # tiny end-to-end test (24 photos, not published)
"""
from __future__ import annotations

import argparse
import io
import json
import secrets as _secrets
import shutil
import sys
import tarfile
import time
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
SECRETS = ROOT / "secrets"

MAX_STAGES = [
    ("ingest", "촬영물 정리 (원본 해상도 보존)"),
    ("sfm", "카메라 위치 복원 (COLMAP)"),
    ("hires", "고해상도 학습 자료 만들기"),
    ("train", "3D 가우시안 학습 (점수용, 시험 사진 제외)"),
    ("export", "투어 동선·웹용 압축·게시"),
    ("final", "3D 가우시안 학습 (게시용, 전체 사진)"),
    ("final_export", "최종본 투어·웹용 압축·게시"),
]
# RunPod secure-cloud $/h (API, 2026-09-25), for the ledger when the server cannot look its own price up
PRICE = {"NVIDIA H100 80GB HBM3": 3.49, "NVIDIA H100 PCIe": 2.89, "NVIDIA H100 NVL": 3.19, "NVIDIA H200": 4.59,
         "NVIDIA A100-SXM4-80GB": 1.59, "NVIDIA A100 80GB PCIe": 1.59, "NVIDIA L40S": 1.09, "NVIDIA RTX 6000 Ada Generation": 0.84,
         "NVIDIA RTX A6000": 0.53, "NVIDIA A40": 0.49, "NVIDIA GeForce RTX 4090": 0.69}
DEFAULTS = {"side": 3200, "cap": 5_500_000, "steps": 60_000, "final": True, "mobile_cap": 1_500_000, "steps_scaler": 2}


# --------------------------------------------------------------------------- on the GPU server
def run_job_max(inputs: list[Path], name: str, title: str, *, hi_side: int = 3200, sfm_side: int = 1600, steps: int = 60_000,
                max_splats: int = 5_500_000, final: bool = True, mobile_max_splats: int | None = 1_500_000, test_every: int = 8,
                steps_scaler: int = 2, job_root: Path | None = None, on_model: Callable[[str, dict], None] | None = None) -> Path:
    """captures -> published tour at max quality (see module doc). on_model(kind, info) runs after
    the scored model ("eval") and the final model ("final") are exported to scenes/<name>."""
    import traceback

    from .build_tour import build_tour
    from .cloud import train_gsplat_local
    from .frames import ingest_hires
    from .run import Job, export_web
    from .sfm import hires_dataset, run_sfm

    job = Job((job_root or ROOT / "data" / "jobs") / name)
    stages = [s for s in MAX_STAGES if final or s[0] not in ("final", "final_export")]
    if "hires" not in job.state["stages"]:
        job.state["stages"] = {k: {"label": v, "status": "pending"} for k, v in stages}
    params = {"hi_side": hi_side, "sfm_side": sfm_side, "steps": steps, "max_splats": max_splats, "final": final,
              "mobile_max_splats": mobile_max_splats, "test_every": test_every, "steps_scaler": steps_scaler}
    job.state.update(name=name, title=title, inputs=[str(p) for p in inputs], quality="max", params=params)
    job.save()
    scene_dir = ROOT / "scenes" / name

    def progress_for(stage):
        def progress(d):
            job.state["stages"][stage]["progress"] = d
            job.save()
        return progress

    def publish_local(ply: Path) -> dict:
        from .photos import export_photos
        model = Path(job.state["stages"]["sfm"]["info"]["dataset"]) / "sparse" / "0"
        rep = build_tour(model, ply, scene_dir, title=title)
        web = export_web(scene_dir, mobile_max_splats=mobile_max_splats)
        try:
            job.state["photos"] = export_photos(name, model, model.parent.parent / "images")
        except Exception as e:  # noqa: BLE001 — photos must not fail the tour
            job.state["photos_error"] = str(e)
        return {"tour_nodes": len(json.loads((scene_dir / "tour.json").read_text(encoding="utf-8"))["nodes"]),
                "splats": rep["num_splats"], **web}

    stage = None
    try:
        stage = "ingest"
        if not job.done(stage):
            job.start(stage)
            job.finish(stage, **ingest_hires(inputs, job.dir / "images_hi", job.dir / "images", hi_side=hi_side, sfm_side=sfm_side))
        stage = "sfm"
        if not job.done(stage):
            job.start(stage)
            ing = job.state["stages"]["ingest"]["info"]
            job.finish(stage, **run_sfm(job.dir / "images", job.dir / "sfm", max_image_size=sfm_side,
                                        ordered=ing.get("frames", 0) > ing.get("photos", 0)))
        stage = "hires"
        if not job.done(stage):
            job.start(stage)
            job.finish(stage, **hires_dataset(job.dir / "sfm", job.dir / "images_hi", job.dir / "sfm" / "dense_hi"))
        dataset_hi = Path(job.state["stages"]["hires"]["info"]["dataset"])
        stage = "train"
        if not job.done(stage):
            job.start(stage)
            job.finish(stage, **train_gsplat_local(dataset_hi, job.dir / "train", steps=steps, cap_max=max_splats, test_every=test_every,
                                                   progress=progress_for(stage), steps_scaler=steps_scaler))
        stage = "export"
        if not job.done(stage):
            job.start(stage)
            job.finish(stage, **publish_local(Path(job.state["stages"]["train"]["info"]["ply"])))
            if on_model:
                on_model("eval", job.state["stages"]["train"]["info"])
        if final:
            stage = "final"
            if not job.done(stage):
                job.start(stage)
                job.finish(stage, **train_gsplat_local(dataset_hi, job.dir / "train_final", steps=steps, cap_max=max_splats, test_every=0,
                                                       progress=progress_for(stage), steps_scaler=steps_scaler))
            stage = "final_export"
            if not job.done(stage):
                job.start(stage)
                job.finish(stage, **publish_local(Path(job.state["stages"]["final"]["info"]["ply"])))
                if on_model:
                    on_model("final", job.state["stages"]["final"]["info"])
        job.state["current"] = None
        job.state["scene"] = name
        job.save()
    except Exception as e:  # noqa: BLE001
        job.fail(stage, f"{e}\n{traceback.format_exc(limit=3)}")
        raise
    return job.dir


# --------------------------------------------------------------------------- on the laptop
def _kv(name: str) -> dict:
    return {k.strip(): v.strip() for k, v in (l.split("=", 1) for l in (SECRETS / name).read_text(encoding="utf-8-sig").splitlines() if "=" in l)}


def _s3():
    from .inbox import client, keys
    k = keys()
    if not k:
        raise SystemExit("secrets/r2.txt 에 저장소 키가 없어요")
    return client(k)


def _get(s3, key):
    from .inbox import BUCKET
    try:
        return json.loads(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())
    except Exception:  # noqa: BLE001
        return None


def spend_this_month(s3) -> dict:
    """Both ledgers: the laptop's (secrets/cloud_ledger.jsonl) and the cloud servers' (R2 cloud/ledger/<month>/)."""
    from .cloud import budget, month_spend
    from .inbox import BUCKET
    month = time.strftime("%Y-%m", time.gmtime())
    r2 = 0.0
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=f"cloud/ledger/{month}/"):
        for o in page.get("Contents", []):
            r2 += float((_get(s3, o["Key"]) or {}).get("cost_usd") or 0)
    lap = month_spend()
    return {"laptop": lap, "cloud_servers": round(r2, 2), "total": round(lap + r2, 2), "budget": budget()}


def probe_size(s3, key: str) -> tuple[int, int] | None:
    """Pixel size of an uploaded photo from its first bytes (PNG/JPEG header)."""
    from PIL import Image

    from .inbox import BUCKET
    try:
        head = s3.get_object(Bucket=BUCKET, Key=key, Range="bytes=0-262143")["Body"].read()
        return Image.open(io.BytesIO(head)).size
    except Exception:  # noqa: BLE001 — HEIC, video, truncated header
        return None


def estimate(n_photos: int, side: int, cap: int, steps: int, final: bool, src: tuple[int, int] | None = None) -> dict:
    """Rough hours on an H100 from measured runs (Dr Johnson: 2 M splats at 1.17 MP, 25 ms/step on
    an RTX 4090); per-step time taken to grow with pixels^0.8 x splats^0.5. A100: about 1.6x longer."""
    if src:  # photos are never enlarged: training uses min(side, their own size)
        k = min(1.0, side / max(src))
        mp = src[0] * src[1] * k * k / 1e6
    else:
        mp = side * side * 2 / 3 / 1e6  # 3:2 photos
    ms = 25 * (mp / 1.17) ** 0.8 * (cap / 2e6) ** 0.5
    train_h = steps * ms / 1000 / 3600 * (2 if final else 1)
    sfm_h = 0.2 + 0.8 * (n_photos / 872) ** 2  # exhaustive GPU matching grows with the number of pairs
    total = 0.5 + sfm_h + train_h + 0.3  # boot + compile, SfM, training, eval/export/upload
    return {"ms_per_step": round(ms), "train_hours": round(train_h, 1), "total_hours": round(total, 1),
            "usd_h100": round(total * 3.49, 1), "usd_a100": round(total * 1.6 * 1.59, 1)}


def build_bundle(s3) -> str:
    """The pipeline code as it is now, under its own storage key (secrets/runner_bundle_max.txt).
    The live auto-runner's bundle (secrets/runner_bundle.txt, runner/push.py) is not touched.
    No prebuilt wheels: the cached ones are compiled for sm_89 only (RTX 4090 / L40S) and
    would not run on an H100/A100, so the server compiles them for its own GPU."""
    from .inbox import BUCKET
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for p in sorted((ROOT / "pipeline" / "splattour").rglob("*.py")):
            if "__pycache__" not in p.parts:
                tar.add(p, arcname=f"pipeline/{p.relative_to(ROOT / 'pipeline').as_posix()}")
        for name in ("boot.sh", "panorama_sfm.py"):
            tar.add(ROOT / "runner" / name, arcname=f"runner/{name}")
    ref = SECRETS / "runner_bundle_max.txt"
    key = ref.read_text().strip() if ref.exists() else f"_runner/{_secrets.token_hex(16)}/max.tgz"
    live = SECRETS / "runner_bundle.txt"
    if live.exists() and key == live.read_text().strip():
        raise SystemExit("max bundle key must differ from the live runner bundle")
    s3.put_object(Bucket=BUCKET, Key=key, Body=buf.getvalue(), ContentType="application/gzip", CacheControl="no-cache")
    ref.write_text(key)
    return key


def launch(job_id: str, *, side: int, cap: int, steps: int, final: bool, scene: str | None, title: str | None, hours: float,
           gpus: list[str] | None = None, manifest_key: str | None = None, publish: bool = True, mobile_cap: int = 1_500_000,
           dry_run: bool = False, stage: str = "full", variant: str = "", extra_env: dict | None = None) -> dict:
    """stage "full": the whole max-quality job on one server. "sfm" / "train": one experiment of a
    campaign (see cloudjob.process_max_stage), archived under cloud/max/<id>/<variant>/."""
    from .cloud import GPU_TYPES_MAX, IMAGE, RUNNER_CMD, RunPod, runner_env
    s3 = _s3()
    mkey = manifest_key or f"inbox/{job_id}/manifest.json"
    man = _get(s3, mkey)
    if not man:
        raise SystemExit(f"{mkey} 가 없어요 (업로드가 아직 끝나지 않았거나 번호가 틀림)")
    n = len(man.get("files", []))
    gb = sum(int(f.get("size") or 0) for f in man.get("files", [])) / 1e9
    src = probe_size(s3, man["files"][0]["key"]) if man.get("files") else None
    est = estimate(n, side, cap, steps, final, src)
    spend = spend_this_month(s3)
    plan = {"job": job_id, "title": man.get("title"), "files": n, "gb": round(gb, 2), "photo_size": src, "estimate": est, "spend": spend,
            "params": {"side": side, "cap": cap, "steps": steps, "final": final, "mobile_cap": mobile_cap, "hours": hours, "publish": publish}}
    if src and max(src) < side:
        plan["note"] = f"사진 긴 변이 {max(src)}px라 학습도 {max(src)}px로 합니다 (확대하지 않음)."
    if man.get("panorama"):
        raise SystemExit("360 파노라마 업로드는 최고 화질 경로가 아직 지원하지 않아요 (자동 처리 경로를 쓰세요)")
    worst = min(max(est["usd_h100"], est["usd_a100"]), hours * 4.6)  # the watchdog caps the bill at `hours`
    if spend["total"] + worst > spend["budget"]:
        raise SystemExit(f"이번 달 사용 ${spend['total']} + 이번 예상 최대 ${worst:.0f} 가 한도 ${spend['budget']}를 넘어요. "
                         "secrets/cloud_budget.txt (와 사이트의 BUDGET_USD)를 올린 뒤 다시 실행하세요.")
    plan.update(stage=stage, variant=variant, extra_env=extra_env or {})
    if dry_run:
        return {"dry_run": True, **plan}
    key = build_bundle(s3)
    env = runner_env()
    adm = _kv("r2.txt")
    env.update({
        "BUNDLE_URL": f"{adm['PUBLIC_URL'].rstrip('/')}/{key}", "MAX_HOURS": str(int(round(hours))),
        "SPLATTOUR_ONLY_JOB": job_id, "SPLATTOUR_QUALITY": "max", "SPLATTOUR_MAX_SIDE": str(side), "SPLATTOUR_MAX_CAP": str(cap),
        "SPLATTOUR_MAX_STEPS": str(steps), "SPLATTOUR_MAX_FINAL": "1" if final else "0", "SPLATTOUR_MAX_MOBILE_CAP": str(mobile_cap),
        "SPLATTOUR_PUBLISH": "1" if publish else "0", "SPLATTOUR_NO_WHEEL_BUILD": "1",
        # the server's own price lookup falls back to $1/h; book the dearest allowed card instead (ledger errs high)
        "COST_PER_HR": str(max(PRICE.get(g, 3.49) for g in (gpus or GPU_TYPES_MAX))),
        **({"SPLATTOUR_MANIFEST": mkey} if manifest_key else {}),
        **({"SPLATTOUR_SCENE": scene} if scene else {}), **({"SPLATTOUR_TITLE": title} if title else {}),
        "SPLATTOUR_STAGE": stage, **({"SPLATTOUR_VARIANT": variant} if variant else {}), **(extra_env or {}),
    })
    body = {
        # not "splattour-*": cloud.reap_stale_pods deletes those after 4.5 h, this one runs longer
        "name": f"maxq-{variant or job_id}"[:40], "imageName": IMAGE, "gpuTypeIds": gpus or GPU_TYPES_MAX, "gpuTypePriority": "custom", "gpuCount": 1,
        "containerDiskInGb": 400, "volumeInGb": 0, "ports": ["22/tcp"], "supportPublicIp": True, "cloudType": "SECURE",
        "env": {"PUBLIC_KEY": (SECRETS / "splattour_ed25519.pub").read_text().strip(), **env},
        "dockerStartCmd": ["bash", "-c", RUNNER_CMD],
    }
    pod = RunPod()._req("POST", "/pods", json=body)
    rec = {**plan, "pod": pod.get("id"), "gpu": (pod.get("machine") or {}).get("gpuDisplayName") or pod.get("gpuTypeId"),
           "cost_per_hr": pod.get("costPerHr"), "bundle": key, "launched": time.time()}
    out = ROOT / "data" / "maxq"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{job_id}{'-' + variant if variant else ''}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return rec


def status(job_id: str, variant: str = "") -> dict:
    from .cloud import RunPod
    s3 = _s3()
    loc = ROOT / "data" / "maxq" / f"{job_id}{'-' + variant if variant else ''}.json"
    rec = json.loads(loc.read_text(encoding="utf-8")) if loc.exists() else {}
    arch = f"cloud/max/{job_id}/{variant + '/' if variant else ''}"
    res = {"status": _get(s3, arch + "status.json"), "result": _get(s3, arch + "result.json"), "error": _get(s3, arch + "error.json")}
    if rec.get("pod"):
        try:
            p = RunPod().pod(rec["pod"])
            res["pod"] = {"id": rec["pod"], "state": p.get("desiredStatus"), "gpu": (p.get("machine") or {}).get("gpuDisplayName"),
                          "cost_per_hr": p.get("costPerHr"), "hours": round((time.time() - rec["launched"]) / 3600, 2)}
        except RuntimeError as e:
            res["pod"] = {"id": rec["pod"], "state": "gone" if "404" in str(e) else str(e)[:120]}
        led = _get(s3, f"cloud/ledger/{time.strftime('%Y-%m', time.gmtime(rec['launched']))}/{rec['pod']}.json")
        if led:
            res["ledger"] = led
        res["log"] = f"cloud/logs/{rec['pod']}.log"
    return res


def fetch(job_id: str, with_ply: bool = True) -> dict:
    """Bring a finished max run to this laptop: scenes/<name>/ (tour, spz, photos) and the full PLY,
    so the viewer's LoD build (viewer/, another agent's work) can be made from it."""
    from .inbox import BUCKET
    s3 = _s3()
    res = _get(s3, f"cloud/max/{job_id}/result.json")
    if not res:
        raise SystemExit("아직 결과가 없어요 (status 로 확인)")
    name = res["scene"]
    sdir = ROOT / "scenes" / name
    arch = ROOT / "data" / "maxq" / job_id
    got = 0
    prefixes = [(f"cloud/max/{job_id}/", arch)] + ([(f"scenes/{name}/", sdir)] if res.get("published") else [])
    for prefix, dst in prefixes:
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
            for o in page.get("Contents", []):
                if o["Key"].endswith(".ply") and not with_ply:
                    continue
                p = dst / o["Key"][len(prefix):]
                if p.exists() and p.stat().st_size == o["Size"]:
                    continue
                p.parent.mkdir(parents=True, exist_ok=True)
                s3.download_file(BUCKET, o["Key"], str(p))
                got += 1
    sdir.mkdir(parents=True, exist_ok=True)
    for f in ("scene.ply", "tour.json", "scene.spz", "scene.mobile.spz"):  # unpublished runs (smoke) keep their scene in the archive
        if (arch / f).exists() and not (sdir / f).exists():
            shutil.copyfile(arch / f, sdir / f)
    return {"scene": name, "files": got, "dir": str(sdir), "archive": str(arch)}


def compare(job_id: str, variants: list[str]) -> list[dict]:
    """Scored training experiments side by side: gsplat's held-out PSNR/SSIM/LPIPS (base colours,
    what the viewer shows) plus, from the archived held-out renders, PSNR after a per-photo affine
    colour fit (fair to runs whose exposure handling differs). Renders land in data/maxq/<id>/<variant>/."""
    import numpy as np
    from PIL import Image

    from .inbox import BUCKET
    s3 = _s3()
    rows = []
    for v in variants:
        arch = f"cloud/max/{job_id}/{v}/"
        r = _get(s3, arch + "result.json") or {}
        t = r.get("train") or {}
        row = {"variant": v, "cap": r.get("cap"), "steps": r.get("steps"), "flags": r.get("flags"), "psnr": t.get("eval_psnr"),
               "ssim": t.get("eval_ssim"), "lpips": t.get("eval_lpips"), "splats": t.get("num_splats"), "gpu_mem_gb": t.get("gpu_mem_gb"),
               "train_min": round((t.get("train_seconds") or 0) / 60), "spz_mb": round((r.get("spz") or {}).get("bytes", 0) / 1e6, 1)}
        dst = ROOT / "data" / "maxq" / job_id / v
        dst.mkdir(parents=True, exist_ok=True)
        cc = []
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=arch + "renders/"):
            for o in page.get("Contents", []):
                p = dst / Path(o["Key"]).name
                if not p.exists():
                    s3.download_file(BUCKET, o["Key"], str(p))
                a = np.asarray(Image.open(p).convert("RGB"), np.float64) / 255
                w = a.shape[1] // 2
                gt, im = a[:, :w].reshape(-1, 3), a[:, w:].reshape(-1, 3)
                X = np.c_[im, np.ones(len(im))]
                fit = X @ np.linalg.lstsq(X, gt, rcond=None)[0]
                cc.append(10 * np.log10(1 / np.mean((np.clip(fit, 0, 1) - gt) ** 2)))
        row["cc_psnr"] = round(float(np.mean(cc)), 3) if cc else None
        row["renders"] = len(cc)
        rows.append(row)
    return rows


def smoke(gpus: list[str] | None, n: int = 24) -> dict:
    """End-to-end test of the max path on the cloud with 24 Dr Johnson photos upscaled x3 (4K),
    kept under test/ (nothing else reads that prefix) and not published: results land in cloud/max/<id>/."""
    from PIL import Image

    from .inbox import BUCKET
    s3 = _s3()
    jid = time.strftime("smoke-%Y%m%d-%H%M%S")
    src = sorted((ROOT / "data" / "samples" / "deepblending_drjohnson" / "colmap" / "images").glob("*.jpg"))[40:40 + n]
    files = []
    for f in src:
        im = Image.open(f).convert("RGB")
        b = io.BytesIO()
        im.resize((im.width * 3, im.height * 3), Image.LANCZOS).save(b, "JPEG", quality=92)
        key = f"test/{jid}/files/{f.name}"
        s3.put_object(Bucket=BUCKET, Key=key, Body=b.getvalue(), ContentType="image/jpeg")
        files.append({"name": f.name, "size": b.tell(), "key": key})
    man = {"id": jid, "title": "최고화질 경로 시험", "quality": "max", "panorama": False, "files": files}
    s3.put_object(Bucket=BUCKET, Key=f"test/{jid}/manifest.json", Body=json.dumps(man, ensure_ascii=False).encode(), ContentType="application/json")
    return launch(jid, side=3200, cap=300_000, steps=4000, final=True, scene=f"maxq-{jid}", title="최고화질 경로 시험", hours=2,
                  gpus=gpus, manifest_key=f"test/{jid}/manifest.json", publish=False, mobile_cap=150_000)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m splattour.maxq")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("launch")
    a.add_argument("job")
    a.add_argument("--side", type=int, default=DEFAULTS["side"], help="training photo long side (px)")
    a.add_argument("--cap", type=int, default=DEFAULTS["cap"], help="max Gaussians")
    a.add_argument("--steps", type=int, default=DEFAULTS["steps"])
    a.add_argument("--no-final", action="store_true", help="skip the all-photos run (publish the scored model)")
    a.add_argument("--mobile-cap", type=int, default=DEFAULTS["mobile_cap"])
    a.add_argument("--scene")
    a.add_argument("--title")
    a.add_argument("--hours", type=float, default=16, help="the server removes itself after this long, whatever happens")
    a.add_argument("--gpus", help="comma-separated RunPod GPU type ids (default: H100/H200/A100 80GB)")
    a.add_argument("--no-publish", action="store_true")
    a.add_argument("--dry-run", action="store_true")
    a.add_argument("--stage", default="full", choices=["full", "sfm", "train"])
    a.add_argument("--variant", default="", help="experiment name (stage sfm/train)")
    a.add_argument("--camera-model", help="stage sfm: OPENCV (default), OPENCV_FISHEYE, ...")
    a.add_argument("--no-clahe", action="store_true", help="stage sfm: plain SfM copies")
    a.add_argument("--mapper", default="global", choices=["global", "incremental"], help="stage sfm")
    a.add_argument("--dataset", help="stage train: storage key of an sfm experiment's dataset.tar")
    a.add_argument("--flags", default="", help='stage train: extra gsplat flags, e.g. "use_bilateral_grid"')
    a.add_argument("--test-every", type=int, default=8, help="stage train: 0 = train on every photo")
    st = sub.add_parser("status")
    st.add_argument("job")
    st.add_argument("--variant", default="")
    sub.add_parser("fetch").add_argument("job")
    c = sub.add_parser("compare")
    c.add_argument("job")
    c.add_argument("variants", help="comma-separated experiment names")
    s = sub.add_parser("smoke")
    s.add_argument("--gpus")
    args = ap.parse_args(argv)
    if args.cmd == "launch":
        env = {}
        if args.stage == "sfm":
            env.update(SPLATTOUR_CAMERA_MODEL=args.camera_model or "OPENCV", SPLATTOUR_SFM_CLAHE="0" if args.no_clahe else "1",
                       SPLATTOUR_MAPPER=args.mapper)
        if args.stage == "train":
            if not args.dataset:
                raise SystemExit("--dataset 필요")
            env.update(SPLATTOUR_DATASET_KEY=args.dataset, SPLATTOUR_MAX_FLAGS=args.flags, SPLATTOUR_TEST_EVERY=str(args.test_every))
        publish = not args.no_publish if args.stage != "sfm" else False
        if args.stage == "train" and args.test_every:
            publish = False  # scored experiments never publish
        r = launch(args.job, side=args.side, cap=args.cap, steps=args.steps, final=not args.no_final, scene=args.scene, title=args.title,
                   hours=args.hours, gpus=args.gpus.split(",") if args.gpus else None, publish=publish,
                   mobile_cap=args.mobile_cap, dry_run=args.dry_run, stage=args.stage, variant=args.variant, extra_env=env)
    elif args.cmd == "status":
        r = status(args.job, args.variant)
    elif args.cmd == "fetch":
        r = fetch(args.job)
    elif args.cmd == "compare":
        r = compare(args.job, args.variants.split(","))
    else:
        r = smoke(args.gpus.split(",") if args.gpus else None)
    print(json.dumps(r, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
