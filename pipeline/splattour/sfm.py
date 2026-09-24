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
PANO_SCRIPT = Path(os.environ.get("SPLATTOUR_PANO_SCRIPT", TOOLS / "colmap" / "examples" / "panorama_sfm.py"))


def _run(args: list[str], log: Path) -> None:
    with open(log, "a", encoding="utf-8") as f:
        f.write("\n$ " + " ".join(map(str, args)) + "\n")
        f.flush()
        r = subprocess.run([str(a) for a in args], stdout=f, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        raise RuntimeError(f"command failed ({r.returncode}): {args[1] if len(args) > 1 else args[0]} — see {log}")


def run_sfm(images: Path, work: Path, matcher: str = "auto", max_image_size: int = 1600, use_gpu: bool = False, mapper: str = "global",
            ordered: bool = False) -> dict:
    """images: folder of jpgs. work: output workspace. Returns timing + paths.
    Result: work/dense/{images, sparse/0} undistorted, ready for training."""
    if not Path(COLMAP).exists() or os.environ.get("SPLATTOUR_SFM") == "pycolmap":
        return run_sfm_pycolmap(images, work, matcher=matcher, max_image_size=max_image_size, ordered=ordered)
    work.mkdir(parents=True, exist_ok=True)
    log = work / "colmap.log"
    db = work / "database.db"
    if db.exists():
        db.unlink()
    n = len(list(images.glob("*.jpg")))
    if matcher == "auto":
        # Small sets: exhaustive. Larger *photo* sets are unordered (people walk
        # around a room and come back), so neighbours in file order are not
        # neighbours in space: match by image similarity (vocabulary tree).
        # Sequential here broke a 259-photo house (13k points, cameras misplaced,
        # PSNR 10.8, 2026-09-25). Video frames are ordered: sequential + loop detection.
        matcher = "exhaustive" if n <= 150 else ("sequential" if ordered else "vocab")
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
    elif matcher == "vocab":
        _run([COLMAP, "vocab_tree_matcher", "--database_path", db, "--FeatureMatching.use_gpu", gpu,
              "--VocabTreeMatching.num_images", str(min(60, max(20, n // 5)))], log)
    else:
        _run([COLMAP, "sequential_matcher", "--database_path", db, "--FeatureMatching.use_gpu", gpu,
              "--SequentialMatching.overlap", "15", "--SequentialMatching.quadratic_overlap", "1",
              "--SequentialMatching.loop_detection", "1"], log)
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


def _pick_matcher(n: int, ordered: bool) -> str:
    return "exhaustive" if n <= 150 else ("sequential" if ordered else "vocab")


def run_sfm_pycolmap(images: Path, work: Path, matcher: str = "auto", max_image_size: int = 1600, ordered: bool = False) -> dict:
    """Same steps and settings as run_sfm, through the pycolmap API (pycolmap-cuda12 on
    the cloud GPU: SIFT extraction and matching on the GPU). Used where the COLMAP
    executable is not installed (Linux GPU servers)."""
    iso = os.environ.get("SPLATTOUR_SFM_PYTHON")
    if matcher == "auto" and os.environ.get("SPLATTOUR_GPU") == "1":
        n_img = len(list(images.glob("*.jpg")))
        if n_img <= 1200 and not ordered:
            # On the GPU server the vocabulary-tree search (faiss) crashed on one host and
            # deadlocked on another (2026-09-25). Comparing every pair runs on the GPU and is
            # reliable at this size; matches are a superset of the vocab-tree ones.
            matcher = "exhaustive"
    if iso:  # (the isolated run itself clears this variable, see __main__; venv pythons resolve to the same binary, so no path check)
        # On the GPU server gsplat's tools ship a different package also named
        # "pycolmap"; SfM runs in its own environment to keep the two apart.
        import json as _json
        work.mkdir(parents=True, exist_ok=True)
        def cmd(m):
            try:
                return subprocess.run([iso, "-m", "splattour.sfm", str(images), str(work), m, str(max_image_size), "1" if ordered else "0"],
                                      capture_output=True, text=True, cwd=str(Path(__file__).resolve().parents[1]), timeout=3 * 3600)
            except subprocess.TimeoutExpired as e:  # a hang must fail loudly, not keep the GPU server busy
                return subprocess.CompletedProcess(e.cmd, 1, "", f"SfM timed out after 3 h (matcher {m}) faiss?")
        r = cmd(matcher)
        if r.returncode != 0 and "faiss" in (r.stderr + r.stdout) and matcher in ("auto", "vocab"):
            # the vocabulary-tree search (faiss) crashed on a GPU host (2026-09-25): compare
            # every pair on the GPU instead; slower, same or better matches
            (work / "sfm_stdout_vocab_failed.log").write_text(r.stdout + r.stderr, encoding="utf-8")
            r = cmd("exhaustive")
        (work / "sfm_stdout.log").write_text(r.stdout + r.stderr, encoding="utf-8")
        if r.returncode != 0:
            out = r.stderr or r.stdout
            key = [l for l in out.splitlines() if "Check failed" in l or l[:1] in ("F", "E") and l[1:5].isdigit()]
            raise RuntimeError("SfM failed: " + " | ".join(key[:3]) + " … " + out[-500:])
        return _json.loads(r.stdout.strip().splitlines()[-1])
    import pycolmap
    work.mkdir(parents=True, exist_ok=True)
    log = work / "colmap.log"
    db = work / "database.db"
    if db.exists():
        db.unlink()
    n = len(list(images.glob("*.jpg")))
    if matcher == "auto":
        matcher = _pick_matcher(n, ordered)
    dev = pycolmap.Device.cuda if pycolmap.has_cuda else pycolmap.Device.cpu
    t = {}
    t0 = time.time()
    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = "OPENCV"
    ext = pycolmap.FeatureExtractionOptions()
    ext.max_image_size = max_image_size
    pycolmap.extract_features(db, images, camera_mode=pycolmap.CameraMode.SINGLE, reader_options=reader, extraction_options=ext, device=dev)
    t["features"] = time.time() - t0
    t0 = time.time()
    if matcher == "exhaustive":
        pycolmap.match_exhaustive(db, device=dev)
    elif matcher == "vocab":
        po = pycolmap.VocabTreePairingOptions()
        po.num_images = min(60, max(20, n // 5))
        if os.environ.get("SPLATTOUR_VOCAB"):  # shipped with the runner (no download from the GPU server)
            po.vocab_tree_path = os.environ["SPLATTOUR_VOCAB"]
        pycolmap.match_vocabtree(db, pairing_options=po, device=dev)
    else:
        po = pycolmap.SequentialPairingOptions()
        po.overlap, po.quadratic_overlap, po.loop_detection = 15, True, True
        if os.environ.get("SPLATTOUR_VOCAB"):
            po.vocab_tree_path = os.environ["SPLATTOUR_VOCAB"]
        pycolmap.match_sequential(db, pairing_options=po, device=dev)
    t["matching"] = time.time() - t0
    t0 = time.time()
    sparse = work / "sparse"
    sparse.mkdir(exist_ok=True)
    recs = pycolmap.global_mapping(db, images, sparse)
    if not recs:
        raise RuntimeError("SfM produced no model")
    best = max(recs.values(), key=lambda r: r.num_reg_images())
    model = sparse / "best"
    model.mkdir(exist_ok=True)
    best.write(model)
    t["mapping"] = time.time() - t0
    t0 = time.time()
    dense = work / "dense"
    pycolmap.undistort_images(dense, model, images, output_type="COLMAP")
    s = dense / "sparse"
    if (s / "cameras.bin").exists():
        (s / "0").mkdir(exist_ok=True)
        for f in ("cameras.bin", "images.bin", "points3D.bin", "rigs.bin", "frames.bin"):
            if (s / f).exists():
                os.replace(s / f, s / "0" / f)
    t["undistort"] = time.time() - t0
    dropped = clean_model(s / "0", log)
    with open(log, "a", encoding="utf-8") as f:
        f.write(f"pycolmap {pycolmap.__version__} cuda={pycolmap.has_cuda} matcher={matcher} registered={best.num_reg_images()}/{n}\n")
    return {"images": n, "registered": best.num_reg_images(), "dropped_cameras": dropped, "matcher": matcher, "mapper": "global",
            "backend": f"pycolmap-{'cuda' if pycolmap.has_cuda else 'cpu'}", "seconds": {k: round(v, 1) for k, v in t.items()}, "dataset": str(dense)}


def run_panorama_sfm(images: Path, work: Path, matcher: str = "sequential") -> dict:
    """Equirectangular frames → virtual perspective rig → SfM."""
    work.mkdir(parents=True, exist_ok=True)
    log = work / "colmap.log"
    t0 = time.time()
    _run([os.environ.get("SPLATTOUR_SFM_PYTHON") or sys.executable, PANO_SCRIPT, "--input_image_path", images, "--output_path", work,
          "--matcher", matcher, "--mapper", "global", "--pano_render_type", "perspective_overlapping",
          *([] if os.environ.get("SPLATTOUR_GPU") == "1" else ["--use_cpu"])], log)
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
    if Path(COLMAP).exists():
        _run([COLMAP, "image_deleter", "--input_path", raw, "--output_path", model, "--image_names_path", names], log)
    else:  # no executable (cloud): same operation through pycolmap
        import pycolmap
        rec = pycolmap.Reconstruction(raw)
        drop = set(dropped)
        for iid, im in list(rec.images.items()):
            if im.name in drop:
                rec.deregister_frame(im.frame_id)
        rec.write(model)
    return dropped


def _largest_model(sparse: Path) -> Path:
    cands = [p.parent for p in sparse.rglob("images.bin")]
    if not cands:
        raise RuntimeError(f"SfM produced no model in {sparse}")
    return max(cands, key=lambda p: (p / "images.bin").stat().st_size)


if __name__ == "__main__":  # isolated SfM run (see run_sfm_pycolmap)
    import json as _json
    a = sys.argv[1:]
    os.environ.pop("SPLATTOUR_SFM_PYTHON", None)
    res = run_sfm_pycolmap(Path(a[0]), Path(a[1]), matcher=a[2], max_image_size=int(a[3]), ordered=a[4] == "1")
    print(_json.dumps(res))
