"""End-to-end job: captures → published tour. Each stage writes progress to
<job>/status.json so the studio UI can show it, and stages that already
finished are skipped on re-run (resume after a crash or a parameter change).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPLAT_TRANSFORM = ROOT / "viewer" / "node_modules" / ".bin" / "splat-transform.cmd"

STAGES = [
    ("ingest", "촬영물 정리 (프레임 추출·흐린 사진 제거)"),
    ("sfm", "카메라 위치 복원 (COLMAP)"),
    ("train", "3D 가우시안 학습"),
    ("tour", "투어 동선 자동 생성"),
    ("export", "웹용 압축·게시"),
]


class Job:
    def __init__(self, job_dir: Path):
        self.dir = job_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = job_dir / "status.json"
        self.state = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {
            "stages": {k: {"label": v, "status": "pending"} for k, v in STAGES}, "created": time.time()}

    def save(self):
        self.path.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")

    def done(self, stage):
        return self.state["stages"][stage]["status"] == "done"

    def start(self, stage):
        self.state["stages"][stage].update(status="running", started=time.time())
        self.state["current"] = stage
        self.save()

    def finish(self, stage, **info):
        s = self.state["stages"][stage]
        s.update(status="done", finished=time.time(), seconds=round(time.time() - s.get("started", time.time()), 1), info=info)
        self.save()

    def fail(self, stage, err):
        self.state["stages"][stage].update(status="error", error=str(err))
        self.state["error"] = str(err)
        self.save()


def run_job(inputs: list[Path], name: str, title: str, *, panorama: bool = False, steps: int = 30000, max_resolution: int = 1024,
            max_splats: int = 1_500_000, capture_height: float = 1.45, job_root: Path | None = None,
            backend: str = "brush", max_side: int | None = None, test_every: int = 8) -> Path:
    """backend: "brush" (this laptop) or "cloud" (rented CUDA GPU, gsplat,
    full resolution; thesis quality). test_every=0 trains the cloud model on
    every photo (best for showing; no held-out score), 8 keeps a test split."""
    from .build_tour import build_tour
    from .frames import ingest
    from .sfm import run_panorama_sfm, run_sfm
    from .train import train_brush

    job = Job((job_root or ROOT / "data" / "jobs") / name)
    job.state.update(name=name, title=title, inputs=[str(p) for p in inputs], panorama=panorama)
    job.save()
    images = job.dir / "images"
    stage = None
    try:
        stage = "ingest"
        if not job.done(stage):
            job.start(stage)
            side = max_side or (3840 if panorama else 3200 if backend == "cloud" else 1600)
            job.finish(stage, **ingest(inputs, images, max_side=side))
        stage = "sfm"
        if not job.done(stage):
            job.start(stage)
            ing = job.state["stages"]["ingest"].get("info", {})
            ordered = ing.get("frames", 0) > ing.get("photos", 0)  # mostly video frames → capture order is spatial order
            info = run_panorama_sfm(images, job.dir / "sfm") if panorama else run_sfm(images, job.dir / "sfm", ordered=ordered)
            job.finish(stage, **info)
        dataset = Path(job.state["stages"]["sfm"]["info"]["dataset"])
        stage = "train"
        if not job.done(stage):
            job.start(stage)
            if backend == "cloud":
                from .cloud import train_gsplat_cloud

                def progress(d):
                    job.state["stages"]["train"]["progress"] = d
                    job.save()
                job.finish(stage, **train_gsplat_cloud(dataset, job.dir / "train", steps=steps, progress=progress,
                                                           test_every=test_every or 10**9))
            else:
                job.finish(stage, **train_brush(dataset, job.dir / "train", steps=steps, max_resolution=max_resolution, max_splats=max_splats))
        ply = Path(job.state["stages"]["train"]["info"]["ply"])
        stage = "tour"
        scene_dir = ROOT / "scenes" / name
        if not job.done(stage):
            job.start(stage)
            model = dataset / "sparse" / "0" if (dataset / "sparse" / "0").exists() else Path(job.state["stages"]["sfm"]["info"]["model"])
            job.finish(stage, **build_tour(model, ply, scene_dir, title=title, capture_height=capture_height))
        stage = "export"
        if not job.done(stage):
            job.start(stage)
            job.finish(stage, **export_web(scene_dir))
        # Source photos for the viewer's "원본 사진" (a failure here must not fail the tour)
        try:
            from .photos import export_photos
            model = dataset / "sparse" / "0" if (dataset / "sparse" / "0").exists() else Path(job.state["stages"]["sfm"]["info"]["model"])
            job.state["photos"] = export_photos(name, model, dataset / "images")
        except Exception as e:  # noqa: BLE001
            job.state["photos_error"] = str(e)
        job.state["current"] = None
        job.state["scene"] = name
        job.save()
    except Exception as e:  # noqa: BLE001 — surface any failure to the UI
        job.fail(stage, f"{e}\n{traceback.format_exc(limit=3)}")
        raise
    return job.dir


def export_web(scene_dir: Path, floaters: bool = False, fmt: str = "spz") -> dict:
    """scene.ply → scene.spz (≈11× smaller, CPU-only, seconds) or .sog
    (≈15×, needs a working WebGPU device), removing NaNs (and optionally
    floaters), and point tour.json at it. The .ply is kept for analysis."""
    src = scene_dir / "scene.ply"
    dst = scene_dir / f"scene.{fmt}"
    t0 = time.time()
    if fmt == "spz" and not floaters:
        # In-house SPZ v2 encoder: Spark reads SPZ only up to v3, while
        # splat-transform writes v4.
        from .spz import ply_to_spz
        ply_to_spz(src, dst)
        # Phone variant: view-dependent colour cut to SH degree 1 (−30 % size,
        # −0.28 dB on playroom). The viewer picks it on touch devices.
        ply_to_spz(src, scene_dir / "scene.mobile.spz", max_sh=1)
    else:
        args = [str(SPLAT_TRANSFORM), "-w", str(src), "-N"]
        if floaters:
            args += ["-F"]
        args += [str(dst)]
        r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="ignore")
        if r.returncode != 0:
            raise RuntimeError(f"splat-transform failed: {r.stderr[-800:]}")
    tour_p = scene_dir / "tour.json"
    tour = json.loads(tour_p.read_text(encoding="utf-8"))
    tour["splat"] = dst.name
    if (scene_dir / "scene.mobile.spz").exists() and fmt == "spz":
        tour["splatMobile"] = "scene.mobile.spz"
    tour_p.write_text(json.dumps(tour, ensure_ascii=False, indent=2), encoding="utf-8")
    mob = scene_dir / "scene.mobile.spz"
    return {"web_mb": round(dst.stat().st_size / 1e6, 1), "mobile_mb": round(mob.stat().st_size / 1e6, 1) if mob.exists() else None, "format": fmt, "ply_mb": round(src.stat().st_size / 1e6, 1), "seconds": round(time.time() - t0, 1)}
