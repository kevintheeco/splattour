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

    a = ap.parse_args(argv)
    if a.cmd == "tour":
        from .build_tour import build_tour

        rep = build_tour(a.model, a.splat, ROOT / "scenes" / a.name, title=a.title or a.name, subtitle=a.subtitle,
                         capture_height=a.capture_height, spacing=a.spacing, max_edge=a.max_edge)
        print(json.dumps(rep, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
