"""Thesis figures from a pano360 cloud run that recorded its training (pano360_trainfig.py).

    python -m splattour.figures <name>            # e.g. wolhajeong360-hq, after `pano360 fetch --name <name>`

Reads data/pano360/<name>/cloud/figures/ (training/, pipeline/) and sparse/, writes docs/figures/:
  training/<view>/<iter>.png              the raw snapshots (copied)
  training/montage_<view>.jpg             iteration montage per fixed view (0, 500, 1k, ..., final + ground truth)
  training/primitives_<view>.jpg          final render | Gaussians shrunk to 30% | Gaussians at 1/4 opacity
  training/curves.png                     Gaussian count, held-out PSNR/SSIM and train loss vs iteration
  pipeline/stages.jpg                     360 frame -> perspective views -> person masks -> SfM -> Gaussians -> render
  pipeline/sfm_points_cameras.jpg         sparse SfM points + camera trajectory (top view and oblique view)
"""
from __future__ import annotations

import csv
import json
import shutil
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def _read(p):
    from .pano360 import _imread
    return _imread(p)


def _label(img, text, h=36):
    import cv2
    out = np.full((img.shape[0] + h, img.shape[1], 3), 255, np.uint8)
    out[h:] = img
    cv2.putText(out, text, (8, h - 11), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (20, 20, 20), 2, cv2.LINE_AA)
    return out


def _fit(img, w):
    import cv2
    return cv2.resize(img, (w, int(round(img.shape[0] * w / img.shape[1]))), interpolation=cv2.INTER_AREA)


def _grid(tiles, cols, gap=6):
    h = max(t.shape[0] for t in tiles)
    w = max(t.shape[1] for t in tiles)
    rows = (len(tiles) + cols - 1) // cols
    out = np.full((rows * (h + gap) - gap, cols * (w + gap) - gap, 3), 255, np.uint8)
    for k, t in enumerate(tiles):
        r, c = divmod(k, cols)
        out[r * (h + gap): r * (h + gap) + t.shape[0], c * (w + gap): c * (w + gap) + t.shape[1]] = t
    return out


def _it_label(tag):
    if tag == "final":
        return "final"
    it = int(tag)
    return "init (SfM points)" if it == 0 else (f"{it // 1000}k" if it % 1000 == 0 else str(it))


def montages(tr: Path, out: Path) -> list[str]:
    from .pano360 import _imwrite
    made = []
    for vd in sorted((tr / "views").glob("*")):
        tags = sorted([p.stem for p in vd.glob("0*.png")]) + (["final"] if (vd / "final.png").exists() else [])
        dst = out / vd.name
        dst.mkdir(parents=True, exist_ok=True)
        for p in vd.glob("*.png"):
            shutil.copyfile(p, dst / (p.name if not p.stem.isdigit() else f"{int(p.stem)}.png"))
        tiles = [_label(_fit(_read(vd / f"{t}.png"), 640), f"iteration {_it_label(t)}") for t in tags]
        if (vd / "gt.png").exists():
            tiles.append(_label(_fit(_read(vd / "gt.png"), 640), "photo (training view)"))
        if tiles:
            _imwrite(out / f"montage_{vd.name}.jpg", _grid(tiles, 4), [1, 95])
            made.append(f"montage_{vd.name}.jpg")
        prim = [(n, t) for n, t in (("final.png", "final render"), ("final_ellipsoids.png", "Gaussians at 30% size, base colour"),
                                     ("final_lowopacity.png", "Gaussians at 1/4 opacity")) if (vd / n).exists()]
        if prim:
            _imwrite(out / f"primitives_{vd.name}.jpg", _grid([_label(_fit(_read(vd / n), 800), t) for n, t in prim], len(prim)), [1, 95])
            made.append(f"primitives_{vd.name}.jpg")
    return made


def _csv(p):
    if not p.exists():
        return []
    with open(p, newline="") as f:
        return list(csv.DictReader(f))


def curves(tr: Path, out: Path) -> str | None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    cnt, ev, loss = _csv(tr / "counts.csv"), _csv(tr / "eval.csv"), _csv(tr / "loss.csv")
    if not (cnt or ev or loss):
        return None
    fig, ax = plt.subplots(1, 3, figsize=(15, 4.2))
    if cnt:
        x = [int(r["step"]) for r in cnt]
        ax[0].plot(x, [int(r["gaussians"]) / 1e6 for r in cnt], color="#2b6cb0")
        ax[0].set_ylabel("Gaussians (millions)")
        a2 = ax[0].twinx()
        a2.plot(x, [100 * float(r["dead_share"]) for r in cnt], color="#c05621", lw=0.8, alpha=0.7)
        a2.set_ylabel("share with opacity <= 0.005 (%)", color="#c05621")
        ax[0].set_title("Number of Gaussians")
    if ev:
        x = [int(r["iteration"]) for r in ev]
        ax[1].plot(x, [float(r["psnr"]) for r in ev], "o-", ms=3, color="#2f855a")
        ax[1].set_ylabel("held-out PSNR (dB)")
        a3 = ax[1].twinx()
        a3.plot(x, [float(r["ssim"]) for r in ev], "s-", ms=2, color="#6b46c1", lw=0.8)
        a3.set_ylabel("SSIM", color="#6b46c1")
        ax[1].set_title(f"Held-out views ({ev[0]['views']} photos not used for training)")
    if loss:
        key = next((k for k in loss[0] if k.endswith("/loss")), None)
        if key:
            pts = [(int(r["step"]), float(r[key])) for r in loss if r.get(key)]
            ax[2].plot([p[0] for p in pts], [p[1] for p in pts], color="#444", lw=0.7)
            ax[2].set_yscale("log")
            ax[2].set_ylabel("training loss")
            ax[2].set_title("Training loss (L1 + SSIM)")
    for a in ax:
        a.set_xlabel("iteration")
        a.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out / "curves.png", dpi=160)
    plt.close(fig)
    return "curves.png"


def sparse_figure(sparse: Path, out: Path) -> str | None:
    """SfM points + camera centres, drawn on the CPU (no GPU needed): top view and an oblique view."""
    import cv2

    from .colmap_io import read_model
    from .pano360 import _imwrite
    if not (sparse / "points3D.bin").exists():
        return None
    m = read_model(sparse)
    xyz = m.xyz
    rgb = m.rgb if hasattr(m, "rgb") and m.rgb is not None and len(m.rgb) == len(xyz) else np.full((len(xyz), 3), 128)
    ims = sorted((im for im in m.images.values() if im.name.startswith("pano_camera0/")), key=lambda im: im.name) or         sorted(m.images.values(), key=lambda im: im.name)
    ims = sorted(ims, key=lambda im: (_clip_of(im.name), _t_of(im.name)))
    cams = np.array([im.center for im in ims]) if ims else None
    cam_clip = [_clip_of(im.name) for im in ims]
    # up = mean camera "down" (y axis of the views) reversed; fall back to PCA
    ctr = np.median(xyz, 0)
    P = xyz - ctr
    lo, hi = np.percentile(P, 2, 0), np.percentile(P, 98, 0)
    keep = np.all((P > lo - 0.2 * (hi - lo)) & (P < hi + 0.2 * (hi - lo)), 1)
    P, col = P[keep], rgb[keep]
    u, s, vt = np.linalg.svd(P[np.random.default_rng(0).choice(len(P), min(len(P), 200000), replace=False)], full_matrices=False)
    B = vt  # rows: principal axes, the smallest = up/down for a flat site
    tiles = []
    for name, R in (("top view", B), ("oblique view", _rot(B, 55))):
        Q = P @ R.T
        C = (cams - ctr) @ R.T if cams is not None else None
        W, H = 1400, 1000
        lo2, hi2 = np.percentile(Q[:, :2], 1, 0), np.percentile(Q[:, :2], 99, 0)
        sc = min((W - 60) / (hi2[0] - lo2[0]), (H - 60) / (hi2[1] - lo2[1]))
        img = np.full((H, W, 3), 250, np.uint8)
        order = np.argsort(Q[:, 2])[::-1]
        px = ((Q[order, :2] - lo2) * sc + 30).astype(int)
        ok = (px[:, 0] >= 0) & (px[:, 0] < W) & (px[:, 1] >= 0) & (px[:, 1] < H)
        img[px[ok, 1], px[ok, 0]] = col[order][ok][:, ::-1]
        img = cv2.erode(img, np.ones((2, 2), np.uint8))
        if C is not None:
            cp = ((C[:, :2] - lo2) * sc + 30).astype(int)
            pal = [(40, 40, 220), (200, 90, 20), (30, 150, 40), (160, 40, 160), (0, 140, 200)]
            for k, (a, b) in enumerate(zip(cp[:-1], cp[1:])):
                if cam_clip[k] == cam_clip[k + 1] and np.linalg.norm(a - b) < 80:
                    cv2.line(img, tuple(int(v) for v in a), tuple(int(v) for v in b), pal[cam_clip[k] % 5], 2, cv2.LINE_AA)
            for k, p in enumerate(cp):
                if k % 3 == 0:
                    cv2.circle(img, tuple(int(v) for v in p), 3, pal[cam_clip[k] % 5], -1, cv2.LINE_AA)
            for j, c in enumerate(sorted(set(cam_clip))):
                cv2.putText(img, f"clip {c}", (20, H - 20 - 26 * j), cv2.FONT_HERSHEY_SIMPLEX, 0.7, pal[c % 5], 2, cv2.LINE_AA)
        tiles.append(_label(img, f"SfM: {len(xyz):,} points, {0 if C is None else len(C)} panorama positions ({name})"))
    _imwrite(out / "sfm_points_cameras.jpg", _grid(tiles, 2), [1, 93])
    return "sfm_points_cameras.jpg"


def _clip_of(name):
    import re
    m = re.search(r"_c(\d\d)|/c(\d\d)_", name)
    return int(m.group(1) or m.group(2)) if m else 0


def _t_of(name):
    import re
    m = re.search(r"/t(\d+)_c|/c\d\d_(\d+)", name)
    return int(m.group(1) or m.group(2)) if m else 0


def _rot(B, deg):
    a = np.deg2rad(deg)
    Rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    return Rx @ B


def stages(pipe: Path, tr: Path, out: Path, view: str | None) -> str | None:
    """360 frame -> 12 perspective views -> person masks -> SfM -> Gaussians -> render."""
    import cv2

    from .pano360 import _imwrite
    if not (pipe / "1_equirect.jpg").exists():
        return None
    W = 900
    row = [_label(_fit(_read(pipe / "1_equirect.jpg"), 2 * W), "1  one 360 video frame (equirectangular, 7680 x 3840)")]
    views = [_fit(_read(p), 300) for p in sorted(pipe.glob("2_view*.jpg"))]
    if views:
        row.append(_label(_grid(views, 6, 4), "2  twelve perspective views sharing one centre (8 around, 4 looking up; none looks down)"))
    masks = []
    for p in sorted(pipe.glob("2_view*.jpg")):
        v = _fit(_read(p), 300)
        k = p.stem[-2:]
        m = _read(pipe / f"3_person{k}.png")
        if m is not None:
            m = cv2.resize(m[:, :, 0] if m.ndim == 3 else m, (v.shape[1], v.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
            v = v.copy()
            v[m] = (0.45 * v[m] + 0.55 * np.array([60, 60, 230])).astype(np.uint8)
        masks.append(v)
    if masks:
        row.append(_label(_grid(masks, 6, 4), "3  photographer masked (red): no features for SfM, no loss in training"))
    if (out.parent / "pipeline" / "sfm_points_cameras.jpg").exists():
        row.append(_label(_fit(_read(out.parent / "pipeline" / "sfm_points_cameras.jpg"), 2 * W), "4  structure from motion: camera positions + sparse points"))
    if view and (tr / "views" / view).exists():
        vd = tr / "views" / view
        tiles = [_label(_fit(_read(vd / n), 600), t) for n, t in (("000000.png", "5  Gaussians at start (from SfM points)"),
                                                                    ("final_ellipsoids.png", "6  trained Gaussians (shrunk, base colour)"),
                                                                    ("final.png", "7  rendered view")) if (vd / n).exists()]
        if tiles:
            row.append(_grid(tiles, 3))
    w = max(r.shape[1] for r in row)
    row = [np.pad(r, ((0, 0), (0, w - r.shape[1]), (0, 0)), constant_values=255) for r in row]
    _imwrite(out / "stages.jpg", np.vstack([np.pad(r, ((0, 10), (0, 0), (0, 0)), constant_values=255) for r in row]), [1, 93])
    return "stages.jpg"


def main(argv=None):
    argv = argv or sys.argv[1:]
    name = argv[0]
    base = ROOT / "data" / "pano360" / name / "cloud"
    fig = base / "figures"
    out = ROOT / "docs" / "figures"
    (out / "training").mkdir(parents=True, exist_ok=True)
    (out / "pipeline").mkdir(parents=True, exist_ok=True)
    made = {"montages": montages(fig / "training", out / "training"), "curves": curves(fig / "training", out / "training"),
            "sparse": sparse_figure(base / "sparse", out / "pipeline")}
    vj = fig / "training" / "views.json"
    views = [v["name"] for v in json.loads(vj.read_text())] if vj.exists() else []
    made["stages"] = stages(fig / "pipeline", fig / "training", out / "pipeline", "doorway" if "doorway" in views else (views[0] if views else None))
    for f in ("counts.csv", "eval.csv", "loss.csv", "snapshots.jsonl", "views.json"):
        if (fig / "training" / f).exists():
            shutil.copyfile(fig / "training" / f, out / "training" / f)
    print(json.dumps(made, indent=1))


if __name__ == "__main__":
    main()
