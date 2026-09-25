"""360° condition panoramas without the photographer, filled with REAL pixels of the same video.

For each capture point (nav node) of pano360:
  1. person mask on the equirect panorama: the per-view YOLO masks of pano360 projected back onto the
     sphere (+ the nadir cap below `nadir_deg`: stick and hands), dilated;
  2. depth of what the person hides: floor plane (camera height from the SfM alignment) for rays
     below the horizon, otherwise the median depth of SfM points in a ring around the hole
     (first surface hit = the smaller of the two);
  3. every hidden pixel is re-projected into other registered frames of the same pass (nearest in
     time first) through those 3D points and its colour copied from the first frame in which that
     spot is NOT covered by the person there; per-source exposure gain from a ring around the hole;
     feathered seam.
  4. what no real frame covers is left as a residual hole: crops + masks + list for generative
     inpainting (Higgsfield, run by the coordinator), every region logged (file, bbox, method, sources)
     for the thesis methods section.
Colours only ever come from captured frames (never from the 3DGS model), so the two study
conditions stay independent. Geometry (poses, sparse points) comes from the shared SfM.

    python -m splattour.pano360_fill <work dir of pano360> [--out DIR] [--nodes p01,p02] [--max-sources 10]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

from .pano360 import VIEWS, _imread, _imwrite, log, view_camera, view_rotations


# ---------------------------------------------------------------- sphere helpers (pano frame: x right, y down, z = centre column)
def pix_dirs(W: int, H: int) -> np.ndarray:
    u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    yaw = (2 * u / W - 1) * np.pi
    pitch = (1 - 2 * v / H) * np.pi / 2
    return np.stack([np.cos(pitch) * np.sin(yaw), -np.sin(pitch), np.cos(pitch) * np.cos(yaw)], -1)  # H x W x 3


def dirs_to_uv(d: np.ndarray, W: int, H: int) -> tuple[np.ndarray, np.ndarray]:
    yaw = np.arctan2(d[..., 0], d[..., 2])
    pitch = -np.arctan2(d[..., 1], np.linalg.norm(d[..., [0, 2]], axis=-1))
    return ((1 + yaw / np.pi) / 2 * W - 0.5).astype(np.float32), ((1 - pitch * 2 / np.pi) / 2 * H - 0.5).astype(np.float32)


def equirect_person_mask(person_dir: Path, name: str, W: int, H: int, nadir_deg: float, dilate_frac: float = 0.01) -> np.ndarray | None:
    """Back-project the 12 per-view person masks of one panorama onto the sphere (W x H, uint8 255 = person)."""
    import cv2
    rots = view_rotations()
    d = pix_dirs(W, H).reshape(-1, 3)
    out = np.zeros(W * H, bool)
    seen = False
    for i, R in enumerate(rots):
        m = _imread(person_dir / f"pano_camera{i}" / f"{name}.png", cv2.IMREAD_GRAYSCALE)
        if m is None:
            continue
        seen = True
        h, w = m.shape
        f = w / (2 * np.tan(np.deg2rad(90.0) / 2))  # HFOV 90
        c = d @ R.T  # into the view's camera frame
        ok = c[:, 2] > 1e-3
        x = np.full(len(c), -1.0)
        y = np.full(len(c), -1.0)
        x[ok] = c[ok, 0] / c[ok, 2] * f + w / 2
        y[ok] = c[ok, 1] / c[ok, 2] * f + h / 2
        ins = ok & (x >= 0) & (x < w) & (y >= 0) & (y < h)
        out[ins] |= m[y[ins].astype(int), x[ins].astype(int)] > 0
    if not seen:
        return None
    mask = out.reshape(H, W).astype(np.uint8) * 255
    eq = _imread(person_dir / "equirect" / f"{name}.png", cv2.IMREAD_GRAYSCALE)  # down-looking mask views (pano360._seg_down)
    if eq is not None:
        mask = np.maximum(mask, cv2.resize(eq, (W, H), interpolation=cv2.INTER_NEAREST))
    # the body always continues down to the camera holder: a column that is "person" at the bottom of the
    # horizontal views (-30 deg) is person all the way to the nadir cap
    v30 = int(H * (0.5 + 30 / 180))
    v_cap0 = int(H * (0.5 + nadir_deg / 180))
    cols = mask[v30 - 2: v30 + 2].max(0) > 0
    mask[v30:v_cap0, cols] = 255
    v_cap = int(H * (0.5 + nadir_deg / 180))
    mask[v_cap:] = 255
    k = max(3, int(dilate_frac * W) | 1)
    return cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))


class Scene:
    def __init__(self, work: Path):
        from .colmap_io import read_model
        from .pano360 import viewer_transform
        self.work = work
        self.st = json.loads((work / "pano360.json").read_text(encoding="utf-8"))
        self.poses = json.loads((work / "sfm" / "pano_poses.json").read_text())
        ds = Path(self.st["sfm"]["dataset"])
        m = read_model(ds / "sparse" / "0")
        self.xyz = m.xyz[(m.track_len >= 3)] if len(m.xyz) else m.xyz
        self.tf = viewer_transform(ds, None, 1.6)
        R = np.array(self.tf["R"])
        self.up = R.T @ np.array([0, 1.0, 0])  # world up (SfM frame)
        self.s = self.tf["s"]
        self.t = np.array(self.tf["t"])
        self.frames = {f["name"]: f for f in self.st["frames"]["frames"]}

    def center(self, name):
        return np.array(self.poses[name]["center"])

    def R(self, name):
        return np.array(self.poses[name]["R_pano_from_world"])

    def height_sfm(self, name):
        """camera height above the floor in SfM units (floor y=0 in the viewer frame)."""
        R = np.array(self.tf["R"])
        y = (self.t + self.s * (R @ self.center(name)))[1]
        return max(0.2, y) / self.s


def fill_one(sc: Scene, name: str, out_dir: Path, max_sources: int = 10, nadir_deg: float = 62.0, work_w: int = 1920) -> dict:
    import cv2
    pano = _imread(sc.work / "equirect" / name)
    H0, W0 = pano.shape[:2]
    W, H = min(work_w, W0), min(work_w, W0) // 2  # geometry at work resolution, colours sampled at full resolution
    person = sc.work / "person"
    mask_small = equirect_person_mask(person, name, W, H, nadir_deg)
    if mask_small is None:
        raise RuntimeError(f"no person masks for {name}")
    hole = cv2.resize(mask_small, (W0, H0), interpolation=cv2.INTER_NEAREST) > 0
    frac0 = float(hole[: int(H0 * (0.5 + nadir_deg / 180))].mean())
    # depth per pixel (work res) for hole pixels
    Rp, Cp = sc.R(name), sc.center(name)
    d_pano = pix_dirs(W, H)
    d_world = d_pano @ Rp  # rows: R^T d
    up = sc.up
    below = -(d_world @ up)
    hcam = sc.height_sfm(name)
    floor_depth = np.where(below > 0.05, hcam / np.maximum(below, 1e-6), np.inf)
    # ring median depth from sparse points
    P = sc.xyz - Cp
    dist = np.linalg.norm(P, axis=1)
    vis = dist > 0.05 * hcam
    pp = (P[vis] / dist[vis, None]) @ Rp.T
    u, v = dirs_to_uv(pp, W, H)
    ui, vi = np.clip(u.astype(int), 0, W - 1), np.clip(v.astype(int), 0, H - 1)
    n_comp, comp = cv2.connectedComponents((mask_small > 0).astype(np.uint8))
    depth = np.full((H, W), np.inf, np.float32)
    ring_info = []
    for c in range(1, n_comp):
        cm = (comp == c).astype(np.uint8)
        ring = cv2.dilate(cm, np.ones((max(3, W // 40),) * 2, np.uint8)) & (1 - cm)
        sel = ring[vi, ui] > 0
        med = float(np.median(dist[vis][sel])) if sel.sum() >= 5 else float(np.median(dist[vis])) if vis.any() else 3 * hcam
        depth[cm > 0] = med
        ring_info.append({"component": c, "ring_points": int(sel.sum()), "depth_sfm": round(med, 3)})
    depth = np.minimum(depth, floor_depth).astype(np.float32)
    # candidate sources: same pass, registered, nearest in time (then in space)
    me = sc.frames[name]
    cands = [f for f in sc.frames.values() if f["name"] != name and f["name"] in sc.poses and f["clip"] == me["clip"]]
    cands.sort(key=lambda f: (abs((f["t"] or 0) - (me["t"] or 0)), np.linalg.norm(sc.center(f["name"]) - Cp)))
    todo = hole.copy()
    todo_small = mask_small > 0
    out = pano.astype(np.float32)
    used = []
    X = Cp + depth[..., None] * d_world  # world points of every pixel (inf outside holes: masked below)
    checked = np.zeros(hole.shape, bool)  # filled pixels that a second real frame has confirmed / contradicted
    doubt = np.zeros(hole.shape, bool)
    hole_small = mask_small > 0
    for f in cands[:max_sources]:
        if not todo_small.any() and checked[hole].mean() > 0.9:
            break
        q = f["name"]
        Rq, Cq = sc.R(q), sc.center(q)
        with np.errstate(invalid="ignore"):
            dq = (X - Cq) @ Rq.T
        uq, vq = dirs_to_uv(dq, W, H)
        mq = equirect_person_mask(person, q, W, H, nadir_deg)
        if mq is None:
            continue
        mq_s = cv2.remap(mq, uq, vq, cv2.INTER_NEAREST, borderMode=cv2.BORDER_WRAP)
        vis_small = hole_small & np.isfinite(depth) & (mq_s == 0)  # this frame sees the spot without the person
        ok_small = todo_small & vis_small
        if vis_small.sum() < 50:
            continue
        src = _imread(sc.work / "equirect" / q)
        # full-res sampling maps: upscale the (uq, vq) maps
        k = W0 / W
        U = cv2.resize(uq * k + (k - 1) / 2, (W0, H0), interpolation=cv2.INTER_LINEAR)
        V = cv2.resize(vq * k + (k - 1) / 2, (W0, H0), interpolation=cv2.INTER_LINEAR)
        U = np.mod(U, W0).astype(np.float32)
        samp = cv2.remap(src, U, V, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        ok = cv2.resize(ok_small.astype(np.uint8), (W0, H0), interpolation=cv2.INTER_NEAREST) > 0
        ok &= todo
        # exposure gain from a ring around the hole where both frames see the same (non-person) scene
        ring = cv2.dilate(hole.astype(np.uint8), np.ones((W0 // 60,) * 2, np.uint8)).astype(bool) & ~hole
        mq_full = cv2.resize(mq_s, (W0, H0), interpolation=cv2.INTER_NEAREST) == 0
        rr = ring & mq_full
        gain = np.ones(3, np.float32)
        if rr.sum() > 200:
            a, b = pano[rr].astype(np.float32), samp[rr]
            gain = np.clip(np.median(a, 0) / np.maximum(np.median(b, 0), 1), 0.25, 4.0)  # auto exposure swings a lot in dark rooms
        # second opinion: where an earlier frame already filled, does this frame see the same colour?
        vis = cv2.resize(vis_small.astype(np.uint8), (W0, H0), interpolation=cv2.INTER_NEAREST) > 0
        cmp_ = vis & hole & ~todo & ~checked
        if cmp_.any():
            diff = np.abs(out[cmp_] - samp[cmp_] * gain).mean(1)
            bad = np.zeros(hole.shape, bool)
            bad[cmp_] = diff > 40  # geometry (depth) wrong there, or something moved: not trustworthy
            doubt |= bad
            checked |= cmp_
        out[ok] = samp[ok] * gain
        todo &= ~ok
        todo_small &= ~ok_small
        used.append({"frame": q, "t": f["t"], "pixels": int(ok.sum()), "gain": [round(float(g), 3) for g in gain],
                     "baseline_sfm": round(float(np.linalg.norm(Cq - Cp)), 3)})
    # feathered seam between filled pixels and the original
    filled = hole & ~todo
    fm = cv2.GaussianBlur(filled.astype(np.float32), (0, 0), max(2, W0 / 800))
    fm = np.where(filled, np.maximum(fm, 0.5), fm)[..., None]
    res = pano.astype(np.float32) * (1 - fm) + out * fm
    res[todo] = pano[todo]  # residual: untouched here, exported for inpainting
    res = np.clip(res, 0, 255).astype(np.uint8)
    out_dir.mkdir(parents=True, exist_ok=True)
    _imwrite(out_dir / name, res, [cv2.IMWRITE_JPEG_QUALITY, 94])
    _imwrite(out_dir / (Path(name).stem + "_hole.png"), (hole * 255).astype(np.uint8))
    _imwrite(out_dir / (Path(name).stem + "_residual.png"), (todo * 255).astype(np.uint8))
    # residual regions -> crops for generative inpainting
    regions = []
    n_r, lab, stats, _ = cv2.connectedComponentsWithStats(todo.astype(np.uint8))
    crops = out_dir / "inpaint"
    for r in range(1, n_r):
        x, y, w, h, area = stats[r]
        if area < 0.0002 * W0 * H0:
            continue
        pad = int(0.25 * max(w, h)) + 16
        x0, y0, x1, y1 = max(0, x - pad), max(0, y - pad), min(W0, x + w + pad), min(H0, y + h + pad)
        crops.mkdir(exist_ok=True)
        base = f"{Path(name).stem}_r{r:02d}"
        _imwrite(crops / f"{base}.jpg", res[y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, 95])
        _imwrite(crops / f"{base}_mask.png", ((lab[y0:y1, x0:x1] == r) * 255).astype(np.uint8))
        pitch_c = (1 - 2 * (y + h / 2) / H0) * 90
        regions.append({"crop": f"inpaint/{base}.jpg", "mask": f"inpaint/{base}_mask.png", "bbox_xywh": [int(x0), int(y0), int(x1 - x0), int(y1 - y0)],
                        "hole_px": int(area), "pitch_deg": round(pitch_c, 1), "nadir": bool(pitch_c < -nadir_deg + 5)})
    # AI jobs: nothing real covered it (todo) or two real frames disagree (doubt, cleaned of speckle)
    import cv2 as _cv
    dd = _cv.morphologyEx(doubt.astype(np.uint8), _cv.MORPH_OPEN, np.ones((5, 5), np.uint8))
    dd = _cv.dilate(dd, np.ones((15, 15), np.uint8)).astype(bool) & hole
    _imwrite(out_dir / (Path(name).stem + "_doubt.png"), (dd * 255).astype(np.uint8))
    jobs = inpaint_jobs(out_dir / name, todo | dd, out_dir / "inpaint_jobs", Path(name).stem)
    return {"pano": name, "size": [W0, H0], "inpaint_jobs": jobs, "person_frac_above_nadir": round(frac0, 4), "hole_px": int(hole.sum()),
            "filled_px": int(filled.sum()), "residual_px": int(todo.sum()),
            "filled_share": round(float(filled.sum()) / max(1, int(hole.sum())), 3),
            "confirmed_by_2nd_frame_share": round(float((checked & ~doubt)[hole].mean()), 3), "doubt_px": int(dd.sum()), "sources": used, "depth": ring_info[:8],
            "residual_regions": regions, "method": "reprojection from other frames of the same video (SfM poses + floor plane / sparse-point depth)"}


# ---------------------------------------------------------------- perspective inpainting jobs (AI fill of what no frame saw)
def view_R(yaw_deg: float, pitch_deg: float) -> np.ndarray:
    """cam_from_pano rotation of a pinhole view looking at (yaw, pitch) (pano360.view_rotations convention)."""
    p, y = np.deg2rad([-pitch_deg, -yaw_deg])
    rx = np.array([[1, 0, 0], [0, np.cos(p), -np.sin(p)], [0, np.sin(p), np.cos(p)]])
    ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    return rx @ ry


def persp_maps(W0: int, H0: int, yaw: float, pitch: float, fov: float, size: int):
    """remap grids (equirect W0 x H0 -> square pinhole view `size` px, horizontal=vertical FOV `fov`)."""
    f = size / (2 * np.tan(np.deg2rad(fov) / 2))
    xs, ys = np.meshgrid(np.arange(size) + 0.5, np.arange(size) + 0.5)
    rays = np.stack([(xs - size / 2) / f, (ys - size / 2) / f, np.ones_like(xs)], -1)
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    rp = rays @ view_R(yaw, pitch)
    u, v = dirs_to_uv(rp, W0, H0)
    return np.mod(u, W0).astype(np.float32), v, f


def inpaint_jobs(pano_path: Path, residual: np.ndarray, out_dir: Path, pano_id: str, context: float = 0.35, min_px: int = 3000) -> list[dict]:
    """One perspective crop per residual hole: centred on the hole, FOV = hole extent + `context` on each
    side, pixel size matching the panorama's angular resolution (<= 2048). Writes <job>.jpg + <job>_mask.png."""
    import cv2
    pano = _imread(pano_path)
    H0, W0 = residual.shape
    # nearby holes become one job (one coherent crop for the inpainting model)
    merged = cv2.dilate(residual.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (W0 // 40 | 1,) * 2))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(merged)
    lab = np.where(residual, lab, 0)
    d = None
    jobs = []
    out_dir.mkdir(parents=True, exist_ok=True)
    for r in range(1, n):
        if stats[r, 4] < min_px * (W0 / 3840) ** 2:
            continue
        if d is None:
            d = pix_dirs(W0 // 4, H0 // 4)
        small = cv2.resize((lab == r).astype(np.uint8), (W0 // 4, H0 // 4), interpolation=cv2.INTER_NEAREST) > 0
        if not small.any():
            small = cv2.resize((lab == r).astype(np.uint8), (W0 // 4, H0 // 4), interpolation=cv2.INTER_AREA) > 0
            if not small.any():
                continue
        dirs = d[small]
        c = dirs.mean(0)
        c /= np.linalg.norm(c)
        yaw = math.degrees(math.atan2(c[0], c[2]))
        pitch = math.degrees(-math.atan2(c[1], math.hypot(c[0], c[2])))
        ang = float(np.degrees(np.arccos(np.clip(dirs @ c, -1, 1))).max())  # angular radius of the hole
        fov = float(np.clip(2 * ang * (1 + 2 * context), 30, 150))
        size = int(np.clip(round(W0 / 360 * fov * 0.9), 512, 2048)) // 8 * 8
        U, V, f = persp_maps(W0, H0, yaw, pitch, fov, size)
        img = cv2.remap(pano, U, V, cv2.INTER_CUBIC, borderMode=cv2.BORDER_WRAP)
        m = cv2.remap(((lab == r) * 255).astype(np.uint8), U, V, cv2.INTER_NEAREST, borderMode=cv2.BORDER_WRAP)
        m = cv2.dilate(m, np.ones((9, 9), np.uint8))
        job = f"{pano_id}_h{r:02d}"
        _imwrite(out_dir / f"{job}.jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        _imwrite(out_dir / f"{job}_mask.png", m)
        x, y, w, h, area = [int(v) for v in stats[r]]
        jobs.append({"job": job, "pano": pano_path.name, "image": f"{job}.jpg", "mask": f"{job}_mask.png",
                     "view": {"yaw_deg": round(yaw, 3), "pitch_deg": round(pitch, 3), "hfov_deg": round(fov, 3), "vfov_deg": round(fov, 3),
                              "width": size, "height": size, "focal_px": round(f, 3),
                              "convention": "pano frame x right, y down, z = equirect centre column; yaw + to the right (u increases), "
                                            "pitch + up; view = rx(-pitch) @ ry(-yaw) (splattour.pano360_fill.view_R)"},
                     "equirect_bbox_xywh": [x, y, w, h], "hole_px": area, "mask_share_of_crop": round(float((m > 0).mean()), 3),
                     "result": f"{job}_filled.jpg (put the inpainted image here, same size)"})
    return jobs


def apply_inpaint(pano_path: Path, jobs: list[dict], job_dir: Path, out_path: Path) -> list[dict]:
    """Put inpainted perspective crops (<job>_filled.jpg) back into the equirect panorama, inside the hole only
    (feathered). Returns the log entries (file, bbox, method)."""
    import cv2
    pano = _imread(pano_path).astype(np.float32)
    H0, W0 = pano.shape[:2]
    d = pix_dirs(W0, H0)
    done = []
    for j in jobs:
        fp = job_dir / j["result"].split(" ")[0]
        if not fp.exists():
            continue
        v = j["view"]
        img = _imread(fp)
        if img.shape[1] != v["width"]:
            img = cv2.resize(img, (v["width"], v["height"]), interpolation=cv2.INTER_CUBIC)
        mask = _imread(job_dir / j["mask"], cv2.IMREAD_GRAYSCALE)
        R = view_R(v["yaw_deg"], v["pitch_deg"])
        c = d @ R.T
        ok = c[..., 2] > 1e-3
        f = v["focal_px"]
        x = np.where(ok, c[..., 0] / np.maximum(c[..., 2], 1e-3) * f + v["width"] / 2 - 0.5, -1).astype(np.float32)
        y = np.where(ok, c[..., 1] / np.maximum(c[..., 2], 1e-3) * f + v["height"] / 2 - 0.5, -1).astype(np.float32)
        samp = cv2.remap(img, x, y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT).astype(np.float32)
        mk = cv2.remap(mask, x, y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT).astype(np.float32) / 255
        mk = cv2.GaussianBlur(mk, (0, 0), 2)[..., None]
        pano = pano * (1 - mk) + samp * mk
        done.append({"job": j["job"], "pano": j["pano"], "equirect_bbox_xywh": j["equirect_bbox_xywh"], "hole_px": j["hole_px"],
                     "method": "generative inpainting (Higgsfield) on a perspective crop, reprojected", "source_file": fp.name})
    _imwrite(out_path, np.clip(pano, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 94])
    return done


def person_frac_equirect(sc: Scene, nadir_deg: float = 62.0) -> dict:
    """Share of each registered panorama (above the nadir cap) covered by the person."""
    out = {}
    for name in sc.poses:
        m = equirect_person_mask(sc.work / "person", name, 512, 256, nadir_deg, dilate_frac=0.0)
        if m is not None:
            out[name] = round(float((m[: int(256 * (0.5 + nadir_deg / 180))] > 0).mean()), 4)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m splattour.pano360_fill")
    ap.add_argument("work", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--frames", help="comma-separated panorama names (default: the nav nodes' source frames)")
    ap.add_argument("--max-sources", type=int, default=10)
    ap.add_argument("--nadir-deg", type=float, default=62.0)
    ap.add_argument("--apply", action="store_true", help="put the inpainted crops (<job>_filled.jpg) back into the filled panoramas")
    a = ap.parse_args(argv)
    if a.apply:
        out = a.out or a.work / "nav_filled"
        man = json.loads((out / "inpaint_jobs.json").read_text(encoding="utf-8"))
        by = {}
        for j in man["jobs"]:
            by.setdefault(j["pano"], []).append(j)
        logs = []
        for pano, jobs in by.items():
            logs += apply_inpaint(out / pano, jobs, out / "inpaint_jobs", out / pano)
        lp = out / "ai_fill_log.json"
        old = json.loads(lp.read_text(encoding="utf-8")) if lp.exists() else []
        lp.write_text(json.dumps(old + logs, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps({"applied": len(logs)}))
        return
    sc = Scene(a.work)
    out = a.out or a.work / "nav_filled"
    if a.frames:
        names = a.frames.split(",")
    else:
        nav = json.loads((a.work / "nav" / "nav.json").read_text(encoding="utf-8"))
        names = [n["source"]["frame"] for n in nav["nodes"]]
    logs = []
    t = time.time()
    for n in names:
        r = fill_one(sc, n, out, a.max_sources, a.nadir_deg)
        log(f"{n}: hole {r['hole_px']} px, filled {r['filled_share']:.0%} from {len(r['sources'])} frames, residual regions {len(r['residual_regions'])}")
        logs.append(r)
    (out / "fill_log.json").write_text(json.dumps({"created": time.strftime("%Y-%m-%dT%H:%M:%S"), "panoramas": logs,
                                                   "note": "colours copied only from captured video frames; residual_regions are for generative inpainting "
                                                           "(to be logged with the tool used)"}, ensure_ascii=False, indent=1), encoding="utf-8")
    inp = [j for r in logs for j in r["inpaint_jobs"]]
    (out / "inpaint_jobs.json").write_text(json.dumps({"about": "perspective crops of holes no captured frame covers. For each job: inpaint "
                                                       "<image> inside <mask> (white = fill), save as <job>_filled.jpg in inpaint_jobs/, then run "
                                                       "python -m splattour.pano360_fill <work> --apply. Every applied job is logged in ai_fill_log.json.",
                                                       "jobs": inp}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"panoramas": len(logs), "seconds": round(time.time() - t), "mean_filled_share": round(float(np.mean([r["filled_share"] for r in logs])), 3),
                      "inpaint_regions": len(inp), "out": str(out)}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
