"""Structure-from-Motion with COLMAP 4 (CPU build works on any laptop).

    feature_extractor → matcher → global_mapper (GLOMAP, merged into COLMAP 4)
    → image_undistorter (PINHOLE, what every 3DGS trainer expects)

360 captures go through COLMAP's panorama rig workflow instead
(`panorama_sfm.py`): each equirectangular frame becomes a rig of virtual
perspective cameras with a shared centre, which constrains SfM strongly
and gives the trainer ordinary pinhole images.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools"
COLMAP = os.environ.get("SPLATTOUR_COLMAP", str(TOOLS / "colmap" / "bin" / "colmap.exe"))
PANO_SCRIPT = TOOLS / "colmap" / "examples" / "panorama_sfm.py"


def _run(args: list[str], log: Path) -> None:
    with open(log, "a", encoding="utf-8") as f:
        f.write("\n$ " + " ".join(map(str, args)) + "\n")
        f.flush()
        r = subprocess.run([str(a) for a in args], stdout=f, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        raise RuntimeError(f"command failed ({r.returncode}): {args[1] if len(args) > 1 else args[0]} — see {log}")


def run_sfm(images: Path, work: Path, matcher: str = "auto", max_image_size: int = 1600, use_gpu: bool = False, mapper: str = "global") -> dict:
    """images: folder of jpgs. work: output workspace. Returns timing + paths.
    Result: work/dense/{images, sparse/0} undistorted, ready for training."""
    work.mkdir(parents=True, exist_ok=True)
    log = work / "colmap.log"
    db = work / "database.db"
    if db.exists():
        db.unlink()
    n = len(list(images.glob("*.jpg")))
    if matcher == "auto":
        # video frames are ordered: sequential matching with loop detection is
        # linear-time; small unordered photo sets can afford exhaustive.
        matcher = "exhaustive" if n <= 150 else "sequential"
    gpu = "1" if use_gpu else "0"
    t = {}
    t0 = time.time()
    _run([COLMAP, "feature_extractor", "--database_path", db, "--image_path", images,
          "--ImageReader.single_camera", "1", "--ImageReader.camera_model", "OPENCV",
          "--FeatureExtraction.use_gpu", gpu, "--FeatureExtraction.max_image_size", max_image_size], log)
    t["features"] = time.time() - t0
    t0 = time.time()
    if matcher == "exhaustive":
        _run([COLMAP, "exhaustive_matcher", "--database_path", db, "--FeatureMatching.use_gpu", gpu], log)
    else:
        _run([COLMAP, "sequential_matcher", "--database_path", db, "--FeatureMatching.use_gpu", gpu,
              "--SequentialMatching.overlap", "15", "--SequentialMatching.quadratic_overlap", "1"], log)
    t["matching"] = time.time() - t0
    t0 = time.time()
    sparse = work / "sparse"
    sparse.mkdir(exist_ok=True)
    if mapper == "global":
        _run([COLMAP, "global_mapper", "--database_path", db, "--image_path", images, "--output_path", sparse], log)
    else:
        _run([COLMAP, "mapper", "--database_path", db, "--image_path", images, "--output_path", sparse], log)
    t["mapping"] = time.time() - t0
    model = _largest_model(sparse)
    t0 = time.time()
    dense = work / "dense"
    _run([COLMAP, "image_undistorter", "--image_path", images, "--input_path", model, "--output_path", dense, "--output_type", "COLMAP"], log)
    # trainers expect sparse/0
    s = dense / "sparse"
    if (s / "cameras.bin").exists():
        (s / "0").mkdir(exist_ok=True)
        for f in ("cameras.bin", "images.bin", "points3D.bin", "rigs.bin", "frames.bin"):
            if (s / f).exists():
                os.replace(s / f, s / "0" / f)
    t["undistort"] = time.time() - t0
    dropped = clean_model(s / "0", log)
    return {"images": n, "dropped_cameras": dropped, "matcher": matcher, "mapper": mapper, "seconds": {k: round(v, 1) for k, v in t.items()}, "dataset": str(dense)}


def run_panorama_sfm(images: Path, work: Path, matcher: str = "sequential") -> dict:
    """Equirectangular frames → virtual perspective rig → SfM."""
    work.mkdir(parents=True, exist_ok=True)
    log = work / "colmap.log"
    t0 = time.time()
    _run([sys.executable, PANO_SCRIPT, "--input_image_path", images, "--output_path", work,
          "--matcher", matcher, "--mapper", "global", "--pano_render_type", "perspective_overlapping", "--use_cpu"], log)
    model = _largest_model(work / "sparse")
    return {"images": len(list(images.glob("*.jpg"))), "mode": "panorama-rig", "seconds": {"total": round(time.time() - t0, 1)},
            "dataset": str(work), "model": str(model)}


def clean_model(model: Path, log: Path) -> list[str]:
    """Delete mis-registered cameras from the model *before training*.
    Global SfM occasionally throws a few views kilometres away; trainers size
    the scene (and their learning rates) from the camera spread, so a single
    such camera makes every Gaussian drift away and die (gsplat MCMC then
    crashes on an empty relocation). The original model is kept in <model>_raw."""
    from .colmap_io import read_model
    m = read_model(model)
    dropped = m.drop_outlier_cameras()
    if not dropped:
        return []
    raw = model.parent / (model.name + "_raw")
    if raw.exists():
        import shutil
        shutil.rmtree(raw)
    model.rename(raw)
    names = raw / "dropped.txt"
    names.write_bytes(chr(10).join(dropped).encode("utf-8"))
    model.mkdir()
    _run([COLMAP, "image_deleter", "--input_path", raw, "--output_path", model, "--image_names_path", names], log)
    return dropped


def _largest_model(sparse: Path) -> Path:
    cands = [p.parent for p in sparse.rglob("images.bin")]
    if not cands:
        raise RuntimeError(f"SfM produced no model in {sparse}")
    return max(cands, key=lambda p: (p / "images.bin").stat().st_size)
