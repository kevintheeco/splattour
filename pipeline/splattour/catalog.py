"""Scene list for the home page: scenes/index.json (name, title, counts, cover).

    python -m splattour.catalog [scene ...]      # default: every scene folder

The cover is the source photo taken at the tour's start viewpoint when the
scene ships photos (splattour.photos), so the list shows real pictures.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from .eval_views import ROOT


def entry(sdir: Path) -> dict | None:
    tp = sdir / "tour.json"
    if not tp.exists():
        return None
    t = json.loads(tp.read_text(encoding="utf-8"))
    e = {"name": sdir.name, "title": t.get("title") or sdir.name, "subtitle": t.get("subtitle", ""), "nodes": len(t.get("nodes", []))}
    pj = sdir / "photos" / "photos.json"
    if pj.exists():
        e["photos"] = json.loads(pj.read_text(encoding="utf-8"))["count"]
        start = next((n for n in t.get("nodes", []) if n.get("id") == t.get("start")), None) or (t.get("nodes") or [{}])[0]
        stem = Path(start.get("image", "")).stem
        if stem and (sdir / "photos" / "f" / f"{stem}.webp").exists():
            e["cover"] = f"photos/f/{stem}.webp"
    return e


def build(names: list[str] | None = None, root: Path = ROOT / "scenes") -> dict:
    dirs = [root / n for n in names] if names else sorted(p for p in root.iterdir() if p.is_dir())
    cat = {"scenes": [e for d in dirs if (e := entry(d))]}
    (root / "index.json").write_text(json.dumps(cat, ensure_ascii=False, indent=1), encoding="utf-8")
    return cat


if __name__ == "__main__":
    print(json.dumps(build(sys.argv[1:] or None), ensure_ascii=False, indent=1))
