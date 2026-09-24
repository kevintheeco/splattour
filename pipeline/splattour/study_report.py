"""Summarise user-study logs (viewer study.js → data/study/<pid>/<session>.jsonl)
into one row per session, ready for the thesis tables / statistics.

    python -m splattour.study_report [--out data/study/summary.csv]

Columns: pid, session, scene, mode (splat | pano), task, speed, vignette,
duration_s, moves, unique_nodes, path_m, zooms, approaches, mode_switches,
mean_dwell_s.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STUDY = ROOT / "data" / "study"


def summarize(events: list[dict]) -> dict:
    """Same definitions as viewer/src/study.js summarize()."""
    start = next((e for e in events if e.get("e") == "start"), {})
    moves = [e for e in events if e.get("e") == "depart"]
    arrives = [e for e in events if e.get("e") == "arrive"]
    path = [e["p"] for e in events if e.get("e") == "pose"]
    dist = sum(math.dist(path[i - 1], path[i]) for i in range(1, len(path)))
    t_end = events[-1]["t"] if events else 0
    dwell = [((arrives[i + 1]["t"] if i + 1 < len(arrives) else t_end) - a["t"]) / 1000 for i, a in enumerate(arrives)]
    return {
        "scene": start.get("scene", ""), "mode": start.get("mode", ""), "task": start.get("task", ""),
        "speed": start.get("speed", ""), "vignette": start.get("vignette", ""),
        "duration_s": round((t_end - (events[0]["t"] if events else 0)) / 1000, 1),
        "moves": len(moves),
        "unique_nodes": len({a.get("node") for a in arrives if a.get("node")}),
        "path_m": round(dist, 2),
        "zooms": sum(1 for e in events if e.get("e") == "zoom"),
        "approaches": sum(1 for e in events if e.get("e") == "approach"),
        "mode_switches": sum(1 for e in events if e.get("e") == "mode"),
        "mean_dwell_s": round(sum(dwell) / len(dwell), 1) if dwell else 0,
    }


def rows(study: Path = STUDY) -> list[dict]:
    out = []
    for f in sorted(study.glob("*/*.jsonl")):
        ev = []
        for line in f.read_text(encoding="utf-8").splitlines():
            try:
                ev.append(json.loads(line))
            except ValueError:
                pass
        ev.sort(key=lambda e: e.get("t", 0))
        out.append({"pid": f.parent.name, "session": f.stem, **summarize(ev)})
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(STUDY / "summary.csv"))
    a = ap.parse_args()
    rs = rows()
    if rs:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        with open(a.out, "w", newline="", encoding="utf-8-sig") as f:  # utf-8-sig: opens cleanly in Excel
            w = csv.DictWriter(f, fieldnames=list(rs[0].keys()))
            w.writeheader()
            w.writerows(rs)
    print(f"{len(rs)} sessions → {a.out}")
