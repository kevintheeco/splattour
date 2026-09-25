"""LaMa (big-lama) for the residual holes of the 360 panoramas, then back into the equirect.

Only for what no captured frame covers (pano360_fill writes those as <=100 deg perspective jobs).
Model: big-lama TorchScript as distributed by lama-cleaner / IOPaint (Apache-2.0),
  https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt
  md5 e3aa4aaa15225a33ec84f9f4bc47e500 (the hash lama-cleaner pins), sha256 344c77bb...9ea9
Runs on CPU (a few seconds per crop) or GPU.

    python -m splattour.pano360_lama <nav_filled dir> [--weights PATH]      # in a python with torch (PANO360_SEG_PYTHON)
    python -m splattour.pano360_fill <work> [--model k] --apply              # put the crops back (feather + exposure), ai_fill_log.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

URL = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
MD5 = "e3aa4aaa15225a33ec84f9f4bc47e500"
METHOD = "lama (big-lama TorchScript, lama-cleaner/IOPaint release add_big_lama, Apache-2.0)"


def _md5(p: Path) -> str:
    h = hashlib.md5()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def run(nav_filled: Path, weights: Path, max_side: int = 1024) -> dict:
    import cv2
    import torch
    from .pano360 import _imread, _imwrite
    if _md5(weights) != MD5:
        raise SystemExit(f"{weights}: md5 does not match the lama-cleaner release ({MD5})")
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    import io
    model = torch.jit.load(io.BytesIO(weights.read_bytes()), map_location=dev).eval()  # bytes: torch cannot open non-ASCII paths on Windows
    man = json.loads((nav_filled / "inpaint_jobs.json").read_text(encoding="utf-8"))
    jd = nav_filled / "inpaint_jobs"
    t = time.time()
    n = 0
    for j in man["jobs"]:
        out = jd / f"{j['job']}_filled.jpg"
        if out.exists():
            continue
        img = _imread(jd / j["image"])
        m = _imread(jd / j["mask"], cv2.IMREAD_GRAYSCALE)
        H, W = img.shape[:2]
        k = min(1.0, max_side / max(H, W))
        im_s = cv2.resize(img, (int(W * k) // 8 * 8, int(H * k) // 8 * 8), interpolation=cv2.INTER_AREA)
        m_s = (cv2.resize(m, (im_s.shape[1], im_s.shape[0]), interpolation=cv2.INTER_NEAREST) > 127).astype(np.float32)
        x = torch.from_numpy(cv2.cvtColor(im_s, cv2.COLOR_BGR2RGB)).permute(2, 0, 1)[None].float().div(255).to(dev)
        mk = torch.from_numpy(m_s)[None, None].to(dev)
        with torch.no_grad():
            y = model(x, mk)
        res = np.clip(y[0].permute(1, 2, 0).cpu().numpy() * 255, 0, 255).astype(np.uint8)
        res = cv2.cvtColor(res, cv2.COLOR_RGB2BGR)
        res = cv2.resize(res, (W, H), interpolation=cv2.INTER_CUBIC)
        mm = (m > 127)[..., None]
        comp = np.where(mm, res, img)  # outside the hole: the original crop, untouched
        _imwrite(out, comp, [cv2.IMWRITE_JPEG_QUALITY, 95])
        (jd / f"{j['job']}_filled.json").write_text(json.dumps({"method": METHOD, "model_md5": MD5, "device": str(dev),
                                                                "infer_size": [im_s.shape[1], im_s.shape[0]]}))
        n += 1
    return {"jobs": len(man["jobs"]), "inpainted": n, "seconds": round(time.time() - t), "device": str(dev)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("nav_filled", type=Path)
    ap.add_argument("--weights", type=Path, default=Path(__file__).resolve().parents[2] / "data" / "pano360" / "weights" / "big-lama.pt")
    a = ap.parse_args()
    print(json.dumps(run(a.nav_filled, a.weights)))
