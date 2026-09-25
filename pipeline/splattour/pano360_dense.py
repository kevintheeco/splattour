"""Dense sharp frame selection for 360 video (docs/PANO360.md, "촘촘한 선명 프레임").

The first 월하정 run took 400 panoramas from a 3 fps candidate set (one per ~0.42 m, gaps of up to 16 s
where every candidate looked blurred). Here:
  * every frame of the 30 fps video is scored (sharpness on a 1536 px horizon band, optical-flow motion,
    brightness), in parallel per clip;
  * camera travel comes from an earlier SfM of the same video (`prior`: panorama centres and rotations with
    their video times, in metres), interpolated in time; where the prior has no pose (start/end, gaps)
    the optical flow is converted to metres with the clip's own flow-per-metre ratio;
  * one slot = `spacing` metres of travel or `rot_deg` of turning, whichever comes first; slots are halved
    at door/threshold passages (fast brightness change, or a room-label boundary) and in each slot the
    SHARPEST frame wins (sharpness relative to its +-1 s neighbourhood, so dark rooms are not penalised);
  * the prior also gives the cross-clip / loop-closure image pairs for SfM (`prior_pairs`), so separate
    passes through the same room are matched without the vocabulary tree (it crashed on GPU hosts).
Colours/pixels always come from the real frames; the prior only decides WHICH frames and WHICH pairs.
"""
from __future__ import annotations

import json
import math
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np


def log(*a):
    print("[dense]", *a, flush=True)


# --------------------------------------------------------------------------- prior (laptop side)
def build_prior(pano360_json: Path, poses_json: Path, scale_m: float) -> dict:
    """From a finished run (work/pano360.json + pano_poses.json): per clip [(t, centre_m xyz, quat wxyz)]
    in the old model's frame (metres = SfM units * scale_m, the tour's splatTransform scale)."""
    from scipy.spatial.transform import Rotation
    st = json.loads(Path(pano360_json).read_text(encoding="utf-8"))
    P = json.loads(Path(poses_json).read_text())
    clips = {}
    files = {c["clip"]: c["file"] for c in st["frames"]["clips"]}
    for f in st["frames"]["frames"]:
        p = P.get(f["name"])
        if not p or f.get("t") is None:
            continue
        q = Rotation.from_matrix(np.array(p["R_pano_from_world"])).as_quat()  # x y z w
        clips.setdefault(files[f["clip"]], []).append([round(f["t"], 3), *[round(v * scale_m, 4) for v in p["center"]],
                                                        *[round(float(v), 6) for v in (q[3], q[0], q[1], q[2])]])
    for k in clips:
        clips[k].sort()
    return {"scale_m": scale_m, "units": "metres, old model frame", "clips": clips,
            "source": str(pano360_json)}


# --------------------------------------------------------------------------- scoring (server side)
def score_all(rec: dict, width: int = 1536) -> dict:
    """Every frame: sharpness (brightness-normalised Laplacian variance on the horizon band), flow motion
    (median Farneback magnitude, px at `width`), mean brightness."""
    import cv2
    h = width // 2
    band = slice(int(h * 0.25), int(h * 0.75))
    cmd = ["ffmpeg", "-v", "error", "-threads", "8", "-i", rec["file"], "-map", "0:v:0", "-vf", f"scale={width}:{h}:flags=area,format=gray",
           "-f", "rawvideo", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=width * h * 4)
    sharp, motion, bright, prev = [], [], [], None
    fw = width // 4
    while True:
        buf = p.stdout.read(width * h)
        if len(buf) < width * h:
            break
        g = np.frombuffer(buf, np.uint8).reshape(h, width)[band]
        gf = g.astype(np.float32)
        sharp.append(float(cv2.Laplacian(gf, cv2.CV_32F).var() / (gf.var() + 1e-6)))
        bright.append(float(gf.mean()))
        small = cv2.resize(g, (fw, (band.stop - band.start) // 4), interpolation=cv2.INTER_AREA)
        if prev is None:
            motion.append(0.0)
        else:
            fl = cv2.calcOpticalFlowFarneback(prev, small, None, 0.5, 3, 11, 3, 5, 1.1, 0)
            motion.append(float(np.median(np.linalg.norm(fl, axis=2))) * 4)
        prev = small
    p.wait()
    fps = float(rec.get("fps") or 30.0)
    return {"fps": fps, "t0": 0.0, "sharp": sharp, "motion": motion, "bright": bright, "width": width}


def _interp_prior(rows: list, ts: np.ndarray, max_gap: float = 4.0):
    """Centre (m) and rotation for times ts from the prior rows; nan where no bracketing poses within max_gap s."""
    from scipy.spatial.transform import Rotation, Slerp
    r = np.array(rows, float)
    t, C, Q = r[:, 0], r[:, 1:4], r[:, 4:8]
    out_c = np.full((len(ts), 3), np.nan)
    out_R = [None] * len(ts)
    if len(t) < 2:
        return out_c, out_R
    rot = Rotation.from_quat(np.c_[Q[:, 1:], Q[:, :1]])
    sl = Slerp(t, rot)
    j = np.searchsorted(t, ts)
    for i, (tt, jj) in enumerate(zip(ts, j)):
        if jj == 0 or jj >= len(t):
            continue
        a, b = jj - 1, jj
        if t[b] - t[a] > max_gap:
            continue
        w = (tt - t[a]) / max(1e-6, t[b] - t[a])
        out_c[i] = C[a] * (1 - w) + C[b] * w
        out_R[i] = sl([tt]).as_matrix()[0]
    return out_c, out_R


def plan_clip(sc: dict, prior_rows: list | None, spacing: float, rot_deg: float, boundaries: list[float],
              door_factor: float = 0.5, trim_s: float = 1.0) -> dict:
    """Slots along travel; the sharpest frame per slot. Returns indices + diagnostics."""
    s = np.array(sc["sharp"])
    m = np.array(sc["motion"])
    b = np.array(sc["bright"])
    n = len(s)
    fps = sc["fps"]
    ts = np.arange(n) / fps
    k = max(1, int(round(fps)))
    # sharpness relative to the +-1 s neighbourhood (dark rooms and plain walls are not penalised)
    from scipy.ndimage import median_filter, uniform_filter1d
    rel = s / (median_filter(s, size=2 * k + 1, mode="nearest") + 1e-9)
    # travel per frame: prior metres where available, else flow * clip ratio
    dtravel = np.zeros(n)
    drot = np.zeros(n)
    have = np.zeros(n, bool)
    if prior_rows:
        C, R = _interp_prior(prior_rows, ts)
        have = ~np.isnan(C[:, 0])
        d = np.linalg.norm(np.diff(C, axis=0), axis=1)
        ok = have[1:] & have[:-1]
        dtravel[1:][ok] = d[ok]
        for i in np.where(ok)[0]:
            ra, rb = R[i], R[i + 1]
            ang = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(ra @ rb.T) - 1) / 2))))
            drot[i + 1] = ang
    msm = uniform_filter1d(m, 5)
    if have.sum() > 10 and msm[have].sum() > 0:
        ratio = dtravel[have].sum() / max(1e-6, msm[have].sum())  # metres per flow px
    else:
        # no prior at all: assume the first run's median walking speed (0.35 m/s) at the median moving flow
        ratio = 0.35 / max(1e-6, float(np.median(msm[msm > 0.3])) * fps) if (msm > 0.3).any() else 0.0
    flow_d = np.where(msm > 0.25, msm * ratio, 0.0)  # below 0.25 px: standing still
    dtravel = np.where(have, dtravel, flow_d)
    # door/threshold passages: brightness changing fast (log, over 1 s) or within 1.5 s of a room boundary
    lb = np.log(np.maximum(b, 1.0))
    dl = np.abs(np.r_[np.zeros(k), lb[k:] - lb[:-k]])
    door = uniform_filter1d((dl > 0.25).astype(float), 2 * k + 1) > 0
    for tb in boundaries:
        door |= np.abs(ts - tb) < 1.5
    dens = np.where(door, 1.0 / door_factor, 1.0)
    units = (dtravel / spacing + drot / rot_deg) * dens
    valid = np.ones(n, bool)
    valid[: int(trim_s * fps)] = False
    valid[n - int(trim_s * fps):] = False
    valid &= rel > 0.55  # clearly blurred against its neighbours
    cum = np.cumsum(np.where(valid, units, 0))
    slots = np.floor(cum).astype(int)
    idx = []
    for sl in np.unique(slots[valid]):
        cand = np.where(valid & (slots == sl))[0]
        idx.append(int(cand[np.argmax(rel[cand] * 0.5 + s[cand] / (np.median(s[cand]) + 1e-9) * 0.5)]))
    idx = sorted(set(idx))
    return {"idx": idx, "travel_m": round(float(dtravel.sum()), 1), "rot_deg": round(float(drot.sum())), "prior_share": round(float(have.mean()), 3),
            "door_share": round(float(door.mean()), 3), "flow_m_per_px": round(float(ratio), 5), "units": round(float(cum[-1]), 1) if n else 0}


def select_all(clips: list[dict], out: Path, prior: dict | None, n_target: int, labels: dict | None, fov: float,
               extract, spacing0: float = 0.3, rot0: float = 20.0, workers: int = 4) -> dict:
    """Score every clip (parallel), fit the spacing to ~n_target, extract the chosen frames (extract = pano360.extract_selected)."""
    t = time.time()
    with ThreadPoolExecutor(min(workers, len(clips))) as ex:
        scores = list(ex.map(score_all, clips))
    log(f"scored {sum(len(s['sharp']) for s in scores)} frames of {len(clips)} clips in {time.time() - t:.0f}s")
    pri = (prior or {}).get("clips", {})

    def bounds(ci):
        segs = [sg for sg in (labels or {}).get("segments", []) if sg.get("clip") == ci]
        return sorted({x for sg in segs for x in (sg["from"], sg["to"]) if 0 < x < 9000})
    # spacing so the total lands near n_target (clamped to 0.15..0.5 m, rotation step alongside)
    spacing, plans = spacing0, None
    for _ in range(8):
        plans = [plan_clip(sc, pri.get(c["name"]), spacing, rot0 * spacing / spacing0, bounds(c["clip_index"])) for sc, c in zip(scores, clips)]
        tot = sum(len(p["idx"]) for p in plans)
        if abs(tot - n_target) < 0.06 * n_target:
            break
        new = float(np.clip(spacing * tot / n_target, 0.15, 0.5))
        if abs(new - spacing) < 1e-3:
            break
        spacing = new
    log(f"spacing {spacing:.3f} m, {sum(len(p['idx']) for p in plans)} frames: " + ", ".join(f"{c['name']}={len(p['idx'])}" for c, p in zip(clips, plans)))
    frames = []
    t = time.time()

    def one(args):
        c, sc, p = args
        fr = extract(c, c["clip_index"], sc, p["idx"], out, fov, None)
        for f in fr:
            f["file"] = c["name"]
        return fr
    with ThreadPoolExecutor(min(workers, len(clips))) as ex:
        for fr in ex.map(one, zip(clips, scores, plans)):
            frames += fr
    log(f"extracted {len(frames)} panoramas in {time.time() - t:.0f}s")
    diag = [{"clip": c["clip_index"], "file": c["name"], "layout": c.get("layout"), "samples": len(sc["sharp"]), "fps": sc["fps"],
             "motion_total": round(float(np.sum(sc["motion"])), 1), **{k: v for k, v in p.items() if k != "idx"}, "selected": len(p["idx"])}
            for c, sc, p in zip(clips, scores, plans)]
    (out.parent / "dense_scores.json").write_text(json.dumps({"spacing_m": spacing, "clips": diag,
                                                              "scores": {c["name"]: {k: sc[k] for k in ("sharp", "motion", "bright")} for c, sc in zip(clips, scores)},
                                                              "selected": {c["name"]: p["idx"] for c, p in zip(clips, plans)}}))
    return {"clips": diag, "frames": frames, "spacing_m": round(spacing, 3)}


# --------------------------------------------------------------------------- SfM pairs from the prior
def prior_pairs(frames: list[dict], prior: dict, views: list[tuple[float, float]], out_txt: Path, radius_m: float = 1.2,
                k: int = 4, min_dt_same_clip: float = 4.0, max_angle: float = 50.0) -> dict:
    """Image pairs between panoramas that the prior puts within radius_m of each other but that sequential
    matching does not pair (other clip, or same clip > min_dt apart = loop). Only view pairs whose world
    directions are within max_angle (the rig is known: views = (yaw, pitch) of each pano_camera<i>)."""
    from .pano360 import view_rotations
    pri = prior.get("clips", {})
    by_file = {}
    for f in frames:
        by_file.setdefault(f["file"], []).append(f)
    rows = []  # name, clip, t, centre, R_pano_from_world
    for fname, fr in by_file.items():
        if fname not in pri:
            continue
        ts = np.array([f["t"] for f in fr])
        C, R = _interp_prior(pri[fname], ts)
        for f, c, r in zip(fr, C, R):
            if r is not None and not np.isnan(c[0]):
                rows.append((f["name"], f["clip"], f["t"], c, r))
    if len(rows) < 2:
        return {"pairs": 0}
    P = np.array([r[3] for r in rows])
    rots = view_rotations()
    axes = np.array([Rv.T @ np.array([0, 0, 1.0]) for Rv in rots])  # view axes in the pano frame
    cos_max = math.cos(math.radians(max_angle))
    lines, npano = [], 0
    for i, (ni, ci, ti, Ci, Ri) in enumerate(rows):
        d = np.linalg.norm(P - Ci, axis=1)
        cand = [j for j in np.argsort(d)[1:40] if d[j] < radius_m and j > i and (rows[j][1] != ci or abs(rows[j][2] - ti) > min_dt_same_clip)]
        for j in cand[:k]:
            nj, Rj = rows[j][0], rows[j][4]
            wi = axes @ Ri  # world directions (rows) : d_world = R^T d_pano -> (R^T a)^T = a^T R
            wj = axes @ Rj
            cs = wi @ wj.T
            for a, b in zip(*np.where(cs > cos_max)):
                lines.append(f"pano_camera{a}/{ni} pano_camera{b}/{nj}")
            npano += 1
    out_txt.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"pairs": len(lines), "pano_pairs": npano, "with_prior": len(rows), "radius_m": radius_m, "file": str(out_txt)}


# --------------------------------------------------------------------------- training masks: hull + temporal union
def refine_person_masks(person_dir: Path, frames: list[dict], n_views: int, union: int = 1) -> dict:
    """In place, per view mask pano_camera<i>/<name>.png: convex hull of every person blob (dark clothes
    lose their outline), then union with the same view of the +-union neighbouring panoramas of the same
    clip (the photographer stays about where he is relative to the camera). Also updates person_frac.json."""
    import cv2

    from .pano360 import _imread, _imwrite
    seq = {}
    for f in sorted(frames, key=lambda f: (f["clip"], f["t"] if f["t"] is not None else f["sample"])):
        seq.setdefault(f["clip"], []).append(f["name"])
    frac = {}
    changed = 0

    def hull(m):
        if m is None or not m.any():
            return m
        n, lab = cv2.connectedComponents((m > 0).astype(np.uint8))
        out = m.copy()
        for c in range(1, n):
            pts = cv2.findNonZero((lab == c).astype(np.uint8))
            if pts is not None and len(pts) >= 3:
                cv2.fillConvexPoly(out, cv2.convexHull(pts), 255)
        return out
    for v in range(n_views):
        d = person_dir / f"pano_camera{v}"
        for names in seq.values():
            base = [hull(_imread(d / f"{nm}.png", cv2.IMREAD_GRAYSCALE)) for nm in names]
            for i, nm in enumerate(names):
                if base[i] is None:
                    continue
                m = base[i].copy()
                for j in range(max(0, i - union), min(len(names), i + union + 1)):
                    if j != i and base[j] is not None and base[j].shape == m.shape:
                        m = np.maximum(m, base[j])
                old = _imread(d / f"{nm}.png", cv2.IMREAD_GRAYSCALE)
                if old is None or (m > 0).sum() != (old > 0).sum():
                    _imwrite(d / f"{nm}.png", m)
                    changed += 1
                frac[f"pano_camera{v}/{nm}"] = round(float((m > 0).mean()), 4)
    if (person_dir / "person_frac.json").exists() and not (person_dir / "person_frac_raw.json").exists():
        (person_dir / "person_frac_raw.json").write_text((person_dir / "person_frac.json").read_text())
    (person_dir / "person_frac.json").write_text(json.dumps(frac))
    v = np.array(list(frac.values()) or [0])
    return {"refined": changed, "union": union, "hull": True, "mean_person_frac": round(float(v.mean()), 4), "views_over_40pct": int((v > 0.4).sum())}
