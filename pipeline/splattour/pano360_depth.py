"""Metric depth for every panorama: Depth Anything V2 (monocular, relative) on 16 pinhole views of the
panorama, each view's inverse depth fitted to the SfM points that panorama observes (1/z = a*d + b),
assembled into an equirect ray-distance map (SfM units). Used by pano360_fill to re-project real
pixels of neighbouring frames (only geometry comes from here; colours always come from captured frames).

    python -m splattour.pano360_depth <pano360 work dir> <names...|all>     # runs the network (PANO360_SEG_PYTHON env)
The network part needs torch + transformers (the segmentation python); the fit needs pycolmap (pipeline venv).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

# (yaw, pitch) of the depth views, 100 deg FOV, square
DEPTH_VIEWS = [(y, 0.0) for y in range(0, 360, 45)] + [(y, 60.0) for y in (45, 135, 225, 315)] + [(y, -60.0) for y in (0, 90, 180, 270)]
FOV, SIZE = 100.0, 518


def _R(yaw_deg, pitch_deg):
    p, y = np.deg2rad([-pitch_deg, -yaw_deg])
    rx = np.array([[1, 0, 0], [0, np.cos(p), -np.sin(p)], [0, np.sin(p), np.cos(p)]])
    ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    return rx @ ry


def _sample(img, x, y):
    """bilinear sample of img at float coords (any number of points; cv2.remap caps rows at 32767)."""
    import cv2
    n = len(x)
    side = int(np.ceil(np.sqrt(max(n, 1))))
    pad = side * side - n
    xx = np.pad(x.astype(np.float32), (0, pad)).reshape(side, side)
    yy = np.pad(y.astype(np.float32), (0, pad)).reshape(side, side)
    return cv2.remap(img, xx, yy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).reshape(-1)[:n]


def _f():
    return SIZE / (2 * np.tan(np.deg2rad(FOV) / 2))


def _view_maps(W, H):
    f = _f()
    xs, ys = np.meshgrid(np.arange(SIZE) + 0.5, np.arange(SIZE) + 0.5)
    rays = np.stack([(xs - SIZE / 2) / f, (ys - SIZE / 2) / f, np.ones_like(xs)], -1)
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    out = []
    for yaw, pitch in DEPTH_VIEWS:
        rp = rays @ _R(yaw, pitch)
        u = ((1 + np.arctan2(rp[..., 0], rp[..., 2]) / np.pi) / 2 * W - 0.5).astype(np.float32)
        v = ((1 + 2 / np.pi * np.arctan2(rp[..., 1], np.linalg.norm(rp[..., [0, 2]], axis=-1))) / 2 * H - 0.5).astype(np.float32)
        out.append((u, v))
    return out


def run_network(work: Path, names: list[str]) -> dict:
    """disparity stacks work/depth/<name>.npy (16 x 518 x 518, float16). In the segmentation python."""
    import cv2
    import torch
    from PIL import Image
    from transformers import pipeline
    from .pano360 import _imread
    dev = 0 if torch.cuda.is_available() else -1
    pipe = pipeline("depth-estimation", model=os.environ.get("PANO360_DEPTH_MODEL", "depth-anything/Depth-Anything-V2-Small-hf"), device=dev)
    out = work / "depth"
    out.mkdir(exist_ok=True)
    W, H = 2048, 1024
    maps = _view_maps(W, H)
    t = time.time()
    n = 0
    for name in names:
        dst = out / f"{name}.npy"
        if dst.exists():
            continue
        pano = _imread(work / "equirect" / name)
        pano = cv2.resize(pano, (W, H), interpolation=cv2.INTER_AREA)
        views = [Image.fromarray(cv2.cvtColor(cv2.remap(pano, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP), cv2.COLOR_BGR2RGB))
                 for u, v in maps]
        res = pipe(views, batch_size=8)
        stack = np.stack([np.asarray(r["predicted_depth"], np.float32) for r in res])
        if stack.shape[1:] != (SIZE, SIZE):
            stack = np.stack([cv2.resize(s, (SIZE, SIZE), interpolation=cv2.INTER_LINEAR) for s in stack])
        np.save(dst, stack.astype(np.float16))
        n += 1
    return {"panoramas": n, "seconds": round(time.time() - t), "device": "cuda" if dev == 0 else "cpu"}


def ensure(work: Path, names: list[str]) -> dict:
    todo = [n for n in names if not (work / "depth" / f"{n}.npy").exists()]
    if not todo:
        return {"panoramas": 0}
    py = os.environ.get("PANO360_SEG_PYTHON") or sys.executable
    r = subprocess.run([py, "-m", "splattour.pano360_depth", str(work), *todo], cwd=str(Path(__file__).resolve().parents[1]),
                       capture_output=True, text=True, encoding="utf-8", errors="ignore")
    if r.returncode != 0:
        raise RuntimeError("depth network failed: " + (r.stderr or r.stdout)[-1500:])
    return json.loads(r.stdout.strip().splitlines()[-1])


class Observed:
    """SfM points each panorama observes. Reads the COLMAP binary files directly (no pycolmap: on the GPU
    server pycolmap lives in a separate environment and gsplat ships another package of that name)."""

    def __init__(self, model_dir: Path):
        import struct
        from .colmap_io import _read_images_bin
        ids, xyz = [], []
        with open(model_dir / "points3D.bin", "rb") as f:
            (n,) = struct.unpack("<Q", f.read(8))
            for _ in range(n):
                pid, x, y, z = struct.unpack("<Qddd", f.read(32))
                f.read(3 + 8)
                (t,) = struct.unpack("<Q", f.read(8))
                f.seek(8 * t, 1)
                ids.append(pid)
                xyz.append((x, y, z))
        ids = np.array(ids, np.int64)
        xyz = np.array(xyz)
        order = np.argsort(ids)
        ids, xyz = ids[order], xyz[order]
        acc: dict[str, list] = {}
        for im in _read_images_bin(model_dir / "images.bin").values():
            pano = im.name.split("/", 1)[-1]
            acc.setdefault(pano, []).append(im.point3d_ids[im.point3d_ids >= 0])
        self.by_pano: dict[str, np.ndarray] = {}
        for pano, lst in acc.items():
            u = np.unique(np.concatenate(lst)) if lst else np.zeros(0, np.int64)
            k = np.searchsorted(ids, u)
            ok = (k < len(ids)) & (ids[np.minimum(k, len(ids) - 1)] == u)
            self.by_pano[pano] = xyz[k[ok]] if ok.any() else np.zeros((0, 3))


def metric_depth(work: Path, name: str, C: np.ndarray, R: np.ndarray, pts: np.ndarray, W: int, H: int) -> tuple[np.ndarray, dict]:
    """Equirect ray distance (SfM units, W x H) for panorama `name` with centre C and R = R_pano_from_world."""
    import cv2
    stack = np.load(work / "depth" / f"{name}.npy").astype(np.float32)
    f = _f()
    P = (pts - C) @ R.T  # pano frame
    fits = []
    allx, ally = [], []
    per = []
    for i, (yaw, pitch) in enumerate(DEPTH_VIEWS):
        c = P @ _R(yaw, pitch).T
        ok = c[:, 2] > 1e-3
        x = c[ok, 0] / c[ok, 2] * f + SIZE / 2
        y = c[ok, 1] / c[ok, 2] * f + SIZE / 2
        ins = (x >= 0) & (x < SIZE - 1) & (y >= 0) & (y < SIZE - 1)
        z = c[ok, 2][ins]
        d = _sample(stack[i], x[ins], y[ins])
        per.append((d, 1 / z))
        allx.append(d)
        ally.append(1 / z)

    def fit(d, iz):
        if len(d) < 12:
            return None
        A = np.c_[d, np.ones_like(d)]
        keep = np.ones(len(d), bool)
        for _ in range(3):
            sol, *_ = np.linalg.lstsq(A[keep], iz[keep], rcond=None)
            r = np.abs(A @ sol - iz)
            keep = r < max(1e-9, 2.5 * np.median(r[keep]) * 1.4826)
            if keep.sum() < 8:
                break
        return sol if sol[0] > 0 else None
    glob = fit(np.concatenate(allx) if allx else np.zeros(0), np.concatenate(ally) if ally else np.zeros(0))
    maps = []
    for i, (d, iz) in enumerate(per):
        sol = fit(d, iz)
        fits.append({"view": i, "points": int(len(d)), "per_view": sol is not None})
        maps.append(sol if sol is not None else glob)
    if glob is None and all(m is None for m in maps):
        raise RuntimeError(f"{name}: too few SfM points to scale the depth")
    # assemble: every equirect pixel from the view whose axis is closest
    u_, v_ = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    yaw_, pitch_ = (2 * u_ / W - 1) * np.pi, (1 - 2 * v_ / H) * np.pi / 2
    dirs = np.stack([np.cos(pitch_) * np.sin(yaw_), -np.sin(pitch_), np.cos(pitch_) * np.cos(yaw_)], -1)
    axes = np.array([_R(y, p).T @ np.array([0, 0, 1.0]) for y, p in DEPTH_VIEWS])
    # soft blend of the fitted views (weights fall to 0 at 45 deg from a view axis): no seams between views
    cosang = dirs @ axes.T
    num = np.zeros((H, W), np.float32)
    den = np.zeros((H, W), np.float32)
    lim = np.cos(np.deg2rad(46))
    for i, (yaw, pitch) in enumerate(DEPTH_VIEWS):
        sol = maps[i]
        sel = cosang[..., i] > lim
        if sol is None or not sel.any():
            continue
        c = dirs[sel] @ _R(yaw, pitch).T
        x = (c[:, 0] / c[:, 2] * f + SIZE / 2 - 0.5).astype(np.float32)
        y = (c[:, 1] / c[:, 2] * f + SIZE / 2 - 0.5).astype(np.float32)
        d = _sample(stack[i], x, y)
        iz = np.maximum(sol[0] * d + sol[1], 1e-6)  # inverse along-axis depth
        inv_ray = iz * c[:, 2]  # inverse ray distance
        w = ((cosang[..., i][sel] - lim) / (1 - lim)) ** 2
        num[sel] += w * inv_ray
        den[sel] += w
    D = np.where(den > 0, 1 / np.maximum(num / np.maximum(den, 1e-9), 1e-6), np.inf).astype(np.float32)
    info = {"points": int(len(pts)), "views_fitted_individually": int(sum(x["per_view"] for x in fits)), "global_fit": glob is not None}
    return D, info


if __name__ == "__main__":
    w = Path(sys.argv[1])
    names = sys.argv[2:]
    if names == ["all"]:
        names = sorted(p.name for p in (w / "equirect").glob("*.jpg"))
    print(json.dumps(run_network(w, names)))
