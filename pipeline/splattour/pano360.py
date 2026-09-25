"""360° video -> both study conditions from ONE capture (docs/PANO360.md).

    A) 3DGS free-viewpoint:  equirect frames -> rig of perspective views -> rig SfM -> gsplat -> tour
    B) 360° fixed-viewpoint: capture points picked on the SAME SfM path -> full-res equirect
       panoramas (nadir blurred) + nav.json nodes in the SAME viewer world frame as the 3DGS

Commands (python -m splattour.pano360 ...):
    probe   <files|dir>...                     what the files are (equirect / dual-fisheye / pairs),
                                               one camera or several (rig vs separate passes)
    dry-run <files|dir>... [--name N]          whole local path on a tiny subset (CPU, minutes)
    process <files|dir>... --name N            full processing on this machine (GPU server; no training)
    cloud   <files|dir>... --name N            upload raw files to R2 + rent a GPU server that runs
    cloud   --from-inbox <id> --name N           everything (process + gsplat + tour + nav) and removes itself
    status  --name N | fetch --name N [--apply-space wolhajeong] | balance
    relabel --name N --labels labels.json [--apply-space wolhajeong]   room names on a fetched result
    remote                                     (runs ON the GPU server, started by runner/boot360.sh)

Design notes
  * Every equirect frame becomes a rig of 12 pinhole views sharing one centre (8 around the horizon,
    pitch 0, 90x70 deg; 4 looking up, pitch +50). No view looks down: the photographer / stick in the
    nadir is never in a training image. SfM uses COLMAP rig constraints (pycolmap 4, same approach as
    pycolmap.panorama) with masks so each panorama pixel is matched in one view only.
  * Several clips (a rig of 3 cameras, or 3 separate passes) are simply more panoramas in the same
    model: every panorama is its own rig frame; clips are tied together by feature matching.
  * Nodes for the 360 condition are panoramas that registered in the SAME model the 3DGS is trained
    on, so positions/yaws are exact in the viewer frame (tour.json splatTransform).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SECRETS = ROOT / "secrets"
VIDEO_EXT = {".mp4", ".mov", ".insv", ".m4v", ".mkv", ".webm", ".avi", ".360"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")

# (yaw_deg, pitch_deg) of each virtual view; all views share one pinhole camera (HFOV x VFOV)
HFOV, VFOV = 90.0, 70.0
VIEWS = [(y, 0.0) for y in range(0, 360, 45)] + [(y, 50.0) for y in (45, 135, 225, 315)]


def _passthrough() -> list[str]:
    """Keep every selected frame: -fps_mode (ffmpeg >= 5.1) or -vsync 0 (the GPU server's apt ffmpeg 4.4)."""
    try:
        v = subprocess.run([FFMPEG, "-version"], capture_output=True, text=True).stdout.split()[2]
        major = int(re.match(r"n?(\d+)", v).group(1))
    except Exception:  # noqa: BLE001
        major = 4
    return ["-fps_mode", "passthrough"] if major >= 6 else ["-vsync", "0"]


def _imread(path, flags=None):
    """cv2.imread that also works on non-ASCII Windows paths (바탕화면/주희)."""
    import cv2
    try:
        buf = np.fromfile(str(path), np.uint8)
    except OSError:
        return None
    return cv2.imdecode(buf, cv2.IMREAD_COLOR if flags is None else flags)


def _imwrite(path, img, params=None) -> bool:
    import cv2
    ext = Path(str(path)).suffix or ".jpg"
    ok, buf = cv2.imencode(ext, img, params or [])
    if ok:
        buf.tofile(str(path))
    return ok


def log(*a):
    print("[pano360]", *a, flush=True)


# =========================================================================== probe
def _ffprobe(path: Path) -> dict:
    r = subprocess.run([FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                       capture_output=True, text=True, encoding="utf-8", errors="ignore")
    return json.loads(r.stdout or "{}")


def _grab(path: Path, t: float, vf: str = "", stream: int = 0, width: int = 1024) -> np.ndarray | None:
    """One RGB frame (scaled to `width`) at time t."""
    import cv2
    chain = f"{vf + ',' if vf else ''}scale={width}:-2"
    r = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{t:.2f}", "-i", str(path), "-map", f"0:v:{stream}", "-frames:v", "1",
                        "-vf", chain, "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True)
    if not r.stdout:
        return None
    return cv2.imdecode(np.frombuffer(r.stdout, np.uint8), cv2.IMREAD_COLOR)


def looks_dual_fisheye(img: np.ndarray) -> bool:
    """Two fisheye circles side by side: the corners of both halves are black."""
    h, w = img.shape[:2]
    c = max(4, h // 14)
    halves = [img[:, : w // 2], img[:, w // 2:]] if w >= 1.8 * h else [img]
    dark = []
    for im in halves:
        hh, ww = im.shape[:2]
        for patch in (im[:c, :c], im[:c, ww - c:], im[hh - c:, :c], im[hh - c:, ww - c:]):
            dark.append(float(patch.mean()) < 14 and float(patch.std()) < 10)
    if sum(dark) < 0.75 * len(dark):
        return False
    # a dark room's equirect also has dark corners. The top row of an equirect is ONE point (the zenith):
    # nearly uniform. In dual fisheye the two circles touch the top edge at w/4 and 3w/4 (bright there)
    # while the rest of the top row is black.
    g = img.mean(2) if img.ndim == 3 else img
    top = g[:max(2, h // 200)].mean(0)
    touch = max(top[w // 4 - w // 40: w // 4 + w // 40].mean(), top[3 * w // 4 - w // 40: 3 * w // 4 + w // 40].mean())
    return bool(touch > 25 and touch > 4 * (top[: w // 16].mean() + 1))


def probe(inputs: list[Path]) -> dict:
    files = expand(inputs)
    out = []
    for f in files:
        d = _ffprobe(f)
        vs = [s for s in d.get("streams", []) if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic", 0) == 0]
        au = [s for s in d.get("streams", []) if s.get("codec_type") == "audio"]
        dur = float(d.get("format", {}).get("duration") or 0)
        tags = {**d.get("format", {}).get("tags", {}), **(vs[0].get("tags", {}) if vs else {})}
        rec = {"file": str(f), "name": f.name, "bytes": f.stat().st_size, "duration": round(dur, 2), "video_streams": len(vs),
               "audio": bool(au), "data_streams": [s.get("codec_tag_string") or s.get("codec_name") for s in d.get("streams", [])
                                                  if s.get("codec_type") in ("data", "subtitle")],
               "creation_time": tags.get("creation_time"), "make": tags.get("make") or tags.get("com.apple.quicktime.make") or tags.get("encoder"),
               "model": tags.get("model") or tags.get("com.apple.quicktime.model")}
        if vs:
            v = vs[0]
            num, _, den = (v.get("r_frame_rate") or "0/1").partition("/")
            rec.update(codec=v.get("codec_name"), width=v.get("width"), height=v.get("height"), fps=round(float(num) / float(den or 1), 3),
                       side_data=[s.get("side_data_type") for s in v.get("side_data_list", []) if s])
            spherical = any("Spherical" in (s or "") for s in rec["side_data"])
            m = re.search(r"_(00|10)_(\d+)", f.name)
            if f.suffix.lower() in IMAGE_EXT:
                import cv2
                img = cv2.imdecode(np.fromfile(str(f), np.uint8), cv2.IMREAD_COLOR)
                sample = img
            else:
                sample = _grab(f, min(max(dur / 2, 0), max(dur - 0.5, 0)))
            dfe = bool(sample is not None and looks_dual_fisheye(sample))
            if len(vs) >= 2:
                layout = "dual-stream-fisheye"  # Insta360 X3/X4 .insv: one stream per lens
            elif m and f.suffix.lower() == ".insv":
                layout = "insv-lens-" + m.group(1)  # ONE X / X2: _00_ front lens, _10_ back lens, separate files
            elif spherical:  # Spherical Mapping side data = the camera app already stitched it
                layout = "equirect"
            elif dfe:
                layout = "dual-fisheye"
            elif v.get("width") and abs(v["width"] / v["height"] - 2) < 0.02:
                layout = "equirect"
            else:
                layout = "unknown"
            if os.environ.get("PANO360_LAYOUT"):  # manual override (e.g. equirect)
                layout = os.environ["PANO360_LAYOUT"]
            rec.update(layout=layout, spherical_metadata=spherical,
                       gyro_or_meta_streams=bool(rec["data_streams"]) or f.suffix.lower() == ".insv")
        out.append(rec)
    return {"files": out, "clips": classify(out)}


def expand(inputs: list[Path]) -> list[Path]:
    files: list[Path] = []
    for p in inputs:
        files += sorted(x for x in p.rglob("*") if x.is_file()) if p.is_dir() else [p]
    return [f for f in files if f.suffix.lower() in VIDEO_EXT | IMAGE_EXT]


def _audio(path: Path, seconds: float = 180, rate: int = 4000) -> np.ndarray:
    r = subprocess.run([FFMPEG, "-v", "error", "-t", str(seconds), "-i", str(path), "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
                       capture_output=True)
    a = np.frombuffer(r.stdout, np.int16).astype(np.float32)
    if len(a):
        a = np.abs(a - a.mean())  # envelope: robust to phase differences between microphones
        k = rate // 50
        a = np.convolve(a, np.ones(k) / k, mode="same")[::k // 2 or 1]
    return a


def audio_offset(a: Path, b: Path) -> dict:
    """Lag of clip b relative to clip a from the audio envelopes (cross-correlation).
    b_sound_later_by_s = d: a sound at time x in clip a is at time x + d in clip b (b started d s earlier).
    peak_ratio > ~4 = the two cameras recorded the same sound at the same time (a rig)."""
    rate = 4000
    x, y = _audio(a, rate=rate), _audio(b, rate=rate)
    if len(x) < 100 or len(y) < 100:
        return {"ok": False, "why": "no audio"}
    x, y = (x - x.mean()) / (x.std() + 1e-6), (y - y.mean()) / (y.std() + 1e-6)
    n = 1 << int(np.ceil(np.log2(len(x) + len(y))))
    c = np.fft.irfft(np.fft.rfft(x, n) * np.conj(np.fft.rfft(y, n)), n)
    c = np.concatenate([c[-(len(y) - 1):], c[: len(x)]]) / min(len(x), len(y))
    i = int(np.argmax(c))
    lag = (i - (len(y) - 1)) / (rate / (rate // 50 // 2))
    peak = float(c[i])
    bg = float(np.median(np.abs(c)) + 1e-6)
    return {"ok": True, "offset_s": round(lag, 3), "b_sound_later_by_s": round(-lag, 3), "peak": round(peak, 3), "peak_ratio": round(peak / bg, 1)}


def classify(recs: list[dict]) -> dict:
    """One camera, a synchronised multi-camera rig, or separate passes?"""
    vids = [r for r in recs if r.get("duration", 0) > 1 and r.get("layout") not in (None, "insv-lens-10")]
    res = {"n_clips": len(vids), "case": "single" if len(vids) <= 1 else "unknown", "pairs": []}
    if len(vids) <= 1:
        return res
    from datetime import datetime

    def ts(r):
        try:
            return datetime.fromisoformat((r.get("creation_time") or "").replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
        # no creation_time (re-muxed files): Insta360-style names carry the recording start, CAM_20260818050812_0007_D.mp4
        m = re.search(r"(20\d{12})", r.get("name") or "")
        if m:
            try:
                return datetime.strptime(m.group(1), "%Y%m%d%H%M%S").timestamp()
            except ValueError:
                return None
        return None
    rig_votes = 0
    for i in range(len(vids)):
        for j in range(i + 1, len(vids)):
            a, b = vids[i], vids[j]
            ta, tb = ts(a), ts(b)
            overlap = None
            if ta is not None and tb is not None:  # creation_time is usually the END or START of recording; both work for overlap
                overlap = min(ta + a["duration"], tb + b["duration"]) - max(ta, tb)
            au = audio_offset(Path(a["file"]), Path(b["file"])) if a.get("audio") and b.get("audio") else {"ok": False}
            synced = au.get("ok") and au.get("peak_ratio", 0) >= 4
            same_len = abs(a["duration"] - b["duration"]) < 0.1 * max(a["duration"], b["duration"])
            # recording times that do not overlap overrule a sound match (2026-09-26: four 월하정 clips recorded minutes
            # apart matched each other's sound with peak_ratio 8-19 -> wrongly called a rig)
            vote = bool((synced and (overlap is None or overlap > 0)) or (overlap is not None and overlap > 0.5 * min(a["duration"], b["duration"])))
            rig_votes += vote
            res["pairs"].append({"a": a["name"], "b": b["name"], "time_overlap_s": None if overlap is None else round(overlap, 1),
                                 "similar_length": same_len, "audio": au, "same_time": vote})
    npairs = len(res["pairs"])
    res["case"] = "rig" if rig_votes == npairs else ("passes" if rig_votes == 0 else "mixed")
    res["explain"] = {"rig": "cameras recorded at the same time (rig): all clips go into one SfM; the 360 condition uses one camera (--pano-clip)",
                      "passes": "clips were recorded one after another (separate passes): all clips go into one SfM model",
                      "mixed": "some clips overlap in time, some don't: check the pairs", "unknown": ""}[res["case"]]
    return res


# =========================================================================== frames
def stitch_filter(rec: dict, fov: float, pre: str = "null", post: str = "null", out_w: int | None = None) -> tuple[list[str], str]:
    """ffmpeg inputs + filter graph giving an equirect stream for one clip. `pre` runs on every input
    stream BEFORE stitching (fps / select: only the frames we keep are stitched), `post` after.
    Dual fisheye uses ffmpeg v360 (fallback; Insta360 Studio's export is better: real lens
    calibration, seam blending, FlowState)."""
    lay = rec.get("layout")
    f = rec["file"]
    size = f":w={out_w}:h={out_w // 2}" if out_w else ""
    v360 = f"v360=dfisheye:e:ih_fov={fov}:iv_fov={fov}{size}"
    if lay == "dual-stream-fisheye":  # Insta360 X3/X4 .insv: one stream per lens
        return ["-i", f], f"[0:v:0]{pre}[l0];[0:v:1]{pre}[l1];[l0][l1]hstack,{v360},{post}[o]"
    if lay == "insv-lens-00":  # ONE X / X2: _00_ and _10_ files
        back = re.sub(r"_00_", "_10_", f)
        return ["-i", f, "-i", back], f"[0:v:0]{pre}[l0];[1:v:0]{pre}[l1];[l0][l1]hstack,{v360},{post}[o]"
    if lay == "dual-fisheye":
        return ["-i", f], f"[0:v:0]{pre},{v360},{post}[o]"
    return ["-i", f], f"[0:v:0]{pre},{post}[o]"


def sharpness(gray: np.ndarray) -> float:
    import cv2
    g = gray.astype(np.float32)
    return float(cv2.Laplacian(g, cv2.CV_32F).var() / (g.var() + 1e-6))


def score_clip(rec: dict, fps: float, fov: float, width: int = 768, t0: float = 0.0, t1: float | None = None) -> dict:
    """Sample the clip at `fps`: per sample sharpness (brightness-normalised, horizon band) and
    motion (median optical flow vs the previous sample, pixels at `width`)."""
    import cv2
    h = width // 2
    ins, filt = stitch_filter(rec, fov, pre=f"fps={fps}", post=f"scale={width}:{h},format=gray", out_w=width)
    # -ss before each -i (fast seek)
    cmd = [FFMPEG, "-v", "error"]
    for k in range(0, len(ins), 2):
        cmd += ["-ss", f"{t0:.2f}", *(["-to", f"{t1:.2f}"] if t1 else []), ins[k], ins[k + 1]]
    cmd += ["-filter_complex", filt, "-map", "[o]", "-f", "rawvideo", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    sharp, motion, prev = [], [], None
    band = slice(int(h * 0.25), int(h * 0.75))
    while True:
        buf = p.stdout.read(width * h)
        if len(buf) < width * h:
            break
        g = np.frombuffer(buf, np.uint8).reshape(h, width)
        sharp.append(sharpness(g[band]))
        small = cv2.resize(g[band], (width // 2, (band.stop - band.start) // 2), interpolation=cv2.INTER_AREA)
        if prev is None:
            motion.append(0.0)
        else:
            flow = cv2.calcOpticalFlowFarneback(prev, small, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            motion.append(float(np.median(np.linalg.norm(flow, axis=2))) * 2)
        prev = small
    p.wait()
    return {"fps": fps, "t0": t0, "sharp": sharp, "motion": motion}


def select_frames(sc: dict, n_target: int, static_px: float = 0.6, trim_s: float = 1.0) -> list[int]:
    """Evenly spaced in *distance travelled* (cumulative optical flow), not in time: pauses and the
    static start/stop are skipped; in every slot the sharpest sample wins."""
    s, m = np.array(sc["sharp"]), np.array(sc["motion"])
    n = len(s)
    if n == 0:
        return []
    fps = sc["fps"]
    k = int(trim_s * fps)
    valid = np.ones(n, bool)
    valid[:k] = valid[n - k:] = False
    msm = np.convolve(m, np.ones(3) / 3, mode="same")
    valid &= msm > static_px  # camera not moving
    med = np.median(s[valid]) if valid.any() else 0
    valid &= s > 0.35 * med  # motion blur
    cum = np.cumsum(np.where(valid, m, 0))
    if cum[-1] <= 0 or not valid.any():
        return []
    edges = np.linspace(0, cum[-1], n_target + 1)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        idx = np.where(valid & (cum >= a) & (cum < b))[0]
        if len(idx):
            out.append(int(idx[np.argmax(s[idx])]))
    return sorted(set(out))


def extract_selected(rec: dict, clip: int, sc: dict, idx: list[int], out: Path, fov: float, width: int | None) -> list[dict]:
    """Full-resolution equirect JPEGs of the selected samples: c<clip>_<sample>.jpg."""
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / f"_c{clip:02d}"
    tmp.mkdir(exist_ok=True)
    sel = "+".join(f"eq(n\\,{i})" for i in idx)
    scale = f"scale={width}:{width // 2}:flags=lanczos" if width else "null"
    # select BEFORE stitching: only the kept frames go through v360
    ins, filt = stitch_filter(rec, fov, pre=f"fps={sc['fps']},select='{sel}'", post=scale)
    cmd = [FFMPEG, "-v", "error", "-y"]
    for k in range(0, len(ins), 2):
        cmd += ["-ss", f"{sc['t0']:.2f}", ins[k], ins[k + 1]]
    cmd += ["-filter_complex", filt, "-map", "[o]", *_passthrough(), "-q:v", "2",
            str(tmp / "s_%05d.jpg")]
    subprocess.run(cmd, check=True)
    got = sorted(tmp.glob("s_*.jpg"))
    if len(got) != len(idx):
        log(f"warning: clip {clip}: asked {len(idx)} frames, got {len(got)}")
    frames = []
    for i, g in zip(idx, got):
        name = f"c{clip:02d}_{i:05d}.jpg"
        os.replace(g, out / name)
        frames.append({"name": name, "clip": clip, "sample": i, "t": round(sc["t0"] + i / sc["fps"], 3)})
    shutil.rmtree(tmp, ignore_errors=True)
    return frames


def frames_from_inputs(inputs: list[Path], out: Path, n_frames: int, fps: float, fov: float, width: int | None,
                       max_seconds: float | None = None, pr: dict | None = None, start: float = 0.0, dense: dict | None = None,
                       labels: dict | None = None, exclude: list[str] | None = None) -> dict:
    """probe -> per clip: score -> select -> extract. Frames per clip in proportion to distance moved.
    dense = {"prior": {...}, "spacing": m, "rot_deg": deg}: every frame scored, sharpest per ~spacing m of travel
    (pano360_dense). exclude = clip file names left out (clip numbers stay those of the full file order)."""
    pr = pr or probe(inputs)
    clips = [r for r in pr["files"] if r.get("layout") in ("equirect", "dual-fisheye", "dual-stream-fisheye", "insv-lens-00")]
    order = (dense or {}).get("clip_order")  # clip numbers of the FULL file list (labels refer to them) when some files are absent
    for i, r in enumerate(clips):
        r["clip_index"] = order.index(r["name"]) if order and r["name"] in order else i
    if exclude:
        clips_all = clips
        clips = [r for r in clips if r["name"] not in set(exclude)]
        log(f"left out: {[r['name'] for r in clips_all if r not in clips]}")
    stills = [r for r in pr["files"] if Path(r["file"]).suffix.lower() in IMAGE_EXT and r.get("layout") == "equirect"]
    if dense is not None and not stills and all(r.get("layout") == "equirect" for r in clips):
        from .pano360_dense import select_all
        sel = select_all(clips, out, dense.get("prior"), n_frames, labels, fov, extract_selected,
                         spacing0=dense.get("spacing", 0.3), rot0=dense.get("rot_deg", 20.0), workers=len(clips))
        return {"clips": sel["clips"], "frames": sel["frames"], "probe": pr, "dense": {"spacing_m": sel["spacing_m"]}}
    frames: list[dict] = []
    scores = {}
    for c, rec in enumerate(clips):
        if Path(rec["file"]).suffix.lower() in IMAGE_EXT:
            continue
        t1 = min(rec["duration"], start + max_seconds) if max_seconds else None
        t = time.time()
        scores[c] = score_clip(rec, fps, fov, t0=start, t1=t1)
        log(f"clip {c} {rec['name']}: {len(scores[c]['sharp'])} samples scored in {time.time() - t:.0f}s")
    total = sum(float(np.sum(s["motion"])) for s in scores.values()) or 1
    for c, sc in scores.items():
        share = max(8, int(round(n_frames * float(np.sum(sc["motion"])) / total)))
        idx = select_frames(sc, share)
        log(f"clip {c}: {len(idx)} frames selected")
        frames += extract_selected(clips[c], c, sc, idx, out, fov, width)
    for k, r in enumerate(stills):  # already-exported equirect stills
        dst = out / f"s{k:03d}_{Path(r['file']).stem}.jpg"
        shutil.copyfile(r["file"], dst)
        frames.append({"name": dst.name, "clip": -1, "sample": k, "t": None})
    if pr["clips"].get("case") == "rig" and len(scores) > 1:
        # cameras recorded together: name frames by the common clock so sequential matching also pairs
        # each camera with the others at the same moment (clip 0's clock; audio offset per clip)
        off = {0: 0.0}
        names_by_clip = {c: clips[c]["name"] for c in scores}
        for pair in pr["clips"]["pairs"]:
            au = pair.get("audio") or {}
            if pair["a"] == names_by_clip.get(0) and au.get("ok") and au.get("peak_ratio", 0) >= 4:
                cb = next(c for c, n in names_by_clip.items() if n == pair["b"])
                off[cb] = -float(au["b_sound_later_by_s"])  # an event at a-time x is at b-time x + d
        for fr in frames:
            if fr["clip"] >= 0 and fr["t"] is not None:
                new = f"t{int(round((fr['t'] + off.get(fr['clip'], 0.0)) * 1000)):08d}_c{fr['clip']:02d}.jpg"
                os.replace(out / fr["name"], out / new)
                fr["name"], fr["t_sync"] = new, round(fr["t"] + off.get(fr["clip"], 0.0), 3)
        frames.sort(key=lambda f: f["name"])
    # all panoramas must share one size (one virtual camera for all views)
    import cv2
    sizes = {}
    for fr in frames:
        im = _imread(str(out / fr["name"]), cv2.IMREAD_REDUCED_COLOR_8)
        sizes[fr["name"]] = (im.shape[1] * 8, im.shape[0] * 8) if im is not None else None
    uniq = {s for s in sizes.values() if s}
    if len(uniq) > 1:
        W = min(w for w, _ in uniq)
        log(f"panoramas of different sizes {sorted(uniq)}: resizing all to {W}x{W // 2}")
        for fr in frames:
            p = out / fr["name"]
            im = _imread(str(p))
            if im.shape[1] != W:
                _imwrite(str(p), cv2.resize(im, (W, W // 2), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 95])
    return {"clips": [{"clip": c, "file": clips[c]["name"], "layout": clips[c]["layout"], "samples": len(s["sharp"]),
                       "fps": s["fps"], "motion_total": round(float(np.sum(s["motion"])), 1)} for c, s in scores.items()],
            "frames": frames, "probe": pr}


# =========================================================================== views
def view_rotations() -> list[np.ndarray]:
    """cam_from_pano rotations, same convention as pycolmap.panorama.get_virtual_rotations
    (pano frame: x right, y down, z = centre column of the equirect)."""
    out = []
    for yaw_deg, pitch_deg in VIEWS:
        p, y = np.deg2rad([-pitch_deg, -yaw_deg])
        rx = np.array([[1, 0, 0], [0, np.cos(p), -np.sin(p)], [0, np.sin(p), np.cos(p)]])
        ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
        out.append(rx @ ry)
    return out


def view_camera(pano_w: int) -> dict:
    """Pinhole camera whose pixels match the panorama's angular resolution at the view centre."""
    f = pano_w / (2 * np.pi)
    w = int(round(2 * f * np.tan(np.deg2rad(HFOV) / 2))) // 2 * 2
    h = int(round(2 * f * np.tan(np.deg2rad(VFOV) / 2))) // 2 * 2
    return {"model": "SIMPLE_PINHOLE", "width": w, "height": h, "params": [f, w / 2, h / 2]}


def render_views(pano_dir: Path, names: list[str], views_dir: Path, masks_dir: Path, workers: int = 4, sfm_dir: Path | None = None,
                 sfm_max: int = 1600, clahe: bool = True) -> dict:
    """Every panorama -> len(VIEWS) pinhole images views/pano_camera<i>/<name> at full angular resolution
    (training), plus SfM copies in `sfm_dir` downscaled by an exact integer factor with local contrast
    (CLAHE) so dark rooms still match, plus SfM masks at that size (each panorama pixel is matched in
    the one view whose centre is closest)."""
    import cv2
    first = _imread(str(pano_dir / names[0]), cv2.IMREAD_REDUCED_COLOR_8)
    W = first.shape[1] * 8
    H = W // 2
    cam = view_camera(W)
    w, h, f = cam["width"], cam["height"], cam["params"][0]
    rots = view_rotations()
    centres = np.array([r.T @ np.array([0, 0, 1.0]) for r in rots])  # view axes in pano frame
    xs, ys = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    rays = np.stack([(xs - w / 2) / f, (ys - h / 2) / f, np.ones_like(xs)], -1).reshape(-1, 3)
    rays /= np.linalg.norm(rays, axis=1, keepdims=True)
    maps, masks = [], []
    for i, R in enumerate(rots):
        rp = rays @ R  # rays in pano frame (R is cam_from_pano)
        yaw = np.arctan2(rp[:, 0], rp[:, 2])
        pitch = -np.arctan2(rp[:, 1], np.linalg.norm(rp[:, [0, 2]], axis=1))
        u = ((1 + yaw / np.pi) / 2 * W - 0.5).astype(np.float32).reshape(h, w)
        v = ((1 - pitch * 2 / np.pi) / 2 * H - 0.5).astype(np.float32).reshape(h, w)
        maps.append((u, v))
        closest = np.argmax(rp @ centres.T, 1) == i
        masks.append((closest.reshape(h, w) * 255).astype(np.uint8))
    sfm_dir = sfm_dir or views_dir
    k = max(1, int(math.ceil(w / sfm_max)))
    while k > 1 and (w % k or h % k):
        k -= 1
    ws, hs = w // k, h // k
    masks = [cv2.resize(m, (ws, hs), interpolation=cv2.INTER_NEAREST) for m in masks]
    for i in range(len(rots)):
        (views_dir / f"pano_camera{i}").mkdir(parents=True, exist_ok=True)
        (sfm_dir / f"pano_camera{i}").mkdir(parents=True, exist_ok=True)
        (masks_dir / f"pano_camera{i}").mkdir(parents=True, exist_ok=True)
    cl = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    def sfm_copy(img):
        if k > 1:
            img = cv2.resize(img, (ws, hs), interpolation=cv2.INTER_AREA)
        if clahe:
            lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
            lab[:, :, 0] = cl.apply(lab[:, :, 0])
            img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
        return img

    def one(name):
        pano = _imread(str(pano_dir / name), cv2.IMREAD_COLOR)
        if pano is None or pano.shape[1] != W:
            return name, False
        for i, (u, v) in enumerate(maps):
            img = cv2.remap(pano, u, v, cv2.INTER_AREA if False else cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
            _imwrite(str(views_dir / f"pano_camera{i}" / name), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
            if sfm_dir != views_dir:
                _imwrite(str(sfm_dir / f"pano_camera{i}" / name), sfm_copy(img), [cv2.IMWRITE_JPEG_QUALITY, 95])
            _imwrite(str(masks_dir / f"pano_camera{i}" / f"{name}.png"), masks[i])
        return name, True
    with ThreadPoolExecutor(workers) as ex:
        res = dict(ex.map(one, names))
    bad = [n for n, ok in res.items() if not ok]
    return {"pano_size": [W, H], "camera": cam, "views": len(rots), "images": len(rots) * (len(names) - len(bad)), "skipped": bad,
            "rotations": [r.tolist() for r in rots], "view_dirs": VIEWS, "hfov": HFOV, "vfov": VFOV,
            "sfm_factor": k if sfm_dir != views_dir else 1,
            "camera_sfm": {"model": "SIMPLE_PINHOLE", "width": ws, "height": hs, "params": [f / k, ws / 2, hs / 2]} if sfm_dir != views_dir else cam,
            "sfm_clahe": clahe}


# =========================================================================== person masks
def person_masks(views_sfm: Path, masks_dir: Path, out_dir: Path, dilate_frac: float = 0.03, model: str | None = None,
                 equirect: Path | None = None) -> dict:
    """The photographer walks right next to the camera: segment people in every SfM view (YOLO
    segmentation), dilate, then
      * out_dir/pano_camera<i>/<name>.png   255 = person (SfM-view size)
      * the SfM masks in masks_dir lose the person (no features on him)
      * out_dir/person_frac.json            share of each view covered by people
    Runs in PANO360_SEG_PYTHON (a python with ultralytics + torch; on the GPU server the main one)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    spec = out_dir / "seg_spec.json"
    spec.write_text(json.dumps({"views": str(views_sfm), "masks": str(masks_dir), "out": str(out_dir), "dilate": dilate_frac,
                                "equirect": str(equirect) if equirect else None,
                                "model": model or os.environ.get("PANO360_SEG_MODEL", "yolo11x-seg.pt")}))
    py = os.environ.get("PANO360_SEG_PYTHON") or sys.executable
    t = time.time()
    with open(out_dir / "seg.log", "w", encoding="utf-8") as lf:
        r = subprocess.run([py, "-m", "splattour.pano360", "_seg", str(spec)], cwd=str(Path(__file__).resolve().parents[1]),
                           stdout=lf, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        raise RuntimeError("person segmentation failed: " + (out_dir / "seg.log").read_text(encoding="utf-8", errors="ignore")[-1200:])
    res = json.loads((out_dir / "seg_result.json").read_text())
    res["wall_seconds"] = round(time.time() - t)
    return res


def _seg_main(spec_path: str) -> None:
    import cv2
    import torch
    from ultralytics import YOLO
    sp = json.loads(Path(spec_path).read_text())
    views, masks, out = Path(sp["views"]), Path(sp["masks"]), Path(sp["out"])
    dev = 0 if torch.cuda.is_available() else "cpu"
    wdir = Path(os.environ.get("PANO360_WEIGHTS", str(out.parent)))
    wdir.mkdir(parents=True, exist_ok=True)
    cwd = os.getcwd()
    os.chdir(wdir)  # ultralytics downloads the weights into the working directory
    try:
        net = YOLO(sp["model"])
    finally:
        os.chdir(cwd)
    files = sorted(views.rglob("*.jpg"))
    frac = {}
    t = time.time()
    B = 16 if dev == 0 else 4
    for i in range(0, len(files), B):
        batch = files[i:i + B]
        imgs = [_imread(f) for f in batch]
        res = net.predict(imgs, classes=[0], conf=float(os.environ.get("PANO360_SEG_CONF", 0.08)), imgsz=1024, retina_masks=True, device=dev, verbose=False, half=dev == 0)
        for f, im, r in zip(batch, imgs, res):
            h, w = im.shape[:2]
            m = np.zeros((h, w), np.uint8)
            if r.masks is not None and len(r.masks):
                mm = (r.masks.data.cpu().numpy() > 0.5).any(0).astype(np.uint8) * 255
                m = cv2.resize(mm, (w, h), interpolation=cv2.INTER_NEAREST) if mm.shape != (h, w) else mm
                k = max(3, int(sp["dilate"] * w) | 1)
                m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
            rel = f.relative_to(views).as_posix()
            (out / Path(rel).parent).mkdir(parents=True, exist_ok=True)
            _imwrite(out / (rel + ".png"), m)
            sm = masks / (rel + ".png")
            base = _imread(sm, cv2.IMREAD_GRAYSCALE)
            if base is not None:
                _imwrite(sm, np.where(m > 0, 0, base).astype(np.uint8))
            frac[rel] = round(float((m > 0).mean()), 4)
    (out / "person_frac.json").write_text(json.dumps(frac))
    n_eq = 0
    if sp.get("equirect"):
        n_eq = _seg_down(net, dev, Path(sp["equirect"]), out, sp["dilate"])
    v = np.array(list(frac.values()) or [0])
    res = {"views": len(frac), "with_person": int((v > 0.001).sum()), "mean_person_frac": round(float(v.mean()), 4),
           "views_over_40pct": int((v > 0.4).sum()), "device": str(dev), "model": sp["model"], "seconds": round(time.time() - t),
           "equirect_masks": n_eq}
    (out / "seg_result.json").write_text(json.dumps(res))
    print(json.dumps(res))


# looking down (mask-only views): the photographer's body and hands between the horizontal views and the nadir cap
DOWN_VIEWS = [(y, -45.0) for y in (0, 90, 180, 270)] + [(y, -20.0) for y in (45, 135, 225, 315)]


def _seg_down(net, dev, eq_dir: Path, out: Path, dilate: float, W: int = 1920, size: int = 1024) -> int:
    """Per panorama: YOLO on 8 extra pinhole views (4 at -45 deg, 4 at -20 deg, 100 deg FOV) back-projected into
    an equirect person mask out/equirect/<name>.png (W x W/2). Only for masks (these views are never trained on)."""
    import cv2
    H = W // 2
    (out / "equirect").mkdir(parents=True, exist_ok=True)
    fov = 100.0
    f = size / (2 * np.tan(np.deg2rad(fov) / 2))
    xs, ys = np.meshgrid(np.arange(size) + 0.5, np.arange(size) + 0.5)
    rays = np.stack([(xs - size / 2) / f, (ys - size / 2) / f, np.ones_like(xs)], -1)
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    u_, v_ = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    yaw_, pitch_ = (2 * u_ / W - 1) * np.pi, (1 - 2 * v_ / H) * np.pi / 2
    d = np.stack([np.cos(pitch_) * np.sin(yaw_), -np.sin(pitch_), np.cos(pitch_) * np.cos(yaw_)], -1)
    views = []
    for yaw_deg, pitch_deg in DOWN_VIEWS:
        pr, yr = np.deg2rad([-pitch_deg, -yaw_deg])
        R = np.array([[1, 0, 0], [0, np.cos(pr), -np.sin(pr)], [0, np.sin(pr), np.cos(pr)]]) @ \
            np.array([[np.cos(yr), 0, np.sin(yr)], [0, 1, 0], [-np.sin(yr), 0, np.cos(yr)]])
        rp = rays @ R
        u = ((1 + np.arctan2(rp[..., 0], rp[..., 2]) / np.pi) / 2 * W - 0.5).astype(np.float32)
        v = ((1 + 2 / np.pi * np.arctan2(rp[..., 1], np.linalg.norm(rp[..., [0, 2]], axis=-1))) / 2 * H - 0.5).astype(np.float32)
        c = d @ R.T
        ok = c[..., 2] > 1e-3
        bx = np.where(ok, c[..., 0] / np.maximum(c[..., 2], 1e-3) * f + size / 2 - 0.5, -1).astype(np.float32)
        by = np.where(ok, c[..., 1] / np.maximum(c[..., 2], 1e-3) * f + size / 2 - 0.5, -1).astype(np.float32)
        views.append((u, v, bx, by))
    n = 0
    for pano_p in sorted(eq_dir.glob("*.jpg")):
        pano = _imread(pano_p)
        if pano is None:
            continue
        pano = cv2.resize(pano, (W, H), interpolation=cv2.INTER_AREA)
        imgs = [cv2.remap(pano, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP) for u, v, _, _ in views]
        res = net.predict(imgs, classes=[0], conf=float(os.environ.get("PANO360_SEG_CONF", 0.08)), imgsz=1024, retina_masks=True, device=dev, verbose=False)
        acc = np.zeros((H, W), np.uint8)
        for (u, v, bx, by), r in zip(views, res):
            if r.masks is None or not len(r.masks):
                continue
            mm = ((r.masks.data.cpu().numpy() > 0.5).any(0) * 255).astype(np.uint8)
            if mm.shape != (size, size):
                mm = cv2.resize(mm, (size, size), interpolation=cv2.INTER_NEAREST)
            acc = np.maximum(acc, cv2.remap(mm, bx, by, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT))
        k = max(3, int(dilate * W) | 1)
        acc = cv2.dilate(acc, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        _imwrite(out / "equirect" / (pano_p.name + ".png"), acc)
        n += 1
    return n


def training_masks(dataset: Path, person_dir: Path, drop_over: float = 0.4) -> dict:
    """Full-resolution loss masks for the trainer: dataset/masks/<image name>.png (255 = train on it,
    0 = person). Views mostly covered by a person are left out of training (dataset/drop.json)."""
    import cv2
    frac = json.loads((person_dir / "person_frac.json").read_text())
    out = dataset / "masks"
    drop, n = [], 0
    for img in sorted((dataset / "images").rglob("*.jpg")):
        rel = img.relative_to(dataset / "images").as_posix()
        if frac.get(rel, 0) > drop_over:
            drop.append(rel)
        pm = _imread(person_dir / (rel + ".png"), cv2.IMREAD_GRAYSCALE)
        if pm is None or not pm.any():
            continue
        H, W = _imread(img, cv2.IMREAD_GRAYSCALE).shape[:2]
        valid = np.where(cv2.resize(pm, (W, H), interpolation=cv2.INTER_NEAREST) > 0, 0, 255).astype(np.uint8)
        (out / Path(rel).parent).mkdir(parents=True, exist_ok=True)
        _imwrite(out / (rel + ".png"), valid)
        n += 1
    (dataset / "drop.json").write_text(json.dumps(drop))
    return {"masked_images": n, "dropped_mostly_person": len(drop), "drop_over": drop_over}


TRAIN_WRAPPER = r'''# pano360: gsplat simple_trainer with per-image loss masks (person) and a list of views left out
import json, os, runpy, sys
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datasets import colmap as C
import imageio.v2 as imageio
MASKS = os.environ.get("PANO360_MASKS", "")
DROP = set(json.load(open(os.environ["PANO360_DROP"]))) if os.environ.get("PANO360_DROP") and os.path.exists(os.environ["PANO360_DROP"]) else set()
_init, _get = C.Dataset.__init__, C.Dataset.__getitem__
DS = {}
def init(self, parser, split="train", *a, **k):
    _init(self, parser, split, *a, **k)
    DS[split] = self
    if split == "train" and DROP:
        keep = [i for i in self.indices if parser.image_names[i] not in DROP]
        print(f"[pano360] training on {len(keep)} of {len(self.indices)} views (mostly-person views left out)", flush=True)
        self.indices = np.array(keep)
def get(self, item):
    data = _get(self, item)
    name = self.parser.image_names[self.indices[item]]
    p = os.path.join(MASKS, name + ".png")
    if MASKS and os.path.exists(p):
        m = torch.from_numpy(imageio.imread(p) > 127)
        if tuple(m.shape) == tuple(data["image"].shape[:2]):
            if "mask" in data and data["mask"] is not None:
                m = m & data["mask"]
            data["mask"] = m
            # gsplat zeroes the render where mask is False; zero the photo too so the person costs nothing
            data["image"] = data["image"] * m[..., None]
    return data
C.Dataset.__init__, C.Dataset.__getitem__ = init, get
if os.environ.get("PANO360_FIG_DIR"):  # training-process figures (pano360_trainfig.py, copied next to this file)
    import pano360_trainfig
    pano360_trainfig.install(DS, sys.argv[1:])
sys.argv = ["simple_trainer.py"] + sys.argv[1:]
runpy.run_path("simple_trainer.py", run_name="__main__")
'''


def train_masked(dataset: Path, out: Path, steps: int, cap_max: int, test_every: int, steps_scaler: int = 1, extra: list[str] | None = None,
                 progress=None, workdir: Path = Path("/workspace")) -> dict:
    """cloud.train_gsplat_local with the person masks: same setup script and trainer flags, but the
    trainer is started through TRAIN_WRAPPER (per-image masks + dropped views)."""
    import subprocess as sp

    from .cloud import SETUP, _flag, local_trainer_args
    out.mkdir(parents=True, exist_ok=True)
    note = progress or (lambda d: None)
    t0 = time.time()
    setup = sp.run(["bash", "-lc", SETUP.replace("/workspace", str(workdir))], capture_output=True, text=True)
    (out / "setup.log").write_text(setup.stdout + setup.stderr, encoding="utf-8")
    if setup.returncode != 0:
        raise RuntimeError("gsplat setup failed: " + (setup.stderr or setup.stdout)[-600:])
    ex = workdir / "gsplat" / "examples"
    (ex / "pano360_train.py").write_text(TRAIN_WRAPPER, encoding="utf-8")
    shutil.copyfile(Path(__file__).with_name("pano360_trainfig.py"), ex / "pano360_trainfig.py")
    help_text = sp.run(["python", "simple_trainer.py", "mcmc", "--help"], cwd=ex, capture_output=True, text=True).stdout
    extra = [f for f in (extra or []) if _flag(help_text, f.partition("=")[0]) in help_text]
    args = local_trainer_args(help_text, dataset, out, steps, cap_max, test_every, steps_scaler, extra)
    args[1] = "pano360_train.py"
    # expandable segments: the first 월하정 run died of fragmentation (OOM at step 22100 on a 24 GB card, 3.8 GB reserved-unused)
    env = {**os.environ, "PANO360_MASKS": str(dataset / "masks"), "PANO360_DROP": str(dataset / "drop.json"),
           "PYTORCH_CUDA_ALLOC_CONF": os.environ.get("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")}
    t1 = time.time()
    last = 0
    with open(out / "train.log", "w", encoding="utf-8") as logf:
        proc = sp.Popen(args, cwd=ex, stdout=sp.PIPE, stderr=sp.STDOUT, text=True, bufsize=1, env=env)
        buf = ""
        while True:
            ch = proc.stdout.read(4096)
            if not ch:
                break
            logf.write(ch)
            buf = (buf + ch)[-8000:]
            nums = [int(x) for x in re.findall(r"Step (\d+)", buf)]
            if nums and max(nums) - last >= max(1, steps // 100):
                last = max(nums)
                note({"phase": "training", "step": last, "steps": steps})
        proc.wait()
    plys = sorted((out / "result" / "ply").glob("*.ply"), key=lambda p: p.stat().st_mtime)
    if not plys:
        raise RuntimeError(f"no .ply (exit {proc.returncode}), see {out / 'train.log'}")
    info = {"backend": "gsplat-local+pano360-masks", "ply": str(plys[-1]), "steps": steps, "setup_seconds": round(t1 - t0),
            "train_seconds": round(time.time() - t1), "command": " ".join(args), "extra": extra}
    stats = sorted((out / "result" / "stats").glob("val_step*.json"))
    if stats:
        st = json.loads(stats[-1].read_text())
        info.update(eval_psnr=st.get("psnr"), eval_ssim=st.get("ssim"), eval_lpips=st.get("lpips"), num_splats=st.get("num_GS"))
    return info


# =========================================================================== rig SfM (pycolmap)
def rig_sfm(views_dir: Path, masks_dir: Path, work: Path, rig: dict, matcher: str = "sequential", mapper: str = "global",
            max_image_size: int = 1600, views_hi: Path | None = None, pairs: Path | None = None) -> dict:
    """Runs in the SfM python (pycolmap 4; on the GPU server the isolated venv, SPLATTOUR_SFM_PYTHON)."""
    work.mkdir(parents=True, exist_ok=True)
    spec = work / "rig_spec.json"
    spec.write_text(json.dumps({"views": str(views_dir), "views_hi": str(views_hi or views_dir), "masks": str(masks_dir), "work": str(work),
                                "rig": rig, "matcher": matcher, "pairs": str(pairs) if pairs else None,
                                "mapper": mapper, "max_image_size": max_image_size}))
    py = os.environ.get("SPLATTOUR_SFM_PYTHON") or sys.executable
    env = {**os.environ}
    env.pop("SPLATTOUR_SFM_PYTHON", None)
    t = time.time()
    def run(e, logname):
        with open(work / logname, "w", encoding="utf-8") as lf:
            try:
                return subprocess.run([py, "-m", "splattour.pano360", "_sfm", str(spec)], cwd=str(Path(__file__).resolve().parents[1]), env=e,
                                      stdout=lf, stderr=subprocess.STDOUT, timeout=float(os.environ.get("PANO360_SFM_TIMEOUT", 3 * 3600))).returncode
            except subprocess.TimeoutExpired:
                return -9
    rc = run(env, "sfm_stdout.log")
    if rc != 0 and env.get("SPLATTOUR_VOCAB") and matcher == "sequential":
        # vocabulary-tree loop detection (faiss) crashed / hung on some GPU hosts (sfm.py, 2026-09-25): plain sequential
        log(f"rig SfM failed ({rc}) with loop detection: retrying without it")
        os.replace(work / "sfm_stdout.log", work / "sfm_stdout_loop_failed.log")
        env2 = {k: v for k, v in env.items() if k != "SPLATTOUR_VOCAB"}
        rc = run(env2, "sfm_stdout.log")

    class _R:
        returncode = rc
    r = _R()
    if r.returncode != 0:
        tail = (work / "sfm_stdout.log").read_text(encoding="utf-8", errors="ignore")[-1500:]
        raise RuntimeError(f"rig SfM failed ({r.returncode}): {tail}")
    res = json.loads((work / "sfm_result.json").read_text(encoding="utf-8"))
    res["wall_seconds"] = round(time.time() - t)
    return res


def _sfm_main(spec_path: str) -> None:
    import pycolmap
    sp = json.loads(Path(spec_path).read_text())
    views, masks, work = Path(sp["views"]), Path(sp["masks"]), Path(sp["work"])
    views_hi = Path(sp.get("views_hi") or sp["views"])
    rig = sp["rig"]
    rots = [np.array(r) for r in rig["rotations"]]
    gpu = pycolmap.has_cuda
    dev = pycolmap.Device.cuda if gpu else pycolmap.Device.cpu
    cam = rig.get("camera_sfm") or rig["camera"]
    t = {}
    db = work / "database.db"
    if db.exists():
        db.unlink()
    # rig: view 0 is the reference sensor; the others are pure rotations of it (shared centre)
    rcams = []
    for i, R in enumerate(rots):
        c = pycolmap.RigConfigCamera(ref_sensor=i == 0, image_prefix=f"pano_camera{i}/",
                                     cam_from_rig=None if i == 0 else pycolmap.Rigid3d(pycolmap.Rotation3d(R @ rots[0].T), np.zeros((3, 1))))
        rcams.append(c)
    rig_config = pycolmap.RigConfig(cameras=rcams)
    camera = pycolmap.Camera.create_from_model_id(camera_id=0, model=pycolmap.CameraModelId.SIMPLE_PINHOLE, focal_length=cam["params"][0],
                                                  width=cam["width"], height=cam["height"])
    camera.has_prior_focal_length = True
    for c in rig_config.cameras:
        c.camera = camera
    t0 = time.time()
    ext = pycolmap.FeatureExtractionOptions(use_gpu=gpu)
    ext.max_image_size = int(sp["max_image_size"])
    pycolmap.extract_features(db, views, reader_options=pycolmap.ImageReaderOptions(mask_path=masks, camera_model="SIMPLE_PINHOLE",
                                                                                    camera_params=camera.params_to_string()),
                              camera_mode=pycolmap.CameraMode.PER_FOLDER, extraction_options=ext, device=dev)
    with pycolmap.Database.open(db) as d:
        pycolmap.apply_rig_config([rig_config], d)
    t["features"] = time.time() - t0
    t0 = time.time()
    mo = pycolmap.FeatureMatchingOptions()
    mo.rig_verification = True
    mo.skip_image_pairs_in_same_frame = True
    mo.use_gpu = gpu
    vocab = os.environ.get("SPLATTOUR_VOCAB")
    m = sp["matcher"]
    if m == "exhaustive":
        pycolmap.match_exhaustive(db, matching_options=mo)
    elif m == "vocab":
        po = pycolmap.VocabTreePairingOptions()
        if vocab:
            po.vocab_tree_path = vocab
        pycolmap.match_vocabtree(db, pairing_options=po, matching_options=mo)
    else:
        po = pycolmap.SequentialPairingOptions()
        po.overlap = 10  # frames (expand_rig_images pairs all views of neighbouring frames)
        po.quadratic_overlap = True
        if vocab:  # loop closure + links between clips (other camera / other pass)
            po.loop_detection = True
            po.vocab_tree_path = vocab
        pycolmap.match_sequential(db, pairing_options=po, matching_options=mo)
    if sp.get("pairs"):  # cross-clip / loop pairs from an earlier SfM of the same video (pano360_dense.prior_pairs)
        t1 = time.time()
        ip = pycolmap.ImportedPairingOptions()
        ip.match_list_path = sp["pairs"]
        pycolmap.match_image_pairs(db, matching_options=mo, pairing_options=ip)
        t["prior_pairs"] = time.time() - t1
    t["matching"] = time.time() - t0
    t0 = time.time()
    sparse = work / "sparse"
    sparse.mkdir(exist_ok=True)
    if sp["mapper"] == "incremental":
        opts = pycolmap.IncrementalPipelineOptions(ba_refine_sensor_from_rig=False, ba_refine_focal_length=False,
                                                   ba_refine_principal_point=False, ba_refine_extra_params=False)
        recs = pycolmap.incremental_mapping(db, views, sparse, opts)
    else:
        go = pycolmap.GlobalPipelineOptions(mapper=pycolmap.GlobalMapperOptions(refine_sensor_from_rig=False))
        go.mapper.bundle_adjustment.refine_focal_length = False
        go.mapper.bundle_adjustment.refine_principal_point = False
        go.mapper.bundle_adjustment.refine_extra_params = False
        recs = pycolmap.global_mapping(db, views, sparse, go)
    if not recs:
        raise RuntimeError("SfM produced no model")
    best = max(recs.values(), key=lambda r: r.num_reg_images())
    sizes = sorted((r.num_reg_images() for r in recs.values()), reverse=True)
    model = sparse / "best"
    model.mkdir(exist_ok=True)
    best.write(model)
    t["mapping"] = time.time() - t0
    # panorama poses: pano_from_world = pano_from_ref(view 0) * rig_from_world
    pano_from_ref = rots[0].T
    frames = {}
    for im in best.images.values():
        if not im.has_pose or not im.name.startswith("pano_camera0/"):
            continue
        rfw = im.frame.rig_from_world
        Rrw = np.array(rfw.rotation.matrix())
        trw = np.array(rfw.translation).reshape(3)
        R = pano_from_ref @ Rrw
        C = -Rrw.T @ trw
        frames[im.name.split("/", 1)[1]] = {"center": C.tolist(), "R_pano_from_world": R.tolist()}
    # frames whose view 0 did not register but others did
    for im in best.images.values():
        nm = im.name.split("/", 1)[1]
        if im.has_pose and nm not in frames:
            rfw = im.frame.rig_from_world
            Rrw = np.array(rfw.rotation.matrix())
            trw = np.array(rfw.translation).reshape(3)
            frames[nm] = {"center": (-Rrw.T @ trw).tolist(), "R_pano_from_world": (pano_from_ref @ Rrw).tolist()}
    t0 = time.time()
    dense = work / "dense"
    if dense.exists():
        shutil.rmtree(dense)
    if views_hi != views:  # SfM ran on exact 1/k copies: scale the model to the full-resolution views
        from .sfm import _hires_dataset
        dropped = _hires_dataset(work, views_hi, dense)["dropped_cameras"]
    else:
        pycolmap.undistort_images(str(dense), str(model), str(views), output_type="COLMAP")
        s = dense / "sparse"
        (s / "0").mkdir(exist_ok=True)
        for f in ("cameras.bin", "images.bin", "points3D.bin", "rigs.bin", "frames.bin"):
            if (s / f).exists():
                os.replace(s / f, s / "0" / f)
        from .sfm import clean_model
        dropped = clean_model(s / "0", work / "colmap.log")
    t["undistort"] = time.time() - t0

    def clip_of(nm):
        mm = re.search(r"c(\d\d)", nm)
        return mm.group(1) if mm else "?"
    per_clip = {}
    for nm in frames:
        per_clip[clip_of(nm)] = per_clip.get(clip_of(nm), 0) + 1
    model_clips = []  # which clips ended up in which model (connectivity between passes)
    for r in sorted(recs.values(), key=lambda r: -r.num_reg_images()):
        cc = {}
        for im in r.images.values():
            if im.name.startswith("pano_camera0/"):
                cc[clip_of(im.name)] = cc.get(clip_of(im.name), 0) + 1
        model_clips.append(cc)
    n_img = sum(1 for _ in views.rglob("*.jpg"))
    res = {"images": n_img, "registered_images": best.num_reg_images(), "registered_panos": len(frames), "models": sizes,
           "points": best.num_points3D(), "reproj_px": round(best.compute_mean_reprojection_error(), 3), "matcher": m, "mapper": sp["mapper"],
           "backend": f"pycolmap-{pycolmap.__version__}-{'cuda' if gpu else 'cpu'}", "dropped_cameras": dropped,
           "seconds": {k: round(v, 1) for k, v in t.items()}, "dataset": str(dense),
           "registered_panos_per_clip": per_clip, "models_by_clip": model_clips}
    (work / "pano_poses.json").write_text(json.dumps(frames))
    # secondary models (places that did not connect to the main one): own dataset + poses, own world frame
    secondary = []
    for k, r in enumerate(sorted(recs.values(), key=lambda r: -r.num_reg_images())[1:], start=1):
        pf = {}
        for im in r.images.values():
            nm = im.name.split("/", 1)[1]
            if im.has_pose and nm not in pf:
                rfw = im.frame.rig_from_world
                Rrw = np.array(rfw.rotation.matrix())
                trw = np.array(rfw.translation).reshape(3)
                pf[nm] = {"center": (-Rrw.T @ trw).tolist(), "R_pano_from_world": (pano_from_ref @ Rrw).tolist()}
        info = {"model": k, "registered_panos": len(pf), "clips": model_clips[k] if k < len(model_clips) else {}}
        if len(pf) >= int(os.environ.get("PANO360_MIN_SECONDARY", 12)):
            mw = work / f"m{k}"
            (mw / "sparse" / "best").mkdir(parents=True, exist_ok=True)
            r.write(str(mw / "sparse" / "best"))
            try:
                if views_hi != views:
                    from .sfm import _hires_dataset
                    _hires_dataset(mw, views_hi, mw / "dense")
                else:
                    pycolmap.undistort_images(str(mw / "dense"), str(mw / "sparse" / "best"), str(views), output_type="COLMAP")
                    s2 = mw / "dense" / "sparse"
                    (s2 / "0").mkdir(exist_ok=True)
                    for f in ("cameras.bin", "images.bin", "points3D.bin", "rigs.bin", "frames.bin"):
                        if (s2 / f).exists():
                            os.replace(s2 / f, s2 / "0" / f)
                (mw / "pano_poses.json").write_text(json.dumps(pf))
                info.update(dataset=str(mw / "dense"), poses=str(mw / "pano_poses.json"))
            except Exception as e:  # noqa: BLE001
                info["error"] = str(e)[:300]
        secondary.append(info)
    res["secondary_models"] = secondary
    (work / "sfm_result.json").write_text(json.dumps(res))
    print(json.dumps(res))


# =========================================================================== 360 condition: nodes + panoramas
def viewer_transform(dataset: Path, scene_dir: Path | None, camera_height: float) -> dict:
    """splatTransform of the 3DGS tour (tour.json) or, before training, the same alignment computed
    from the model (build_tour uses align() on this model with the same height -> identical)."""
    from .align import align
    from .colmap_io import qvec_to_rotmat, read_model
    if scene_dir and (scene_dir / "tour.json").exists():
        tf = json.loads((scene_dir / "tour.json").read_text(encoding="utf-8"))["splatTransform"]
        qx, qy, qz, qw = tf["quaternion"]
        return {"R": qvec_to_rotmat(np.array([qw, qx, qy, qz])).tolist(), "s": float(tf["scale"]), "t": list(tf["position"]),
                "source": "tour.json"}
    model = read_model(dataset / "sparse" / "0")
    model.drop_outlier_cameras()
    al = align(model, capture_height=camera_height)
    return {"R": np.asarray(al.R).tolist(), "s": float(al.s), "t": np.asarray(al.t).tolist(), "source": "align(model)"}


def nadir_patch(img: np.ndarray, below_deg: float = 62.0, feather_deg: float = 8.0) -> np.ndarray:
    """Blur away the photographer / stick / tripod: everything lower than `below_deg` under the
    horizon becomes a heavily smoothed version of itself, blended in over `feather_deg`."""
    import cv2
    h, w = img.shape[:2]
    v0 = int(h * (0.5 + (below_deg - feather_deg) / 180))
    v1 = int(h * (0.5 + below_deg / 180))
    cap = img[v0:]
    small = cv2.resize(cap, (max(8, w // 40), max(2, cap.shape[0] // 40)), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), 1.5)
    # the pole itself: one average colour per row, so the disc has no seam
    blur = cv2.resize(small, (w, cap.shape[0]), interpolation=cv2.INTER_CUBIC)
    a = np.clip((np.arange(cap.shape[0]) + v0 - v0) / max(1, v1 - v0), 0, 1)[:, None, None]
    out = img.copy()
    out[v0:] = (cap * (1 - a) + blur * a).astype(img.dtype)
    return out


def build_nav(pano_dir: Path, frames: list[dict], poses: dict, tf: dict, out_dir: Path, spacing: float = 1.2,
              labels: dict | None = None, pano_clip: int | None = None, pano_width: int | None = None, nadir_deg: float = 62.0,
              workers: int = 4, person_frac: dict | None = None, window: float = 0.35) -> dict:
    """Capture points every `spacing` m along the SfM path (+ one at every room change), exported as
    equirect panoramas with the nadir blurred, and nav.json nodes in the viewer world frame."""
    import cv2
    R, s, t = np.array(tf["R"]), tf["s"], np.array(tf["t"])
    rows = []
    for fr in frames:
        p = poses.get(fr["name"])
        if not p or (pano_clip is not None and fr["clip"] != pano_clip):
            continue
        C = t + s * (R @ np.array(p["center"]))
        Rpw = np.array(p["R_pano_from_world"])
        d = R @ (Rpw.T @ np.array([0, 0, 1.0]))  # centre column of the panorama, viewer frame
        yaw = math.degrees(math.atan2(-d[0], -d[2]))
        rows.append({**fr, "pos": C, "yaw": yaw})
    if not rows:
        raise RuntimeError("no registered panoramas for the 360 condition")

    def room_of(r):
        for seg in (labels or {}).get("segments", []):
            if seg.get("clip", r["clip"]) == r["clip"] and r["t"] is not None and seg["from"] <= r["t"] <= seg["to"]:
                return seg["room"]
        return (labels or {}).get("default", "공간")
    for r in rows:
        r["room"] = room_of(r)
    picked = []
    for clip in sorted({r["clip"] for r in rows}):
        seq = sorted([r for r in rows if r["clip"] == clip], key=lambda r: (r["t"] if r["t"] is not None else r["sample"]))
        dist, prev, cum = 0.0, None, 0.0
        for i, r in enumerate(seq):
            if prev is not None:
                step = float(np.linalg.norm((r["pos"] - prev["pos"])[[0, 2]]))
                dist += step
                cum += step
            r["cum"] = cum
            room_change = prev is not None and r["room"] != prev["room"]
            if not picked or picked[-1]["clip"] != clip or dist >= spacing or room_change or i == len(seq) - 1:
                if not (i == len(seq) - 1 and dist < 0.4 * spacing and picked and picked[-1]["clip"] == clip):
                    picked.append(r)
                    dist = 0.0
            prev = r
    if person_frac:  # capture points where the photographer covers the least (within +-window*spacing along the path, same room)
        for k, r in enumerate(picked):
            near = [q for q in rows if q["clip"] == r["clip"] and q["room"] == r["room"] and abs(q["cum"] - r["cum"]) <= window * spacing]
            best = min(near, key=lambda q: person_frac.get(q["name"], 1.0))
            if person_frac.get(best["name"], 1.0) < person_frac.get(r["name"], 1.0):
                picked[k] = best
        for r in picked:
            r["personFrac"] = person_frac.get(r["name"])
    # ids, neighbours: consecutive along each clip, plus close points of other clips / loops
    for k, r in enumerate(picked):
        r["id"] = f"p{k + 1:02d}"
    P = np.array([r["pos"][[0, 2]] for r in picked])
    nbr = {r["id"]: set() for r in picked}
    for a, b in zip(picked[:-1], picked[1:]):
        if a["clip"] == b["clip"]:
            nbr[a["id"]].add(b["id"]); nbr[b["id"]].add(a["id"])
    for i in range(len(picked)):
        for j in range(i + 1, len(picked)):
            if float(np.linalg.norm(P[i] - P[j])) < 0.75 * spacing and picked[j]["id"] not in nbr[picked[i]["id"]]:
                nbr[picked[i]["id"]].add(picked[j]["id"]); nbr[picked[j]["id"]].add(picked[i]["id"])
    pano_out = out_dir / "pano"
    pano_out.mkdir(parents=True, exist_ok=True)

    def export(r):
        img = _imread(str(pano_dir / r["name"]), cv2.IMREAD_COLOR)
        img = nadir_patch(img, nadir_deg)
        if pano_width and img.shape[1] != pano_width:
            img = cv2.resize(img, (pano_width, pano_width // 2), interpolation=cv2.INTER_AREA)
        _imwrite(str(pano_out / f"{r['id']}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(export, picked))
    rooms = list(dict.fromkeys(r["room"] for r in picked))
    room_ids = {name: f"room{i + 1}" for i, name in enumerate(rooms)}
    nav = {
        "version": 1,
        "status": {"ready": True, "devPlaceholder": False, "source": "pano360 (same capture and same SfM model as the 3DGS scene)",
                   "importedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "positionsFrom": tf["source"],
                   **({} if labels else {"roomsPlaceholder": True, "note": "방 이름이 아직 없음: labels.json(구간별 방 이름)을 넣고 nav 단계를 다시 실행"})},
        "transition": {"style": "warp", "duration": 0.8},
        "range": {"radius": 2.0},
        "start": picked[0]["id"],
        "rooms": [{"id": room_ids[n], "name": n} for n in rooms],
        "nodes": [{"id": r["id"], "room": room_ids[r["room"]], "position": [round(float(v), 3) for v in r["pos"]],
                   "imageYawDeg": round(r["yaw"], 1), "pano": f"pano/{r['id']}.jpg", "neighbors": sorted(nbr[r["id"]]),
                   "source": {"frame": r["name"], "clip": r["clip"], "t": r["t"], "personFrac": r.get("personFrac")}} for r in picked],
    }
    (out_dir / "nav.json").write_text(json.dumps(nav, ensure_ascii=False, indent=1), encoding="utf-8")
    path_len = sum(float(np.linalg.norm((b["pos"] - a["pos"])[[0, 2]])) for a, b in zip(rows[:-1], rows[1:]) if a["clip"] == b["clip"])
    return {"nodes": len(picked), "rooms": rooms, "registered_panos": len(rows), "path_m": round(path_len, 1), "nav": str(out_dir / "nav.json")}


def relabel(nav_path: Path, labels: dict) -> dict:
    """Room names after the fact (e.g. on a fetched cloud result, whose source frames stay on the server):
    each node gets the room of its source clip/time; positions and panoramas are unchanged."""
    nav = json.loads(nav_path.read_text(encoding="utf-8"))
    names = []
    for n in nav["nodes"]:
        src = n.get("source") or {}
        room = labels.get("default", "공간")
        for seg in labels.get("segments", []):
            if seg.get("clip", src.get("clip")) == src.get("clip") and src.get("t") is not None and seg["from"] <= src["t"] <= seg["to"]:
                room = seg["room"]
        n["_room"] = room
        names.append(room)
    ids = {name: f"room{i + 1}" for i, name in enumerate(dict.fromkeys(names))}
    nav["rooms"] = [{"id": v, "name": k} for k, v in ids.items()]
    for n in nav["nodes"]:
        n["room"] = ids[n.pop("_room")]
    nav["status"].pop("roomsPlaceholder", None)
    nav["status"].pop("note", None)
    nav_path.write_text(json.dumps(nav, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"nav": str(nav_path), "rooms": {k: names.count(k) for k in ids}}


def apply_space(nav_dir: Path, space: str) -> dict:
    """Copy nav.json + pano/*.jpg into viewer/public/spaces/<space>/ (old nav kept as nav.before-pano360.json)."""
    sdir = ROOT / "viewer" / "public" / "spaces" / space
    if not sdir.exists():
        raise SystemExit(f"no space {sdir}")
    nav = json.loads((nav_dir / "nav.json").read_text(encoding="utf-8"))
    old = sdir / "nav.json"
    if old.exists():
        o = json.loads(old.read_text(encoding="utf-8"))
        shutil.copyfile(old, sdir / "nav.before-pano360.json")
        nav["about"] = o.get("about")
        # keep room ids tasks.json refers to when the names match
        by_name = {r["name"]: r["id"] for r in o.get("rooms", [])}
        remap = {r["id"]: by_name.get(r["name"], r["id"]) for r in nav["rooms"]}
        for r in nav["rooms"]:
            r["id"] = remap[r["id"]]
        for n in nav["nodes"]:
            n["room"] = remap[n["room"]]
    (sdir / "pano").mkdir(exist_ok=True)
    for p in (nav_dir / "pano").glob("*.jpg"):
        shutil.copyfile(p, sdir / "pano" / p.name)
    old.write_text(json.dumps(nav, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"space": space, "nodes": len(nav["nodes"]), "rooms": [r["name"] for r in nav["rooms"]]}


# =========================================================================== the whole processing (local or GPU server)
def process(inputs: list[Path], work: Path, *, n_frames: int = 300, fps: float = 3.0, fov: float = 200.0, pano_width: int | None = None,
            max_seconds: float | None = None, matcher: str = "sequential", mapper: str = "global", sfm_side: int = 1600,
            spacing: float = 1.2, camera_height: float = 1.6, labels: dict | None = None, pano_clip: int | None = None,
            nav_pano_width: int | None = None, workers: int = 4, person: bool = True, start: float = 0.0, dense: dict | None = None,
            exclude: list[str] | None = None, mask_refine: bool = False) -> dict:
    """probe -> frames -> views -> person masks -> rig SfM -> dataset. Resumable.
    dense: pano360_dense selection (+ prior image pairs for SfM); mask_refine: hull + temporal union of the person masks."""
    work.mkdir(parents=True, exist_ok=True)
    st_p = work / "pano360.json"
    st = json.loads(st_p.read_text(encoding="utf-8")) if st_p.exists() else {}

    def save():
        st_p.write_text(json.dumps(st, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    if "frames" not in st:
        t = time.time()
        fr = frames_from_inputs(inputs, work / "equirect", n_frames, fps, fov, pano_width, max_seconds, start=start, dense=dense,
                                labels=labels, exclude=exclude)
        st.update(probe=fr.pop("probe"), frames=fr, t_frames=round(time.time() - t))
        save()
        log(f"{len(fr['frames'])} panoramas in {st['t_frames']}s")
    names = [f["name"] for f in st["frames"]["frames"]]
    if "views" not in st:
        t = time.time()
        st["views"] = render_views(work / "equirect", names, work / "views", work / "masks", workers=workers, sfm_dir=work / "views_sfm",
                                   sfm_max=sfm_side)
        st["t_views"] = round(time.time() - t)
        save()
        log(f"{st['views']['images']} views {st['views']['camera']['width']}x{st['views']['camera']['height']} in {st['t_views']}s")
    if "person" not in st and person:
        st["person"] = person_masks(work / "views_sfm", work / "masks", work / "person", equirect=work / "equirect")
        if mask_refine:
            from .pano360_dense import refine_person_masks
            t = time.time()
            st["person"]["refine"] = refine_person_masks(work / "person", st["frames"]["frames"], len(VIEWS), union=1)
            st["person"]["refine"]["seconds"] = round(time.time() - t)
            log("person masks refined", st["person"]["refine"])
        save()
        log("person masks", st["person"])
    if "sfm" not in st:
        many_clips = len({f["clip"] for f in st["frames"]["frames"]}) > 1
        m = matcher
        if many_clips and m == "sequential" and not os.environ.get("SPLATTOUR_VOCAB"):
            m = "exhaustive" if len(names) <= 120 else m
            log("several clips and no vocabulary tree: clips are linked only where file order puts them next to each other"
                if m == "sequential" else "several clips, small set: exhaustive matching")
        pairs = None
        if dense and dense.get("prior"):
            from .pano360_dense import prior_pairs
            (work / "sfm").mkdir(parents=True, exist_ok=True)
            st["prior_pairs"] = prior_pairs(st["frames"]["frames"], dense["prior"], VIEWS, work / "sfm" / "prior_pairs.txt")
            log("prior pairs", st["prior_pairs"])
            pairs = work / "sfm" / "prior_pairs.txt" if st["prior_pairs"].get("pairs") else None
            save()
        st["sfm"] = rig_sfm(work / "views_sfm", work / "masks", work / "sfm", st["views"], matcher=m, mapper=mapper, max_image_size=sfm_side,
                            views_hi=work / "views", pairs=pairs)
        if st.get("person"):
            st["sfm"]["training_masks"] = training_masks(Path(st["sfm"]["dataset"]), work / "person")
        save()
        log("sfm", {k: st["sfm"][k] for k in ("registered_panos", "registered_images", "images", "points", "reproj_px", "models")})
    st["frames_n"] = len(names)
    save()
    return st


def pipeline_figure_assets(work: Path, st: dict, out: Path, want: dict) -> dict:
    """One frame through the pipeline, for the thesis figure: equirect (3840 wide), its 12 perspective views,
    their person masks and SfM feature masks (half size), written to out/. want = {"clip": 1, "t": 182}."""
    import cv2
    out.mkdir(parents=True, exist_ok=True)
    frs = [f for f in st["frames"]["frames"] if f["clip"] == want.get("clip", f["clip"]) and f.get("t") is not None]
    if not frs:
        return {}
    fr = min(frs, key=lambda f: abs(f["t"] - float(want.get("t", 0))))
    nm = fr["name"]
    eq = _imread(work / "equirect" / nm)
    if eq is not None:
        _imwrite(out / "1_equirect.jpg", cv2.resize(eq, (3840, 1920), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 92])
    for i in range(len(VIEWS)):
        v = _imread(work / "views" / f"pano_camera{i}" / nm)
        if v is not None:
            _imwrite(out / f"2_view{i:02d}.jpg", cv2.resize(v, (v.shape[1] // 2, v.shape[0] // 2), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 90])
        for src, tag in ((work / "person" / f"pano_camera{i}" / f"{nm}.png", "3_person"), (work / "masks" / f"pano_camera{i}" / f"{nm}.png", "3_sfmmask")):
            m = _imread(src, cv2.IMREAD_GRAYSCALE)
            if m is not None:
                _imwrite(out / f"{tag}{i:02d}.png", m)
    pm = work / "person" / "equirect" / f"{nm}.png"
    if pm.exists():
        shutil.copyfile(pm, out / "3_person_equirect_down.png")
    info = {"frame": nm, "clip": fr["clip"], "t": fr["t"], "views": VIEWS}
    (out / "frame.json").write_text(json.dumps(info))
    return info


def nav_stage(work: Path, scene_dir: Path | None, *, spacing: float, camera_height: float, labels: dict | None, pano_clip: int | None,
              nav_pano_width: int | None, workers: int = 4, model: int = 0) -> dict:
    """model 0 = the main SfM model; k >= 1 = a place that did not connect (own frame, out dir nav_m<k>)."""
    st = json.loads((work / "pano360.json").read_text(encoding="utf-8"))
    if model:
        sec = next(x for x in st["sfm"]["secondary_models"] if x["model"] == model)
        dataset, poses_p, nav_dir = Path(sec["dataset"]), Path(sec["poses"]), work / f"nav_m{model}"
    else:
        dataset, poses_p, nav_dir = Path(st["sfm"]["dataset"]), work / "sfm" / "pano_poses.json", work / "nav"
    tf = viewer_transform(dataset, scene_dir, camera_height)
    poses = json.loads(poses_p.read_text())
    if pano_clip is None and st["frames"]["clips"] and st.get("probe", {}).get("clips", {}).get("case") == "rig":
        # cameras recorded together: the 360 condition uses ONE of them. Separate passes each cover
        # their own rooms, so all of them give capture points.
        pano_clip = pick_pano_clip(st, poses, tf)
    pf = None
    if (work / "person" / "person_frac.json").exists():
        from .pano360_fill import Scene, person_frac_equirect
        pf = person_frac_equirect(Scene(work, model=model))
    res = build_nav(work / "equirect", st["frames"]["frames"], poses, tf, nav_dir, spacing=spacing, labels=labels,
                    pano_clip=pano_clip, pano_width=nav_pano_width, workers=workers, person_frac=pf)
    res.update(pano_clip=pano_clip, transform=tf["source"], scale=tf["s"], model=model)
    hs = [n["position"][1] for n in json.loads((nav_dir / "nav.json").read_text(encoding="utf-8"))["nodes"]]
    if tf["s"] == 1.0 or not hs or not (0.5 * camera_height < float(np.median(hs)) < 1.5 * camera_height):
        res["warning"] = ("floor/scale not found (align fell back): positions are in SfM units, not metres. The 3DGS tour uses the "
                          "same align(), check tour.json alignment before the study (indoor footage with a visible floor fixes it)")
    st["nav" if not model else f"nav_m{model}"] = res
    (work / "pano360.json").write_text(json.dumps(st, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    return res


def pick_pano_clip(st: dict, poses: dict, tf: dict, eye: float = 1.55) -> int | None:
    """Several cameras: the 360 condition uses ONE of them, the one carried closest to eye height."""
    clips = sorted({f["clip"] for f in st["frames"]["frames"] if f["clip"] >= 0})
    if len(clips) <= 1:
        return clips[0] if clips else None
    R, s, t = np.array(tf["R"]), tf["s"], np.array(tf["t"])
    best, bd = None, 1e9
    for c in clips:
        ys = [(t + s * (R @ np.array(poses[f["name"]]["center"])))[1] for f in st["frames"]["frames"] if f["clip"] == c and f["name"] in poses]
        if ys and abs(float(np.median(ys)) - eye) < bd:
            best, bd = c, abs(float(np.median(ys)) - eye)
    return best


# =========================================================================== cloud
# RunPod secure cloud $/h (maxq.PRICE, 2026-09-25); 48 GB sm_89 cards first (the cached gsplat wheels are sm_89)
PRICE = {"NVIDIA RTX 6000 Ada Generation": 0.84, "NVIDIA L40": 0.82, "NVIDIA L40S": 1.09, "NVIDIA GeForce RTX 4090": 0.74}
GPUS = list(PRICE)  # sm_89: the cached gsplat wheels (tools/wheels/pt24cu124) run on these


def estimate(n_frames: int, pano_w: int, steps: int, cap: int, raw_gb: float) -> dict:
    """Hours/cost on an L40S-class card, from measured runs (QUALITY.md; maxq.estimate's model)."""
    cam = view_camera(pano_w)
    mp = cam["width"] * cam["height"] / 1e6
    n_img = n_frames * len(VIEWS)
    ms = 25 * (mp / 1.17) ** 0.8 * (cap / 2e6) ** 0.5 * 1.4  # L40S ~1.4x an H100-class step time estimate
    train_h = steps * ms / 1000 / 3600
    frames_h = 0.15 + raw_gb * 0.03  # download from R2 + decode (8K HEVC on CPU) + select
    sfm_h = 0.15 + 0.6 * (n_img / 3600)  # GPU SIFT + sequential rig matching + global mapping
    total = 0.25 + frames_h + sfm_h + train_h + 0.2
    rate = max(PRICE.values())
    return {"views": n_img, "view_px": [cam["width"], cam["height"]], "ms_per_step": round(ms), "train_h": round(train_h, 2),
            "total_h": round(total, 2), "usd": round(total * rate, 2), "usd_rate": rate}


def _s3():
    from .inbox import client, keys
    return client(keys())


def balance() -> dict:
    """RunPod account balance (GraphQL) + this month's ledgers."""
    import requests

    from .cloud import api_key
    r = requests.post("https://api.runpod.io/graphql", json={"query": "query { myself { clientBalance currentSpendPerHr } }"},
                      headers={"Authorization": f"Bearer {api_key()}"}, timeout=30)
    me = (r.json().get("data") or {}).get("myself") or {}
    pods = []
    try:
        from .cloud import RunPod
        pods = [{"name": p.get("name"), "status": p.get("desiredStatus"), "cost_per_hr": p.get("costPerHr")} for p in RunPod().list_pods()]
    except Exception as e:  # noqa: BLE001
        pods = [str(e)[:120]]
    return {"balance_usd": me.get("clientBalance"), "spend_per_hr": me.get("currentSpendPerHr"), "pods": pods}


def build_bundle(s3) -> str:
    """Pipeline code + runner/boot360.sh + wheels under its OWN key (the live runner bundle is untouched)."""
    import io
    import secrets as _sec
    import tarfile

    from .inbox import BUCKET
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for p in sorted((ROOT / "pipeline" / "splattour").rglob("*.py")):
            if "__pycache__" not in p.parts:
                tar.add(p, arcname=f"pipeline/{p.relative_to(ROOT / 'pipeline').as_posix()}")
        for name in ("boot.sh", "boot360.sh", "panorama_sfm.py"):
            tar.add(ROOT / "runner" / name, arcname=f"runner/{name}")
        for w in sorted((ROOT / "tools" / "wheels" / "pt24cu124").glob("*.whl")):
            tar.add(w, arcname=f"wheels/{w.name}")
    ref = SECRETS / "runner_bundle_pano360.txt"
    key = ref.read_text().strip() if ref.exists() else f"_runner/{_sec.token_hex(16)}/pano360.tgz"
    for other in ("runner_bundle.txt", "runner_bundle_max.txt"):
        if (SECRETS / other).exists() and key == (SECRETS / other).read_text().strip():
            raise SystemExit("pano360 bundle key must differ from the other runners' bundles")
    s3.put_object(Bucket=BUCKET, Key=key, Body=buf.getvalue(), ContentType="application/gzip", CacheControl="no-cache")
    ref.write_text(key)
    return key


def upload_raw(s3, files: list[Path], name: str) -> list[dict]:
    from boto3.s3.transfer import TransferConfig

    from .inbox import BUCKET
    cfg = TransferConfig(multipart_threshold=64 << 20, multipart_chunksize=64 << 20, max_concurrency=16)
    out = []
    for f in files:
        key = f"pano360/{name}/files/{f.name}"
        try:
            head = s3.head_object(Bucket=BUCKET, Key=key)
            if head["ContentLength"] == f.stat().st_size:
                out.append({"key": key, "size": f.stat().st_size, "name": f.name})
                continue
        except Exception:  # noqa: BLE001
            pass
        t = time.time()
        s3.upload_file(str(f), BUCKET, key, Config=cfg)
        log(f"uploaded {f.name} {f.stat().st_size / 1e9:.2f} GB in {time.time() - t:.0f}s")
        out.append({"key": key, "size": f.stat().st_size, "name": f.name})
    return out


def launch(name: str, files: list[dict], opts: dict, hours: float, dry_run: bool = False, gpus: list[str] | None = None) -> dict:
    from .cloud import IMAGE, RunPod, runner_env
    from .inbox import BUCKET
    from .maxq import _kv, spend_this_month
    s3 = _s3()
    gb = sum(int(f.get("size") or 0) for f in files) / 1e9
    est = estimate(opts["n_frames"], opts.get("pano_w_guess") or 5760, opts["steps"], opts["cap"], gb)
    if gpus:
        est["usd_rate"] = max(PRICE.get(g, 1.2) for g in gpus)
        est["usd"] = round(est["total_h"] * est["usd_rate"], 2)
    spend = spend_this_month(s3)
    plan = {"name": name, "files": len(files), "raw_gb": round(gb, 2), "estimate": est, "spend": spend, "opts": opts, "hours_cap": hours,
            "worst_case_usd": round(math.ceil(hours) * max(PRICE.get(g, 1.2) for g in (gpus or GPUS)), 2)}
    try:
        plan["runpod"] = balance()
    except Exception as e:  # noqa: BLE001
        plan["runpod"] = {"error": str(e)[:200]}
    if dry_run:
        return {"dry_run": True, **plan}
    rp = plan.get("runpod") or {}
    bal, burn = rp.get("balance_usd"), float(rp.get("spend_per_hr") or 0)
    # the balance is shared: servers already running keep spending while this one works
    need = est["usd"] * 1.5 + burn * est["total_h"] * 1.5 + 1
    plan["balance_needed_usd"] = round(need, 2)
    if bal is not None and bal < need and not os.environ.get("PANO360_IGNORE_BALANCE"):
        raise SystemExit(f"RunPod 잔액 ${bal:.2f}: 이번 작업 약 ${est['usd']} + 이미 돌고 있는 서버 ${burn}/h x {est['total_h']}h 를 버티기에 부족해요 "
                         f"(필요 약 ${need:.0f}). 다른 학습이 끝난 뒤 실행하거나 잔액을 채우세요.")
    manifest = {"name": name, "files": files, "opts": opts, "created": time.time()}
    s3.put_object(Bucket=BUCKET, Key=f"pano360/{name}/manifest.json", Body=json.dumps(manifest, ensure_ascii=False).encode(),
                  ContentType="application/json")
    key = build_bundle(s3)
    env = runner_env()
    adm = _kv("r2.txt")
    env.update({"BUNDLE_URL": f"{adm['PUBLIC_URL'].rstrip('/')}/{key}", "MAX_HOURS": str(max(1, int(math.ceil(hours)))),
                "PANO360_NAME": name, "COST_PER_HR": str(max(PRICE.values())), "SPLATTOUR_NO_WHEEL_BUILD": "1"})
    cmd = ('mkdir -p /workspace/st && curl -fsSL "$BUNDLE_URL" | tar xz -C /workspace/st && '
           '(bash /start.sh >/dev/null 2>&1 &) ; bash /workspace/st/runner/boot360.sh')
    body = {"name": f"pano360-{name}"[:40], "imageName": IMAGE, "gpuTypeIds": gpus or GPUS, "gpuTypePriority": "custom", "gpuCount": 1,
            "containerDiskInGb": int(min(1000, max(200, gb * 4 + 150))), "volumeInGb": 0, "ports": ["22/tcp"], "supportPublicIp": True,
            "cloudType": "SECURE", "env": {"PUBLIC_KEY": (SECRETS / "splattour_ed25519.pub").read_text().strip(), **env},
            "dockerStartCmd": ["bash", "-c", cmd]}
    pod = RunPod()._req("POST", "/pods", json=body)
    rec = {**plan, "pod": pod.get("id"), "cost_per_hr": pod.get("costPerHr"), "bundle": key, "launched": time.time()}
    out = ROOT / "data" / "pano360"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{name}.launch.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return rec


def remote() -> None:
    """ON the GPU server: raw files from R2 -> process -> gsplat -> tour/web files -> nav -> archive
    under cloud/pano360/<name>/ -> remove the server (cloudjob.shutdown: ledger + pod delete)."""
    from . import cloudjob
    from .cloudjob import get_json, push_log, put_json, s3c, shutdown
    from .inbox import BUCKET
    name = os.environ["PANO360_NAME"]
    s3 = s3c()
    arch = f"cloud/pano360/{name}/"
    cloudjob.RATE = float(os.environ.get("COST_PER_HR") or 1.0)
    res: dict = {"name": name, "pod": cloudjob.POD, "started": time.time()}

    def put(**kw):
        res.update(kw)
        put_json(s3, arch + "result.json", res)
        push_log(s3)
    try:
        man = get_json(s3, f"pano360/{name}/manifest.json")
        o = man["opts"]
        work = Path("/workspace/p360") / name
        media = work / "media"
        media.mkdir(parents=True, exist_ok=True)
        put(label="downloading")
        from boto3.s3.transfer import TransferConfig
        # the bucket is in APAC and GPU hosts are mostly in the US/EU: one connection gets ~0.2 MB/s (latency-bound),
        # so all files at once, many ranged connections each (first run: 24 GB at 2.8 MB/s = 1.5 h with 16 on one file)
        conc = int(os.environ.get("PANO360_DL_CONC", 48))
        cfg = TransferConfig(multipart_threshold=16 << 20, multipart_chunksize=16 << 20, max_concurrency=conc)
        todo = [f for f in man["files"] if f["name"] not in set(o.get("exclude") or [])
                and not ((media / f["name"]).exists() and (media / f["name"]).stat().st_size == f["size"])]
        t_dl = time.time()
        with ThreadPoolExecutor(max(1, len(todo))) as ex:
            list(ex.map(lambda f: s3.download_file(BUCKET, f["key"], str(media / f["name"]), Config=cfg), todo))
        gb = sum(f["size"] for f in todo) / 1e9
        res["download"] = {"gb": round(gb, 2), "seconds": round(time.time() - t_dl), "mb_s": round(gb * 1000 / max(1, time.time() - t_dl), 1),
                           "connections": conc * len(todo)}
        log("download", res["download"])
        put(label="frames+views+sfm")
        workers = min(16, os.cpu_count() or 4)
        dense = None
        if o.get("dense"):
            dense = dict(o["dense"])
            if dense.get("prior_key"):
                dense["prior"] = get_json(s3, dense["prior_key"])
        st = process([media], work, n_frames=o["n_frames"], fps=o["fps"], fov=o["fov"], pano_width=o.get("pano_width"),
                     matcher=o["matcher"], mapper=o["mapper"], sfm_side=o["sfm_side"], workers=workers, person=o.get("person", True),
                     labels=o.get("labels"), dense=dense, exclude=o.get("exclude"), mask_refine=bool(o.get("mask_refine")))
        from .build_tour import build_tour
        from .run import export_web

        def up(p: Path, k: str):
            if p.exists():
                s3.upload_file(str(p), BUCKET, arch + k)

        def up_dir(d: Path, prefix: str):
            if d.exists():
                with ThreadPoolExecutor(16) as ex:
                    list(ex.map(lambda p: up(p, f"{prefix}/{p.relative_to(d).as_posix()}"), sorted(x for x in d.rglob("*") if x.is_file())))
        ds = Path(st["sfm"]["dataset"])
        put(label="sfm done", probe=st["probe"], frames={"n": st["frames_n"], "clips": st["frames"]["clips"]}, sfm=st["sfm"],
            views={k: st["views"][k] for k in ("pano_size", "camera", "views", "images")}, person=st.get("person"))
        # 1) connectivity + cameras first (the top priority), so they survive whatever happens later
        for f in (ds / "sparse" / "0").glob("*.bin"):
            up(f, f"sparse/{f.name}")
        for f in ("pano360.json", "sfm/pano_poses.json", "sfm/sfm_stdout.log", "sfm/sfm_result.json", "person/person_frac.json", "person/seg.log"):
            up(work / f, f"work/{Path(f).name}")
        secs = [x for x in st["sfm"].get("secondary_models", []) if x.get("dataset")]
        for sec in secs:
            for f in (Path(sec["dataset"]) / "sparse" / "0").glob("*.bin"):
                up(f, f"m{sec['model']}/sparse/{f.name}")
            up(Path(sec["poses"]), f"m{sec['model']}/pano_poses.json")
        # 2) the 360 condition: capture points + photographer-free panoramas (same model, same frame as the 3DGS)
        navs = {}

        def nav_all():
          for mdl in [0] + [x["model"] for x in secs]:
            if not o.get("nav_parallel"):
                put(label=f"360 panoramas (model {mdl})")
            try:
                navs[mdl] = nav_stage(work, None, spacing=o["spacing"], camera_height=o["camera_height"], labels=o.get("labels"),
                                      pano_clip=o.get("pano_clip"), nav_pano_width=o.get("nav_pano_width"), workers=workers, model=mdl)
                from .pano360_fill import main as fill_main
                fill_main([str(work), "--model", str(mdl)])
                navs[mdl]["filled"] = True
            except Exception as e:  # noqa: BLE001 — keep going: the 3DGS still matters
                import traceback
                navs[mdl] = {**navs.get(mdl, {}), "error": str(e)[:300], "trace": traceback.format_exc()[-1500:]}
            nd = work / ("nav" if not mdl else f"nav_m{mdl}")
            up_dir(nd, nd.name)
            up_dir(work / ("nav_filled" if not mdl else f"nav_filled_m{mdl}"), "nav_filled" if not mdl else f"nav_filled_m{mdl}")
            put(nav=navs)
        import threading
        nav_thread = None
        if o.get("nav_parallel"):  # CPU/small-GPU work next to the training (the 6 h cap is tight for ~1000 panoramas)
            nav_thread = threading.Thread(target=nav_all, daemon=True)
            nav_thread.start()
        else:
            nav_all()
        if o.get("figures"):  # thesis figures: pipeline stages of one frame + the training process (pano360_trainfig)
            try:
                fig_dir = work / "figures"
                pipeline_figure_assets(work, st, fig_dir / "pipeline", o["figures"].get("pipeline_frame") or {})
                up_dir(fig_dir, "figures")
                os.environ["PANO360_FIG_DIR"] = str(fig_dir / "training")
                os.environ["PANO360_FIG_VIEWS"] = json.dumps(o["figures"].get("views") or [])
            except Exception as e:  # noqa: BLE001
                res["figures_error"] = str(e)[:300]
        # 3) 3DGS (person-masked loss; falls back to plain gsplat if the masked trainer fails)
        max_h = float(os.environ.get("MAX_HOURS") or 5)
        left_h = max_h - (time.time() - res["started"]) / 3600 - 0.6
        steps = o["steps"]
        if left_h < 1.2:
            steps = max(7000, int(steps * max(0.25, left_h / 1.2)))
        put(label="training", steps=steps, hours_left=round(left_h, 2))

        def progress(d):
            if d.get("step") and d["step"] % max(1, steps // 10) < steps // 100 + 1:
                put(label="training", progress=d)

        def train(dset, out, n_steps):
            try:
                return train_masked(dset, out, steps=n_steps, cap_max=o["cap"], test_every=o["test_every"], progress=progress,
                                    steps_scaler=o.get("steps_scaler", 1) if n_steps == o["steps"] else 1, extra=o.get("train_flags") or [])
            except Exception as e:  # noqa: BLE001
                from .cloud import train_gsplat_local
                put(masked_training_error=str(e)[:400])
                return {**train_gsplat_local(dset, out.parent / (out.name + "_plain"), steps=n_steps, cap_max=o["cap"],
                                             test_every=o["test_every"], progress=progress), "masked": False}
        info = train(ds, work / "train", steps)
        put(label="export", train={k: v for k, v in info.items() if k != "ply"})
        if o.get("figures"):
            try:
                from .pano360_trainfig import tb_to_csv
                tb_to_csv(str(Path(info["ply"]).parents[1]), str(work / "figures" / "training" / "loss.csv"))
            except Exception as e:  # noqa: BLE001
                res["figures_tb_error"] = str(e)[:300]
            up_dir(work / "figures", "figures")
        sdir = ROOT / "scenes" / name
        build_tour(ds / "sparse" / "0", Path(info["ply"]), sdir, title=o.get("title") or name, capture_height=o["camera_height"])
        web = export_web(sdir, mobile_max_splats=o.get("mobile_cap"))
        for f in ("tour.json", "scene.spz", "scene.mobile.spz", "build_report.json", "scene.ply"):
            up(sdir / f, f"scene/{f}")
        for f in (Path(info["ply"]).parents[1] / "stats").glob("*.json"):
            up(f, f"stats/{f.name}")
        up(work / "train" / "train.log", "train.log")
        up(Path(info["ply"]).parents[2] / "train.log", "train_used.log")
        for f in (work / "train" / "setup.log", Path(info["ply"]).parents[2] / "setup.log"):
            up(f, f"logs/{f.parent.name}_{f.name}")
        put(label="main scene done", web=web)
        if nav_thread is not None:
            nav_thread.join(timeout=max(60, (max_h - (time.time() - res["started"]) / 3600 - 0.25) * 3600))
        # 4) places in their own model: a small 3DGS each while time allows
        sec_out = {}
        for sec in secs:
            left_h = max_h - (time.time() - res["started"]) / 3600 - 0.4
            if left_h < 0.6:
                sec_out[sec["model"]] = "skipped: no time left"
                continue
            try:
                k = sec["model"]
                d2 = Path(sec["dataset"])
                i2 = train(d2, work / f"train_m{k}", min(15000, steps))
                s2 = ROOT / "scenes" / f"{name}-m{k}"
                build_tour(d2 / "sparse" / "0", Path(i2["ply"]), s2, title=f"{o.get('title') or name} ({k})", capture_height=o["camera_height"])
                export_web(s2, mobile_max_splats=o.get("mobile_cap"))
                for f in ("tour.json", "scene.spz", "scene.mobile.spz", "build_report.json", "scene.ply"):
                    up(s2 / f, f"scene_m{k}/{f}")
                sec_out[k] = {kk: v for kk, v in i2.items() if kk != "ply"}
            except Exception as e:  # noqa: BLE001
                sec_out[sec["model"]] = f"error: {str(e)[:300]}"
            put(secondary_scenes=sec_out)
        put(label="done", done=True, seconds=round(time.time() - res["started"]))
    except BaseException as e:  # noqa: BLE001
        import traceback
        print(traceback.format_exc(), flush=True)
        try:
            put(label="error", error=str(e)[:500], trace=traceback.format_exc()[-3000:])
        except Exception:  # noqa: BLE001
            pass
    finally:
        shutdown(s3, clear_active=False)


def status(name: str) -> dict:
    from .cloud import RunPod
    from .maxq import _get
    s3 = _s3()
    rec_p = ROOT / "data" / "pano360" / f"{name}.launch.json"
    rec = json.loads(rec_p.read_text(encoding="utf-8")) if rec_p.exists() else {}
    r = {"result": _get(s3, f"cloud/pano360/{name}/result.json")}
    if rec.get("pod"):
        try:
            p = RunPod().pod(rec["pod"])
            r["pod"] = {"id": rec["pod"], "state": p.get("desiredStatus"), "cost_per_hr": p.get("costPerHr"),
                        "hours": round((time.time() - rec["launched"]) / 3600, 2)}
        except RuntimeError as e:
            r["pod"] = {"id": rec["pod"], "state": "gone" if "404" in str(e) else str(e)[:120]}
        r["log"] = f"cloud/logs/{rec['pod']}.log"
    return r


def fetch(name: str, space: str | None = None) -> dict:
    from .inbox import BUCKET
    s3 = _s3()
    arch = f"cloud/pano360/{name}/"
    base = ROOT / "data" / "pano360" / name / "cloud"
    got = 0
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=arch):
        for o in page.get("Contents", []):
            p = base / o["Key"][len(arch):]
            if p.exists() and p.stat().st_size == o["Size"]:
                continue
            p.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(BUCKET, o["Key"], str(p))
            got += 1
    sdir = ROOT / "scenes" / name
    sdir.mkdir(parents=True, exist_ok=True)
    for f in (base / "scene").glob("*"):
        shutil.copyfile(f, sdir / f.name)
    out = {"files": got, "scene": str(sdir), "nav": str(base / "nav")}
    if space:
        out["applied"] = apply_space(base / "nav", space)
    return out


# =========================================================================== CLI
def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m splattour.pano360", description=__doc__.split("\n\n")[0])
    ap.add_argument("cmd", choices=["probe", "dry-run", "process", "nav", "relabel", "cloud", "status", "fetch", "balance", "remote", "_sfm", "_seg"])
    ap.add_argument("inputs", nargs="*", type=Path)
    ap.add_argument("--name", default="wolhajeong360")
    ap.add_argument("--title", default="월하정 (360 영상)")
    ap.add_argument("--from-inbox", help="R2 inbox job id (site upload, e.g. '원본만 보관'): the server reads inbox/<id>/files/*")
    ap.add_argument("--frames", type=int, default=300, help="panoramas for SfM/training (spread by distance walked)")
    ap.add_argument("--fps", type=float, default=3.0, help="candidate sampling rate for frame selection")
    ap.add_argument("--fov", type=float, default=200.0, help="dual-fisheye lens FOV for the ffmpeg v360 stitch (Insta360 ~200)")
    ap.add_argument("--pano-width", type=int, help="resize panoramas for SfM/training (default: source size)")
    ap.add_argument("--matcher", default="sequential", choices=["sequential", "exhaustive", "vocab"])
    ap.add_argument("--mapper", default="global", choices=["global", "incremental"])
    ap.add_argument("--sfm-side", type=int, default=1600)
    ap.add_argument("--steps", type=int, default=60000)
    ap.add_argument("--cap", type=int, default=3_000_000)
    ap.add_argument("--test-every", type=int, default=8, help="0 = train on every view (no held-out score)")
    ap.add_argument("--spacing", type=float, default=1.2, help="metres between 360 capture points")
    ap.add_argument("--camera-height", type=float, default=1.6, help="360 camera height above the floor (m): sets the metric scale")
    ap.add_argument("--labels", type=Path, help='labels.json: {"default": "앞마당", "segments": [{"clip": 0, "from": 12.0, "to": 40.5, "room": "안채"}]} (seconds)')
    ap.add_argument("--pano-clip", type=int, help="several cameras: which clip gives the 360 condition's panoramas (default: closest to eye height)")
    ap.add_argument("--nav-pano-width", type=int, help="width of the exported 360 panoramas (default: source)")
    ap.add_argument("--apply-space", help="fetch/nav: also write nav.json + pano/ into viewer/public/spaces/<space>/")
    ap.add_argument("--hours", type=float, default=6.0, help="cloud: the server removes itself after this long, whatever happens")
    ap.add_argument("--dry-run-cloud", action="store_true", help="cloud: print the plan/cost, rent nothing")
    ap.add_argument("--seconds", type=float, help="use only N seconds of each clip (from --start)")
    ap.add_argument("--start", type=float, default=0.0, help="dry-run: start this many seconds into each clip")
    ap.add_argument("--no-person-mask", action="store_true", help="skip person segmentation (SfM + training masks)")
    ap.add_argument("--train-flags", default="app_opt", help='gsplat flags; default "app_opt" = per-image exposure/appearance '
                    '(clips with very different brightness); "" = none')
    ap.add_argument("--dense-prior", help="cloud: dense sharp selection (every 30 fps frame scored, sharpest per ~0.15-0.5 m); "
                    "travel + cross-clip SfM pairs from this FETCHED earlier run's SfM (name, e.g. wolhajeong360)")
    ap.add_argument("--dense-scale", type=float, help="metres per SfM unit of that run (default: its nav scale)")
    ap.add_argument("--exclude", action="append", default=[], help="cloud: leave this clip file out (repeatable)")
    ap.add_argument("--mask-refine", action="store_true", help="convex hull + temporal union (+-1 panorama) of the person masks for training")
    ap.add_argument("--nav-parallel", action="store_true", help="360 panoramas/fill in a thread next to the training")
    ap.add_argument("--gpus", help="cloud: comma-separated RunPod GPU type ids (default: the sm_89 list)")
    ap.add_argument("--figures", type=Path, help='cloud: record the training for thesis figures, json {"views": [{"name", "clip", "t", '
                    '"view", "focal"}], "pipeline_frame": {"clip", "t"}} (pano360_trainfig.py)')
    ap.add_argument("--work", type=Path)
    a = ap.parse_args(argv)
    labels = json.loads(a.labels.read_text(encoding="utf-8")) if a.labels else None
    work = a.work or ROOT / "data" / "pano360" / a.name
    if a.cmd == "_sfm":
        return _sfm_main(str(a.inputs[0]))
    if a.cmd == "_seg":
        return _seg_main(str(a.inputs[0]))
    if a.cmd == "remote":
        return remote()
    if a.cmd == "probe":
        r = probe(a.inputs)
    elif a.cmd == "balance":
        r = balance()
    elif a.cmd == "status":
        r = status(a.name)
    elif a.cmd == "fetch":
        r = fetch(a.name, a.apply_space)
    elif a.cmd in ("dry-run", "process"):
        dry = a.cmd == "dry-run"
        if dry:
            work = a.work or ROOT / "data" / "pano360" / f"{a.name}-dry"
        st = process(a.inputs, work, n_frames=(a.frames if a.frames != 300 else 20) if dry else a.frames, fps=a.fps, fov=a.fov,
                     pano_width=(a.pano_width or 1920) if dry else a.pano_width, max_seconds=a.seconds or (90 if dry else None),
                     matcher=a.matcher if not dry else "sequential", mapper=a.mapper, sfm_side=a.sfm_side, person=not a.no_person_mask,
                     start=a.start)
        nav = nav_stage(work, ROOT / "scenes" / a.name if not dry else None, spacing=a.spacing, camera_height=a.camera_height, labels=labels,
                        pano_clip=a.pano_clip, nav_pano_width=a.nav_pano_width)
        if a.apply_space and not dry:
            nav["applied"] = apply_space(work / "nav", a.apply_space)
        r = {"work": str(work), "clips": st["frames"]["clips"], "frames": st["frames_n"], "person": st.get("person"), "views": {k: st["views"][k] for k in ("pano_size", "camera", "images")},
             "sfm": {k: st["sfm"].get(k) for k in ("registered_panos", "registered_images", "images", "points", "reproj_px", "models", "seconds", "backend",
                                                  "registered_panos_per_clip", "models_by_clip", "training_masks")},
             "nav": nav}
        if dry:
            pw = max((c.get("width") or 0) for c in st["probe"]["files"]) or 5760
            r["cloud_estimate_full"] = estimate(a.frames, pw, a.steps, a.cap, sum(c["bytes"] for c in st["probe"]["files"]) / 1e9)
    elif a.cmd == "relabel":  # fetched cloud result (or --work): room names from labels.json, then optionally into the app
        nav_dir = (a.work / "nav") if a.work else ROOT / "data" / "pano360" / a.name / "cloud" / "nav"
        if not labels:
            raise SystemExit("--labels labels.json 필요")
        r = relabel(nav_dir / "nav.json", labels)
        if a.apply_space:
            r["applied"] = apply_space(nav_dir, a.apply_space)
    elif a.cmd == "nav":
        r = nav_stage(work, ROOT / "scenes" / a.name, spacing=a.spacing, camera_height=a.camera_height, labels=labels, pano_clip=a.pano_clip,
                      nav_pano_width=a.nav_pano_width)
        if a.apply_space:
            r["applied"] = apply_space(work / "nav", a.apply_space)
    else:  # cloud
        s3 = _s3() if not a.dry_run_cloud or a.inputs else None
        if a.from_inbox:
            from .inbox import BUCKET
            from .maxq import _get
            s3 = s3 or _s3()
            man = _get(s3, f"inbox/{a.from_inbox}/manifest.json") or {}
            files = [{"key": f["key"], "size": f.get("size", 0), "name": Path(f["key"]).name} for f in man.get("files", [])]
            if not files:  # no manifest: list the prefix
                for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=f"inbox/{a.from_inbox}/files/"):
                    files += [{"key": o["Key"], "size": o["Size"], "name": Path(o["Key"]).name} for o in page.get("Contents", [])]
            if not files:
                raise SystemExit(f"inbox/{a.from_inbox}/ 에 파일이 없어요")
            pw = 7680  # the 월하정 originals (probe the files first if unsure)
        else:
            local = expand(a.inputs)
            pr = probe(local)
            pw = max((c.get("width") or 0) for c in pr["files"]) or None
            print(json.dumps({"probe": pr}, ensure_ascii=False, indent=1))
            files = [{"key": f"pano360/{a.name}/files/{f.name}", "size": f.stat().st_size, "name": f.name} for f in local]
            if not a.dry_run_cloud:
                files = upload_raw(s3, local, a.name)
        opts = {"n_frames": a.frames, "fps": a.fps, "fov": a.fov, "pano_width": a.pano_width, "matcher": a.matcher, "mapper": a.mapper,
                "sfm_side": a.sfm_side, "steps": a.steps, "cap": a.cap, "test_every": a.test_every, "spacing": a.spacing,
                "camera_height": a.camera_height, "labels": labels, "pano_clip": a.pano_clip, "nav_pano_width": a.nav_pano_width,
                "title": a.title, "mobile_cap": 1_500_000, "pano_w_guess": pw, "person": not a.no_person_mask,
                "train_flags": a.train_flags.split(),
                "steps_scaler": a.steps // 30000 if a.steps > 30000 and a.steps % 30000 == 0 else 1,
                "exclude": a.exclude, "mask_refine": a.mask_refine, "nav_parallel": a.nav_parallel}
        if a.figures:
            opts["figures"] = json.loads(a.figures.read_text(encoding="utf-8"))
        if a.dense_prior:
            from .pano360_dense import build_prior
            base = ROOT / "data" / "pano360" / a.dense_prior / "cloud"
            scale = a.dense_scale or json.loads((base / "nav" / "nav.json").read_text(encoding="utf-8")).get("scale")                 or json.loads((base / "result.json").read_text(encoding="utf-8"))["nav"]["0"]["scale"]
            prior = build_prior(base / "work" / "pano360.json", base / "work" / "pano_poses.json", float(scale))
            prior_key = f"pano360/{a.name}/prior.json"
            if not a.dry_run_cloud:
                from .inbox import BUCKET
                s3.put_object(Bucket=BUCKET, Key=prior_key, Body=json.dumps(prior).encode(), ContentType="application/json")
            opts["dense"] = {"prior_key": prior_key, "spacing": 0.3, "rot_deg": 20.0, "clip_order": sorted(f["name"] for f in files),
                             "prior_from": a.dense_prior, "prior_scale_m": float(scale), "prior_panos": sum(len(v) for v in prior["clips"].values())}
        r = launch(a.name, files, opts, a.hours, dry_run=a.dry_run_cloud, gpus=a.gpus.split(",") if a.gpus else None)
    print(json.dumps(r, ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main(sys.argv[1:])
