"""Command line entry: python -m splattour <command> ..."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main(argv=None):
    ap = argparse.ArgumentParser(prog="splattour")
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("tour", help="COLMAP model + trained splat → scenes/<name>")
    t.add_argument("--model", required=True, help="COLMAP sparse model dir (or dataset root)")
    t.add_argument("--splat", required=True, help="trained 3DGS .ply")
    t.add_argument("--name", required=True, help="scene folder name under scenes/")
    t.add_argument("--title", default=None)
    t.add_argument("--subtitle", default="")
    t.add_argument("--capture-height", type=float, default=1.45)
    t.add_argument("--spacing", type=float, default=1.3)
    t.add_argument("--max-edge", type=float, default=4.0)

    r = sub.add_parser("run", help="captures (videos/photos/folders) → published tour")
    r.add_argument("inputs", nargs="+", type=Path)
    r.add_argument("--name", required=True)
    r.add_argument("--title", default=None)
    r.add_argument("--panorama", action="store_true", help="inputs are 360° equirectangular")
    r.add_argument("--steps", type=int, default=30000)
    r.add_argument("--max-resolution", type=int, default=1024)
    r.add_argument("--max-splats", type=int, default=1_500_000)
    r.add_argument("--capture-height", type=float, default=1.45)
    r.add_argument("--backend", default="brush", choices=["brush", "cloud"], help="cloud = rented CUDA GPU (gsplat, full resolution)")
    r.add_argument("--max-side", type=int, default=None, help="longest image side kept at ingest")

    e = sub.add_parser("export", help="scenes/<name>/scene.ply → scene.sog")
    e.add_argument("--name", required=True)
    e.add_argument("--floaters", action="store_true", help="also remove floaters (GPU voxel filter)")
    e.add_argument("--format", default="spz", choices=["spz", "sog"])

    a = ap.parse_args(argv)
    if a.cmd == "run":
        from .run import run_job

        d = run_job(a.inputs, a.name, a.title or a.name, panorama=a.panorama, steps=a.steps, max_resolution=a.max_resolution,
                    max_splats=a.max_splats, capture_height=a.capture_height, backend=a.backend, max_side=a.max_side)
        print((d / "status.json").read_text(encoding="utf-8"))
    if a.cmd == "export":
        from .run import export_web

        print(export_web(ROOT / "scenes" / a.name, floaters=a.floaters, fmt=a.format))
    if a.cmd == "tour":
        from .build_tour import build_tour

        rep = build_tour(a.model, a.splat, ROOT / "scenes" / a.name, title=a.title or a.name, subtitle=a.subtitle,
                         capture_height=a.capture_height, spacing=a.spacing, max_edge=a.max_edge)
        print(json.dumps(rep, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
