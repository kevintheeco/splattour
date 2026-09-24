"""Retrain an existing job's SfM dataset on the cloud GPU and publish it as a
new scene, so laptop and cloud results can be compared side by side.

    python -m splattour.retrain playroom playroom-hq "Playroom (클라우드 고화질)" [cap_max=2000000] [steps=30000] [test_every=8]

test_every=0 trains on every photo (the display model); keep 8 for the scored run.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from .build_tour import build_tour
from .cloud import train_gsplat_cloud
from .run import ROOT, export_web


def main(job: str, scene: str, title: str, cap_max: str = "2000000", steps: str = "30000", test_every: str = "8") -> None:
    jdir = ROOT / "data" / "jobs" / job
    st = json.loads((jdir / "status.json").read_text(encoding="utf-8"))
    dataset = Path(st["stages"]["sfm"]["info"]["dataset"])
    out = ROOT / "data" / "jobs" / scene / "train"
    status = out.parent / "progress.json"
    out.mkdir(parents=True, exist_ok=True)

    def progress(d):
        status.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        print("PROGRESS", json.dumps(d, ensure_ascii=False), flush=True)

    info = train_gsplat_cloud(dataset, out, progress=progress, cap_max=int(cap_max), steps=int(steps),
                              test_every=int(test_every) or 10**9)  # gsplat holds out i % n == 0: 10**9 keeps only image 0 out
    print("TRAINED", json.dumps(info, ensure_ascii=False), flush=True)
    scene_dir = ROOT / "scenes" / scene
    rep = build_tour(dataset / "sparse" / "0", Path(info["ply"]), scene_dir, title=title)
    web = export_web(scene_dir)
    (out.parent / "result.json").write_text(json.dumps({"train": info, "tour": rep["graph"], "web": web}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("DONE", json.dumps({"psnr": info.get("eval_psnr"), "ssim": info.get("eval_ssim"), "cost_usd": info.get("cost_usd"), "web": web}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:7])
