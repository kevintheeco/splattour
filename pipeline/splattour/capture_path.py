"""Capture trajectory + room labels for a scene, in the viewer's world frame.

Why: the study compares 360° fixed-viewpoint exploration (hotspots between capture points) with
3DGS free-viewpoint exploration, and both must cover the same space (docs/RESEARCH_DIRECTION.md).
The 3DGS walkable area is therefore clipped to where the capture went, and the 360 hotspot nodes
are later aligned to these positions.

    python -m splattour.capture_path <scene> <model_dir> [labels.json]

Writes scenes/<scene>/capture_path.json:
  frame            "viewer world": tour.json's splatTransform applied (y up, floor y=0, metres)
  cameras[]        every registered frame: name, frame index, position, yaw (rad, same convention
                   as tour.json nodes), room label
  rooms[]          {name, ranges: [[first, last], ...] frame indices, center, count}
  walkArea         the capture's footprint on the floor: a grid (cell m) of cells within `radius`
                   of the path, rows top (min z) to bottom as '0'/'1' strings
labels.json: {"default": "<room>", "segments": [{"room": "<room>", "from": <frame>, "to": <frame>}, ...]}
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np

from .colmap_io import qvec_to_rotmat, read_model

ROOT = Path(__file__).resolve().parents[2]


def _frame_index(name: str) -> int | None:
    m = re.findall(r"(\d+)", Path(name).stem)
    return int(m[-1]) if m else None


def _ranges(ix: list[int], gap: int = 3) -> list[list[int]]:
    out: list[list[int]] = []
    for i in sorted(ix):
        if out and i - out[-1][1] <= gap:
            out[-1][1] = i
        else:
            out.append([i, i])
    return out


def build(scene: str, model_dir: Path, labels: dict | None = None, radius: float = 1.0, cell: float = 0.25) -> dict:
    sdir = ROOT / "scenes" / scene
    tour = json.loads((sdir / "tour.json").read_text(encoding="utf-8"))
    tf = tour["splatTransform"]
    qx, qy, qz, qw = tf["quaternion"]
    R = qvec_to_rotmat(np.array([qw, qx, qy, qz]))
    s, t = float(tf["scale"]), np.array(tf["position"])
    model = read_model(model_dir)
    imgs = model.images_sorted()
    C = np.array([im.center for im in imgs])
    F = np.array([im.forward for im in imgs])
    P = t + s * (C @ R.T)
    Fw = F @ R.T
    yaw = np.arctan2(-Fw[:, 0], -Fw[:, 2])  # three.js: yaw 0 looks down -z

    def room_of(fi: int | None) -> str:
        if not labels or fi is None:
            return ""
        for seg in labels.get("segments", []):
            if seg["from"] <= fi <= seg["to"]:
                return seg["room"]
        return labels.get("default", "")

    cams = []
    for im, p, y in zip(imgs, P, yaw):
        fi = _frame_index(im.name)
        cams.append({"name": im.name, "frame": fi, "position": [round(float(v), 4) for v in p], "yaw": round(float(y), 4),
                     "room": room_of(fi)})
    rooms = []
    for name in dict.fromkeys(c["room"] for c in cams if c["room"]):
        sel = [c for c in cams if c["room"] == name]
        pos = np.array([c["position"] for c in sel])
        rooms.append({"name": name, "count": len(sel), "ranges": _ranges([c["frame"] for c in sel if c["frame"] is not None]),
                      "center": [round(float(v), 3) for v in pos.mean(0)],
                      "bbox_xz": [round(float(pos[:, 0].min()), 2), round(float(pos[:, 2].min()), 2),
                                  round(float(pos[:, 0].max()), 2), round(float(pos[:, 2].max()), 2)]})
    xz = P[:, [0, 2]]
    lo = xz.min(0) - radius - cell
    hi = xz.max(0) + radius + cell
    nx, nz = (np.ceil((hi - lo) / cell)).astype(int)
    gx = lo[0] + (np.arange(nx) + 0.5) * cell
    gz = lo[1] + (np.arange(nz) + 0.5) * cell
    G = np.stack(np.meshgrid(gx, gz), -1).reshape(-1, 2)
    inside = np.zeros(len(G), bool)
    for i in range(0, len(xz), 64):
        d = np.linalg.norm(G[:, None, :] - xz[None, i:i + 64, :], axis=2)
        inside |= (d <= radius).any(1)
    mask = inside.reshape(nz, nx)
    out = {
        "version": 1, "scene": scene, "frame": "viewer world (tour.json splatTransform applied; y up, floor y=0, metres)",
        "eyeHeight": tour.get("eyeHeight"), "source_model": str(model_dir), "count": len(cams),
        "camera_height_median": round(float(np.median(P[:, 1])), 3),
        "rooms": rooms, "cameras": cams,
        "walkArea": {"radius": radius, "cell": cell, "origin_xz": [round(float(lo[0]), 3), round(float(lo[1]), 3)], "nx": int(nx), "nz": int(nz),
                     "rows": ["".join("1" if v else "0" for v in row) for row in mask], "area_m2": round(float(mask.sum()) * cell * cell, 1)},
    }
    (sdir / "capture_path.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"cameras": len(cams), "rooms": [(r["name"], r["count"]) for r in rooms], "walk_area_m2": out["walkArea"]["area_m2"]}


if __name__ == "__main__":
    a = sys.argv[1:]
    lab = json.loads(Path(a[2]).read_text(encoding="utf-8")) if len(a) > 2 else None
    print(json.dumps(build(a[0], Path(a[1]), lab), ensure_ascii=False))
