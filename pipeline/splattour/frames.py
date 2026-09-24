"""Capture ingestion: videos and photos → a clean, sharp, evenly spaced
image set for SfM.

Video frames are over-sampled with ffmpeg, then selected by sharpness
(variance of the Laplacian) inside sliding windows so motion-blurred frames
are dropped while temporal coverage stays even. Photos are copied as-is
(EXIF orientation applied) after a blur check.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

try:  # iPhone photos
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover
    pass

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".insv", ".webm"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff"}


def sharpness(path: Path, max_side: int = 640) -> float:
    img = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:  # HEIC and other formats OpenCV cannot decode
        try:
            im = Image.open(path)
            im.draft("L", (max_side, max_side))
            img = np.asarray(im.convert("L"))
        except Exception:
            return 0.0
    h, w = img.shape
    s = max_side / max(h, w)
    if s < 1:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(img, cv2.CV_64F).var())


def extract_video(video: Path, out_dir: Path, fps: float = 4.0, keep_every: int = 2, max_side: int = 1600, ffmpeg: str = "ffmpeg") -> list[Path]:
    """Sample `fps` frames/s, then keep the sharpest frame of every
    `keep_every` consecutive candidates."""
    tmp = out_dir / f"_raw_{video.stem}"
    tmp.mkdir(parents=True, exist_ok=True)
    vf = f"fps={fps},scale='if(gt(iw,ih),min({max_side},iw),-2)':'if(gt(iw,ih),-2,min({max_side},ih))'"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-vf", vf, "-q:v", "2", str(tmp / "f_%05d.jpg")], check=True)
    frames = sorted(tmp.glob("f_*.jpg"))
    scores = np.array([sharpness(f) for f in frames])
    kept = []
    for i in range(0, len(frames), keep_every):
        win = slice(i, min(i + keep_every, len(frames)))
        j = i + int(np.argmax(scores[win]))
        # drop frames that are blurry relative to their neighbourhood
        local = np.median(scores[max(0, j - 8) : j + 9])
        if scores[j] < 0.35 * local:
            continue
        dst = out_dir / f"{video.stem}_{len(kept):05d}.jpg"
        shutil.move(str(frames[j]), dst)
        kept.append(dst)
    shutil.rmtree(tmp, ignore_errors=True)
    return kept


def ingest(inputs: list[Path], images_dir: Path, fps: float = 4.0, max_side: int = 1600, ffmpeg: str = "ffmpeg") -> dict:
    images_dir.mkdir(parents=True, exist_ok=True)
    report = {"videos": 0, "photos": 0, "frames": 0, "dropped_blurry": 0}
    files: list[Path] = []
    for p in inputs:
        files += sorted(x for x in p.rglob("*") if x.is_file()) if p.is_dir() else [p]
    photos = []
    for f in files:
        ext = f.suffix.lower()
        if ext in VIDEO_EXT:
            report["videos"] += 1
            report["frames"] += len(extract_video(f, images_dir, fps=fps, max_side=max_side, ffmpeg=ffmpeg))
        elif ext in IMAGE_EXT:
            photos.append(f)
    if photos:
        scores = np.array([sharpness(f) for f in photos])
        med = float(np.median(scores))
        for f, s in zip(photos, scores):
            if s < 0.3 * med:
                report["dropped_blurry"] += 1
                continue
            im = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
            if max(im.size) > max_side:
                im.thumbnail((max_side, max_side), Image.LANCZOS)
            im.save(images_dir / f"{f.stem}.jpg", quality=95)
            report["photos"] += 1
    report["total_images"] = len(list(images_dir.glob("*.jpg")))
    return report
