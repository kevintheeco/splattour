"""Top-down floor plan from a trained splat (for the spatial-understanding
task and for plotting study paths).

    python -m splattour.floorplan <scene> [--out plan.png] [--px 0.02] [--paths data/study]

Splat centres between knee and head height (0.3–2.0 m above the floor, in
the tour's aligned world frame) are splatted top-down, weighted by opacity;
dense columns (walls, furniture) come out dark. Viewpoints are drawn as
numbered dots. With --paths, every study session's 4 Hz pose trace is drawn
on top (one colour per condition).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from .eval_views import quat_xyzw_to_mat
from .splat_io import read_ply, sigmoid

ROOT = Path(__file__).resolve().parents[2]


def plan(scene: str, px: float = 0.02, band=(0.3, 2.0)):
    d = ROOT / "scenes" / scene
    tour = json.loads((d / "tour.json").read_text(encoding="utf-8"))
    f = read_ply(d / "scene.ply")
    xyz = np.stack([f["x"], f["y"], f["z"]], 1).astype(np.float64)
    op = sigmoid(f["opacity"].astype(np.float64))
    t = tour.get("splatTransform") or {}
    R = quat_xyzw_to_mat(t.get("quaternion", [0, 0, 0, 1]))
    w = np.array(t.get("position", [0, 0, 0])) + float(t.get("scale", 1)) * (R @ xyz.T).T
    nodes = tour["nodes"]
    floor = float(np.median([n["position"][1] - tour.get("eyeHeight", 1.45) for n in nodes]))
    keep = (w[:, 1] > floor + band[0]) & (w[:, 1] < floor + band[1]) & (op > 0.2) & np.all(np.isfinite(w), 1)
    w, op = w[keep], op[keep]
    # frame: cover the viewpoints plus the walls around them
    npos = np.array([n["position"] for n in nodes])
    lo = np.minimum(npos[:, [0, 2]].min(0) - 3, np.percentile(w[:, [0, 2]], 1, axis=0))
    hi = np.maximum(npos[:, [0, 2]].max(0) + 3, np.percentile(w[:, [0, 2]], 99, axis=0))
    W, H = (np.ceil((hi - lo) / px).astype(int) + 1)
    ij = np.floor((w[:, [0, 2]] - lo) / px).astype(int)
    ok = (ij[:, 0] >= 0) & (ij[:, 0] < W) & (ij[:, 1] >= 0) & (ij[:, 1] < H)
    acc = np.zeros((H, W), np.float64)
    np.add.at(acc, (ij[ok, 1], ij[ok, 0]), op[ok])
    acc = cv2.GaussianBlur(acc, (0, 0), 1.2)
    v = np.log1p(acc) / max(1e-9, np.log1p(np.percentile(acc[acc > 0], 97)))
    v = np.clip(v, 0, 1) ** 0.7  # darker walls
    # drop floaters: faint isolated specks outside the room
    mask = (v > 0.25).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    keep_lab = np.zeros(n, bool)
    keep_lab[1:] = stats[1:, cv2.CC_STAT_AREA] >= 25
    v = np.where(keep_lab[lab] | (v > 0.6), v, 0)
    img = (255 * (1 - v * 0.95)).astype(np.uint8)
    img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    to_px = lambda p: (int((p[0] - lo[0]) / px), int((p[2] - lo[1]) / px))  # noqa: E731
    return img, to_px, nodes


def straighten(img: np.ndarray) -> tuple[np.ndarray, float]:
    """Rotate so the dominant wall direction is axis-aligned (rooms are
    drawn square to the page). Angle from a gradient-orientation histogram,
    folded modulo 90 degrees."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    walls = (g < 110).astype(np.uint8) * 255
    lines = cv2.HoughLinesP(walls, 1, np.pi / 720, threshold=30, minLineLength=max(20, min(g.shape) // 10), maxLineGap=6)
    if lines is None:
        return img, 0.0, cv2.getRotationMatrix2D((g.shape[1] / 2, g.shape[0] / 2), 0, 1.0)
    L = lines.reshape(-1, 4).astype(np.float64)
    ang = np.degrees(np.arctan2(L[:, 3] - L[:, 1], L[:, 2] - L[:, 0])) % 90.0
    length = np.hypot(L[:, 2] - L[:, 0], L[:, 3] - L[:, 1])
    hist, edges = np.histogram(ang, bins=180, range=(0, 90), weights=length)
    hist = np.convolve(np.r_[hist[-2:], hist, hist[:2]], np.ones(5) / 5, "valid")
    a = float(edges[int(np.argmax(hist))] + 0.25)
    rot = a if a < 45 else a - 90
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), rot, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nw / 2 - w / 2
    M[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, M, (nw, nh), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255)), rot, M


def draw_nodes(img, to_px, nodes, numbers=True):
    for i, n in enumerate(nodes):
        x, y = to_px(n["position"])
        cv2.circle(img, (x, y), 9, (60, 90, 200), -1, cv2.LINE_AA)
        if numbers:
            cv2.putText(img, str(i + 1), (x + 11, y + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (40, 60, 160), 1, cv2.LINE_AA)


def draw_paths(img, to_px, study_dir: Path, scene: str):
    colours = {"splat": (40, 150, 60), "pano": (40, 90, 230)}
    n = 0
    for f in sorted(study_dir.glob("*/*.jsonl")):
        ev = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        start = next((e for e in ev if e.get("e") == "start"), {})
        if start.get("scene") != scene:
            continue
        pts = [to_px(e["p"]) for e in ev if e.get("e") == "pose"]
        if len(pts) > 1:
            cv2.polylines(img, [np.array(pts, np.int32)], False, colours.get(start.get("mode"), (120, 120, 120)), 2, cv2.LINE_AA)
            n += 1
    return n


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("scene")
    ap.add_argument("--out")
    ap.add_argument("--px", type=float, default=0.02)
    ap.add_argument("--paths", help="study log dir (data/study) to overlay walking paths")
    ap.add_argument("--blank", action="store_true", help="no viewpoint numbers (answer sheet for the sketch task)")
    a = ap.parse_args()
    img, to_px0, nodes = plan(a.scene, a.px)
    img, rot, M = straighten(img)
    print(f"rotated {rot:.1f} deg to square the walls")
    def to_px(p):
        x, y = to_px0(p)
        return (int(M[0, 0] * x + M[0, 1] * y + M[0, 2]), int(M[1, 0] * x + M[1, 1] * y + M[1, 2]))
    if not a.blank:
        draw_nodes(img, to_px, nodes)
    if a.paths:
        print(f"{draw_paths(img, to_px, Path(a.paths), a.scene)} paths drawn")
    # crop to the room (+ margin)
    ys, xs = np.where(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) < 200)
    if len(xs):
        m = 30
        img = img[max(0, ys.min() - m): ys.max() + m, max(0, xs.min() - m): xs.max() + m]
    out = Path(a.out or ROOT / "docs" / "checks" / f"plan-{a.scene}.png")
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imencode(".png", img)[1].tofile(str(out))
    print(out, img.shape[1], "x", img.shape[0])
