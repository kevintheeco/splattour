"""Publish the source photos next to a scene so the viewer can show what the
3D space was made from ("원본 사진").

    python -m splattour.photos <scene> <model_dir> <images_dir> [--full 1600] [--thumb 360]

Writes scenes/<scene>/photos/{t,f}/<name>.webp (thumbnail, full view) and
photos.json with each photo's exact camera pose in the viewer's world frame,
so a photo can be opened *from where it was taken* and laid over the render.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from .colmap_io import read_model, qvec_to_rotmat
from .eval_views import FLIP, ROOT, mat_to_quat_xyzw, quat_xyzw_to_mat


def _fit(img: np.ndarray, side: int) -> np.ndarray:
    h, w = img.shape[:2]
    s = side / max(h, w)
    return img if s >= 1 else cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)


def _write_webp(path: Path, img: np.ndarray, q: int) -> int:
    ok, buf = cv2.imencode(".webp", img, [cv2.IMWRITE_WEBP_QUALITY, q])
    if not ok:
        raise RuntimeError(f"webp encode failed: {path.name}")
    path.write_bytes(buf.tobytes())
    return len(buf)


def export_photos(scene: str, model_dir: Path, images_dir: Path, full: int = 1600, thumb: int = 360, quality: int = 82) -> dict:
    sdir = ROOT / "scenes" / scene
    tour_p = sdir / "tour.json"
    tour = json.loads(tour_p.read_text(encoding="utf-8"))
    t = tour.get("splatTransform") or {}
    P = np.array(t.get("position", [0, 0, 0]), float)
    Rq = quat_xyzw_to_mat(t.get("quaternion", [0, 0, 0, 1]))
    s = float(t.get("scale", 1.0))

    out = sdir / "photos"
    (out / "t").mkdir(parents=True, exist_ok=True)
    (out / "f").mkdir(parents=True, exist_ok=True)
    m = read_model(model_dir)
    photos, total = [], 0
    for im in m.images_sorted():  # capture order (file names are sequential)
        src = images_dir / im.name
        img = cv2.imdecode(np.fromfile(str(src), np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            continue
        stem = Path(im.name).with_suffix("").as_posix().replace("/", "__")  # rig views: pano_camera<i>/<frame> share the frame name
        total += _write_webp(out / "f" / f"{stem}.webp", _fit(img, full), quality)
        total += _write_webp(out / "t" / f"{stem}.webp", _fit(img, thumb), 72)
        cam = m.cameras[im.camera_id]
        fy = cam.params[1] if cam.model in ("PINHOLE", "OPENCV") else cam.params[0]
        R_c2w = qvec_to_rotmat(im.qvec).T
        C = -R_c2w @ im.tvec
        photos.append({
            "name": im.name, "file": stem + ".webp", "w": int(cam.width), "h": int(cam.height),
            "fovY": round(float(np.degrees(2 * np.arctan(cam.height / (2 * fy)))), 3),
            "position": [round(v, 4) for v in (P + s * Rq @ C).tolist()],
            "quaternion": [round(v, 5) for v in mat_to_quat_xyzw(Rq @ R_c2w @ FLIP)],
        })
    (out / "photos.json").write_text(json.dumps({"count": len(photos), "photos": photos}, ensure_ascii=False), encoding="utf-8")
    tour["photos"] = "photos/photos.json"
    tour_p.write_text(json.dumps(tour, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"count": len(photos), "mb": round(total / 1e6, 1)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("scene"); ap.add_argument("model"); ap.add_argument("images")
    ap.add_argument("--full", type=int, default=1600); ap.add_argument("--thumb", type=int, default=360)
    ap.add_argument("--quality", type=int, default=82)
    a = ap.parse_args()
    print(json.dumps(export_photos(a.scene, Path(a.model), Path(a.images), a.full, a.thumb, a.quality), ensure_ascii=False))
