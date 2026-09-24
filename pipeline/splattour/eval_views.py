"""Held-out view evaluation, apples to apples across trainers.

    python -m splattour.eval_views <scene> <model_dir> [--every 8] [--out views.json]

Writes the exact pose of every Nth COLMAP image (the trainers' test split)
in the *viewer's* world frame, so the web viewer can render precisely what the
photographer saw. `score` then compares those renders against the photos.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from .colmap_io import read_model, qvec_to_rotmat

ROOT = Path(__file__).resolve().parents[2]
FLIP = np.diag([1.0, -1.0, -1.0])  # OpenCV camera (+Y down, +Z fwd) → three.js (+Y up, -Z fwd)


def quat_xyzw_to_mat(q):
    x, y, z, w = q
    return qvec_to_rotmat(np.array([w, x, y, z]))


def mat_to_quat_xyzw(R):
    w = np.sqrt(max(0.0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = np.copysign(np.sqrt(max(0.0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2, R[2, 1] - R[1, 2])
    y = np.copysign(np.sqrt(max(0.0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2, R[0, 2] - R[2, 0])
    z = np.copysign(np.sqrt(max(0.0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2, R[1, 0] - R[0, 1])
    return [float(x), float(y), float(z), float(w)]


def views(scene: str, model_dir: Path, every: int = 8) -> list[dict]:
    tour = json.loads((ROOT / "scenes" / scene / "tour.json").read_text(encoding="utf-8"))
    t = tour.get("splatTransform") or {}
    P = np.array(t.get("position", [0, 0, 0]), float)
    Rq = quat_xyzw_to_mat(t.get("quaternion", [0, 0, 0, 1]))
    s = float(t.get("scale", 1.0))
    m = read_model(model_dir)
    imgs = m.images_sorted()
    out = []
    for i, im in enumerate(imgs):
        if i % every:
            continue
        cam = m.cameras[im.camera_id]
        fy = cam.params[1] if cam.model in ("PINHOLE", "OPENCV") else cam.params[0]
        R_c2w = qvec_to_rotmat(im.qvec).T
        C = -R_c2w @ im.tvec
        out.append({
            "name": im.name, "w": int(cam.width), "h": int(cam.height),
            "fovY": float(np.degrees(2 * np.arctan(cam.height / (2 * fy)))),
            "position": (P + s * Rq @ C).tolist(),
            "quaternion": mat_to_quat_xyzw(Rq @ R_c2w @ FLIP),
        })
    return out


def _ssim(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a.astype(np.float64), b.astype(np.float64)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    g = lambda x: cv2.GaussianBlur(x, (11, 11), 1.5)  # noqa: E731
    mu_a, mu_b = g(a), g(b)
    sa, sb, sab = g(a * a) - mu_a ** 2, g(b * b) - mu_b ** 2, g(a * b) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + C1) * (2 * sab + C2)) / ((mu_a ** 2 + mu_b ** 2 + C1) * (sa + sb + C2))
    return float(m.mean())


def score(render_dir: Path, images_dir: Path) -> dict:
    """PSNR / SSIM of every render against the photo with the same name."""
    rows = []
    for r in sorted(render_dir.glob("*.png")):
        name = r.stem
        gt_p = next((p for p in images_dir.glob(name + ".*")), None)
        if gt_p is None:
            continue
        rd = cv2.imdecode(np.fromfile(str(r), np.uint8), cv2.IMREAD_COLOR)
        gt = cv2.imdecode(np.fromfile(str(gt_p), np.uint8), cv2.IMREAD_COLOR)
        if rd.shape != gt.shape:
            rd = cv2.resize(rd, (gt.shape[1], gt.shape[0]), interpolation=cv2.INTER_AREA)
        mse = np.mean((rd.astype(np.float64) - gt.astype(np.float64)) ** 2)
        psnr = 10 * np.log10(255 ** 2 / max(mse, 1e-10))
        ssim = np.mean([_ssim(rd[..., c], gt[..., c]) for c in range(3)])
        rows.append({"name": name, "psnr": round(psnr, 2), "ssim": round(ssim, 4)})
    return {"n": len(rows), "psnr": round(float(np.mean([r["psnr"] for r in rows])), 2) if rows else None,
            "ssim": round(float(np.mean([r["ssim"] for r in rows])), 4) if rows else None, "views": rows}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("views"); v.add_argument("scene"); v.add_argument("model"); v.add_argument("--every", type=int, default=8); v.add_argument("--out")
    sc = sub.add_parser("score"); sc.add_argument("renders"); sc.add_argument("images")
    a = ap.parse_args()
    if a.cmd == "views":
        vs = views(a.scene, Path(a.model), a.every)
        txt = json.dumps(vs, indent=1)
        (Path(a.out).write_text(txt, encoding="utf-8") if a.out else print(txt))
        print(f"{len(vs)} views", flush=True)
    else:
        print(json.dumps(score(Path(a.renders), Path(a.images)), ensure_ascii=False, indent=1))
