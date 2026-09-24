"""Side-by-side quality sheet: photo | method A | method B, plus 2x crops.

    python -m splattour.compare_sheet <images_dir> <out.png> <label>=<render_dir> ... [--views a,b,c]

Picks the views where the methods differ most (largest PSNR gap) unless
--views is given, and crops the most detailed region (highest Laplacian
energy in the photo) so fine detail is compared, not flat walls.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np

from .eval_views import score


def _read(p: Path) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(p), np.uint8), cv2.IMREAD_COLOR)


def _label(im: np.ndarray, text: str) -> np.ndarray:
    im = im.copy()
    cv2.rectangle(im, (0, 0), (min(im.shape[1], 16 + 17 * len(text)), 40), (20, 16, 12), -1)
    cv2.putText(im, text, (10, 29), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (255, 255, 255), 2, cv2.LINE_AA)
    return im


def _detail_box(gt: np.ndarray, frac: float = 0.28) -> tuple[int, int, int, int]:
    g = cv2.cvtColor(gt, cv2.COLOR_BGR2GRAY).astype(np.float32)
    e = cv2.GaussianBlur(np.abs(cv2.Laplacian(g, cv2.CV_32F)), (0, 0), 25)
    h, w = g.shape
    bw, bh = int(w * frac), int(h * frac)
    e = e[bh // 2 : h - bh // 2, bw // 2 : w - bw // 2]
    y, x = np.unravel_index(np.argmax(e), e.shape)
    return x, y, bw, bh


def build(images: Path, out: Path, methods: list[tuple[str, Path]], views: list[str] | None = None, n: int = 3) -> dict:
    scores = {lab: score(d, images) for lab, d in methods}
    names = views
    if not names:
        common = set.intersection(*[{v["name"] for v in s["views"]} for s in scores.values()])
        gap = []
        for nm in common:
            ps = [next(v["psnr"] for v in scores[lab]["views"] if v["name"] == nm) for lab, _ in methods]
            gap.append((max(ps) - min(ps), nm))
        names = [nm for _, nm in sorted(gap, reverse=True)[:n]]
    rows = []
    W = 640
    for nm in names:
        gt = _read(next(images.glob(nm + ".*")))
        tiles = [("photo", gt)] + [(lab, _read(d / f"{nm}.png")) for lab, d in methods]
        tiles = [(lab, cv2.resize(im, (gt.shape[1], gt.shape[0]))) for lab, im in tiles]
        x, y, bw, bh = _detail_box(gt)
        full, crop = [], []
        for lab, im in tiles:
            s = scores.get(lab, {})
            v = next((v for v in s.get("views", []) if v["name"] == nm), None)
            tag = lab + (f"  {v['psnr']:.1f} dB" if v else "")
            f = cv2.resize(im, (W, int(W * gt.shape[0] / gt.shape[1])), interpolation=cv2.INTER_AREA)
            cv2.rectangle(f, (int(x * W / gt.shape[1]), int(y * W / gt.shape[1])), (int((x + bw) * W / gt.shape[1]), int((y + bh) * W / gt.shape[1])), (0, 200, 255), 2)
            full.append(_label(f, tag))
            c = im[y : y + bh, x : x + bw]
            crop.append(cv2.resize(c, (W, int(W * bh / bw)), interpolation=cv2.INTER_CUBIC))
        rows += [np.hstack(full), np.hstack(crop), np.full((14, W * len(tiles), 3), 246, np.uint8)]
    sheet = np.vstack(rows)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imencode(".png", sheet)[1].tofile(str(out))
    return {lab: {"psnr": s["psnr"], "ssim": s["ssim"], "n": s["n"]} for lab, s in scores.items()} | {"views": names}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("images")
    ap.add_argument("out")
    ap.add_argument("methods", nargs="+", help="label=render_dir")
    ap.add_argument("--views")
    a = ap.parse_args()
    ms = [(m.split("=", 1)[0], Path(m.split("=", 1)[1])) for m in a.methods]
    import json
    print(json.dumps(build(Path(a.images), Path(a.out), ms, a.views.split(",") if a.views else None), ensure_ascii=False, indent=1))
