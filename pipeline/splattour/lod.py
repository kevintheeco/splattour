"""Phone streaming files for a scene (level-of-detail tree + baked extras).

The phone viewer streams scenes/<name>/lod/ (see viewer/src/main.js):
  scene-lod.rad + scene-lod-<n>.radc   LoD tree from Spark's build-lod, SH3, chunked
  occupancy.bin, plan.png, thumbs/     baked by viewer/scripts/bake-lod-aux.mjs
They are too big for the Vercel bundle, so they live in R2 under the same
path; web-api/build.sh points the deployed tour.json there.

  python -m splattour.lod build <scene>     # run build-lod on scene.ply (needs tools/build-lod)
  python -m splattour.lod publish <scene>   # upload lod/ to R2 (scenes/<scene>/lod/...)
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUILD_LOD = ROOT / "tools" / "build-lod" / "build-lod.exe"


def build(name: str) -> dict:
    """bhatt ("quality") LoD tree from the full-precision PLY, chunked for streaming."""
    sdir = ROOT / "scenes" / name
    out = sdir / "lod"
    out.mkdir(exist_ok=True)
    src = out / "scene.ply"  # build-lod writes <stem>-lod* next to its input
    shutil.copyfile(sdir / "scene.ply", src)
    try:
        log = subprocess.run([str(BUILD_LOD), "--quality", "--rad-chunked", src.name], cwd=out, capture_output=True, text=True, check=True).stdout
    finally:
        src.unlink(missing_ok=True)
    (out / "build-lod.log").write_text(log, encoding="utf-8")
    chunks = sorted(out.glob("scene-lod-*.radc"))
    return {"chunks": len(chunks), "mb": round(sum(p.stat().st_size for p in chunks) / 1e6, 1)}


def publish(name: str) -> dict:
    from .inbox import BUCKET, _put, client, keys

    k = keys()
    if not k:
        raise SystemExit("secrets/r2.txt missing R2 keys")
    s3 = client(k)
    ldir = ROOT / "scenes" / name / "lod"
    files = [p for p in ldir.rglob("*") if p.is_file() and p.suffix != ".log" and p.name != "scene.ply"]
    if not (ldir / "scene-lod.rad").exists():
        raise SystemExit(f"{ldir}/scene-lod.rad missing")
    # header last, so a viewer never sees a header whose chunks are not up yet
    files.sort(key=lambda p: p.name == "scene-lod.rad")
    body, header = files[:-1], files[-1]
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda p: _put(s3, p, f"scenes/{name}/lod/{p.relative_to(ldir).as_posix()}"), body))
    _put(s3, header, f"scenes/{name}/lod/{header.name}")
    return {"bucket": BUCKET, "files": len(files), "mb": round(sum(p.stat().st_size for p in files) / 1e6, 1)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "publish"])
    ap.add_argument("scene")
    a = ap.parse_args()
    print(json.dumps(build(a.scene) if a.cmd == "build" else publish(a.scene)))
    sys.exit(0)
