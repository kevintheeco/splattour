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
    def __init__(self, work: Path, model: int = 0):
        from .colmap_io import read_model
        from .pano360 import viewer_transform
        self.work = work
        self.model = model
        self.st = json.loads((work / "pano360.json").read_text(encoding="utf-8"))
        if model:
            sec = next(x for x in self.st["sfm"]["secondary_models"] if x["model"] == model)
            ds = Path(sec["dataset"])
            self.poses = json.loads(Path(sec["poses"]).read_text())
        else:
            ds = Path(self.st["sfm"]["dataset"])
            self.poses = json.loads((work / "sfm" / "pano_poses.json").read_text())
        self.dataset = ds
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
    # cut along a 50 deg yaw x 40 deg pitch grid so that no crop needs more than ~100 deg FOV
    grid = np.zeros_like(merged)
    for gx in range(0, W0, max(1, W0 * 50 // 360)):
        grid[:, gx:gx + 2] = 1
    for gy in range(0, H0, max(1, H0 * 40 // 180)):
        grid[gy:gy + 2, :] = 1
    merged = merged & (1 - grid)
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
        fov = float(np.clip(2 * ang * (1 + 2 * context), 30, 100))
        size = int(np.clip(round(W0 / 360 * fov * 0.9), 512, 2048)) // 8 * 8
        U, V, f = persp_maps(W0, H0, yaw, pitch, fov, size)
        img = cv2.remap(pano, U, V, cv2.INTER_CUBIC, borderMode=cv2.BORDER_WRAP)
        own = cv2.remap(((lab == r) * 255).astype(np.uint8), U, V, cv2.INTER_NEAREST, borderMode=cv2.BORDER_WRAP)
        own = cv2.dilate(own, np.ones((9, 9), np.uint8))
        # the inpainting mask covers EVERY hole pixel inside the crop (a neighbouring job's hole must not be
        # used as context); only this job's own part is written back (<job>_own.png)
        m = cv2.remap((residual * 255).astype(np.uint8), U, V, cv2.INTER_NEAREST, borderMode=cv2.BORDER_WRAP)
        m = cv2.dilate(m, np.ones((9, 9), np.uint8))
        _imwrite(out_dir / f"{pano_id}_h{r:02d}_own.png", own)
        job = f"{pano_id}_h{r:02d}"
        _imwrite(out_dir / f"{job}.jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        _imwrite(out_dir / f"{job}_mask.png", m)
        x, y, w, h, area = [int(v) for v in stats[r]]
        jobs.append({"job": job, "pano": pano_path.name, "image": f"{job}.jpg", "mask": f"{job}_mask.png", "own_mask": f"{job}_own.png",
                     "view": {"yaw_deg": round(yaw, 3), "pitch_deg": round(pitch, 3), "hfov_deg": round(fov, 3), "vfov_deg": round(fov, 3),
                              "width": size, "height": size, "focal_px": round(f, 3),
                              "convention": "pano frame x right, y down, z = equirect centre column; yaw + to the right (u increases), "
                                            "pitch + up; view = rx(-pitch) @ ry(-yaw) (splattour.pano360_fill.view_R)"},
                     "equirect_bbox_xywh": [x, y, w, h], "hole_px": area, "mask_share_of_crop": round(float((m > 0).mean()), 3),
                     "result": f"{job}_filled.jpg (put the inpainted image here, same size)"})
    return jobs


def apply_inpaint(pano_path: Path, jobs: list[dict], job_dir: Path, out_path: Path) -> list[dict]:
    """Put inpainted perspective crops (<job>_filled.jpg) back into the equirect panorama, inside the hole only:
    feathered edge, and the crop's brightness matched to the panorama on a ring just outside the hole.
    Returns the log entries (file, bbox, method)."""
    import cv2
    pano = _imread(pano_path).astype(np.float32)
    H0, W0 = pano.shape[:2]
    done = []
    for j in jobs:
        fp = job_dir / j["result"].split(" ")[0]
        if not fp.exists():
            continue
        side = job_dir / (Path(fp).stem + ".json")
        method = json.loads(side.read_text())["method"] if side.exists() else "generative inpainting on a perspective crop"
        v = j["view"]
        img = _imread(fp)
        if img.shape[1] != v["width"]:
            img = cv2.resize(img, (v["width"], v["height"]), interpolation=cv2.INTER_CUBIC)
        mask = _imread(job_dir / j.get("own_mask", j["mask"]), cv2.IMREAD_GRAYSCALE)
        # only the equirect window the crop covers (bbox + margin; full width near the poles)
        x, y, w, h = j["equirect_bbox_xywh"]
        pad = int(0.6 * max(w, h)) + 32
        y0, y1 = max(0, y - pad), min(H0, y + h + pad)
        if w + 2 * pad > W0 // 2 or y0 < H0 // 8 or y1 > 7 * H0 // 8:
            x0, x1 = 0, W0
        else:
            x0, x1 = x - pad, x + w + pad
        cols = np.arange(x0, x1) % W0
        u_, v_ = np.meshgrid(cols + 0.5, np.arange(y0, y1) + 0.5)
        yaw, pitch = (2 * u_ / W0 - 1) * np.pi, (1 - 2 * v_ / H0) * np.pi / 2
        d = np.stack([np.cos(pitch) * np.sin(yaw), -np.sin(pitch), np.cos(pitch) * np.cos(yaw)], -1)
        c = d @ view_R(v["yaw_deg"], v["pitch_deg"]).T
        ok = c[..., 2] > 1e-3
        f = v["focal_px"]
        xs = np.where(ok, c[..., 0] / np.maximum(c[..., 2], 1e-3) * f + v["width"] / 2 - 0.5, -1).astype(np.float32)
        ys = np.where(ok, c[..., 1] / np.maximum(c[..., 2], 1e-3) * f + v["height"] / 2 - 0.5, -1).astype(np.float32)
        samp = cv2.remap(img, xs, ys, cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT).astype(np.float32)
        mk = cv2.remap(mask, xs, ys, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT).astype(np.float32) / 255
        win = pano[y0:y1][:, cols]
        # exposure: per-channel gain from a ring just outside the hole (panorama vs. the crop there)
        hard = mk > 0.5
        ring = cv2.dilate(hard.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool) & ~hard & (xs >= 0)
        gain = np.ones(3, np.float32)
        if ring.sum() > 100:
            gain = np.clip(np.median(win[ring], 0) / np.maximum(np.median(samp[ring], 0), 1), 0.7, 1.4)
        a = cv2.GaussianBlur(mk, (0, 0), max(1.5, 0.004 * W0 / 4))[..., None] * (mk[..., None] > 0.02)
        win = win * (1 - a) + samp * gain * a
        pano[y0:y1, cols] = win
        done.append({"job": j["job"], "pano": j["pano"], "equirect_bbox_xywh": j["equirect_bbox_xywh"], "hole_px": j["hole_px"],
                     "view": v, "method": method, "exposure_gain": [round(float(g), 3) for g in gain], "source_file": fp.name,
                     "at": time.strftime("%Y-%m-%dT%H:%M:%S")})
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



# ================================================================ v2: monocular depth + forward warping (2026-09-25 night)
def near_mask(D_m: np.ndarray, person: np.ndarray, near_m: float = 0.9, attach_px: int = 12) -> np.ndarray:
    """Things within `near_m` of the camera that touch the person mask: the selfie stick, the mount, the
    hand holding it (camera-fixed clutter the person detector does not call "person")."""
    import cv2
    near = (D_m < near_m).astype(np.uint8)
    n, lab = cv2.connectedComponents(near)
    touch = cv2.dilate((person > 0).astype(np.uint8), np.ones((attach_px, attach_px), np.uint8)) > 0
    keep = np.unique(lab[touch & (near > 0)])
    return np.isin(lab, keep[keep > 0])


class DepthCache:
    def __init__(self, sc: "Scene", W: int, H: int):
        from .pano360_depth import Observed
        self.sc, self.W, self.H = sc, W, H
        self.obs = Observed(sc.dataset / "sparse" / "0")
        self.cache: dict[str, tuple] = {}

    def get(self, name: str, nadir_deg: float):
        """(ray distance SfM units, full removal mask incl. stick) at W x H."""
        if name not in self.cache:
            from .pano360_depth import metric_depth
            sc = self.sc
            D, info = metric_depth(sc.work, name, sc.center(name), sc.R(name), self.obs.by_pano.get(name, np.zeros((0, 3))), self.W, self.H)
            pm = equirect_person_mask(sc.work / "person", name, self.W, self.H, nadir_deg)
            pm = np.zeros((self.H, self.W), np.uint8) if pm is None else pm
            stick = near_mask(D * sc.s, pm)
            # the mount above the camera (another camera / pole at the zenith) is camera-fixed and near too
            zen = np.zeros_like(pm)
            zen[: max(2, int(self.H * 12 / 180))] = 255
            stick |= near_mask(D * sc.s, zen, near_m=1.2)
            import cv2
            # the pole continues up/down through dark pixels (mount at the top); grow the near mask vertically into dark
            g = cv2.cvtColor(cv2.resize(_imread(sc.work / "equirect" / name), (self.W, self.H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
            dark = g < 90
            seed = stick.astype(np.uint8)
            kv = np.ones((9, 3), np.uint8)
            for _ in range(40):
                grown = cv2.dilate(seed, kv) & dark.astype(np.uint8) | seed
                if (grown == seed).all():
                    break
                seed = grown
            stick = seed > 0
            k = max(3, self.W // 150 | 1)
            stick = cv2.dilate(stick.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))) > 0
            full = (pm > 0) | stick
            self.cache = {kk: vv for kk, vv in list(self.cache.items())[-6:]}  # keep memory bounded
            self.cache[name] = (D, full, info, int(stick.sum()))
        return self.cache[name]


def forward_warp(sc: "Scene", q: str, p: str, Dq: np.ndarray, maskq: np.ndarray, need: np.ndarray, W: int, H: int, dirs: np.ndarray):
    """Source panorama q -> target p: for every target pixel in `need`, the source pixel (u, v) that lands
    there (nearest surface wins), NaN where none. Source pixels covered by the person/stick are not used."""
    Rq, Cq, Rp, Cp = sc.R(q), sc.center(q), sc.R(p), sc.center(p)
    import cv2
    mq_d = cv2.dilate(maskq.astype(np.uint8), np.ones((max(3, W // 200),) * 2, np.uint8)) > 0  # depth bleeds at the person's outline
    ok = np.isfinite(Dq) & ~mq_d
    vs, us = np.nonzero(ok)
    X = Cq + Dq[vs, us][:, None] * (dirs[vs, us] @ Rq)
    P = (X - Cp) @ Rp.T
    dist = np.linalg.norm(P, axis=1)
    ut, vt = dirs_to_uv(P, W, H)
    ui = np.round(ut).astype(np.int64) % W
    vi = np.clip(np.round(vt).astype(np.int64), 0, H - 1)
    keep = need[vi, ui]
    ui, vi, dist, us, vs = ui[keep], vi[keep], dist[keep], us[keep], vs[keep]
    order = np.argsort(-dist)  # far first: the nearest surface is written last and wins
    U = np.full((H, W), np.nan, np.float32)
    V = np.full((H, W), np.nan, np.float32)
    Z = np.full((H, W), np.inf, np.float32)
    fu, fv = (ut[keep] - np.round(ut[keep])), (vt[keep] - np.round(vt[keep]))
    for dy, dx in ((0, 0),):
        yy, xx = np.clip(vi[order] + dy, 0, H - 1), (ui[order] + dx) % W
        U[yy, xx] = (us[order] - fu[order]).astype(np.float32)  # sub-pixel: the source point that would land exactly on the centre
        V[yy, xx] = (vs[order] - fv[order]).astype(np.float32)
        Z[yy, xx] = dist[order]
    # close splatting gaps (<= 2 px) with the nearest landed sample
    from scipy import ndimage
    miss = np.isnan(U) & need
    if miss.any() and (~np.isnan(U)).any():
        # normalised convolution: smooth source coordinates across splatting gaps (<= 6 px)
        dt = ndimage.distance_transform_edt(np.isnan(U))
        m = (~np.isnan(U)).astype(np.float32)
        den = cv2.GaussianBlur(m, (0, 0), 2.5)
        uu = cv2.GaussianBlur(np.nan_to_num(U), (0, 0), 2.5) / np.maximum(den, 1e-6)
        vv = cv2.GaussianBlur(np.nan_to_num(V), (0, 0), 2.5) / np.maximum(den, 1e-6)
        # neighbours on both sides of the u seam would average to nonsense: use the nearest there
        _, (iy, ix) = ndimage.distance_transform_edt(np.isnan(U), return_indices=True)
        un = U[iy, ix]
        uu = np.where(np.abs(uu - un) > 8, un, uu)
        fillm = miss & (dt <= 6.0) & (den > 0.05)
        U[fillm] = uu[fillm]
        V[fillm] = vv[fillm]
    return U, V


def _upmap(U: np.ndarray, V: np.ndarray, W0: int, H0: int, Wsrc: int):
    """work-res source coords -> full-res sampling maps (source full res width Wsrc), seam-safe."""
    import cv2
    k = Wsrc / U.shape[1]
    Uf = np.nan_to_num(U, nan=-10) * k + (k - 1) / 2
    Vf = np.nan_to_num(V, nan=-10) * k + (k - 1) / 2
    Ul = cv2.resize(Uf, (W0, H0), interpolation=cv2.INTER_LINEAR)
    Un = cv2.resize(Uf, (W0, H0), interpolation=cv2.INTER_NEAREST)
    Vl = cv2.resize(Vf, (W0, H0), interpolation=cv2.INTER_LINEAR)
    Vn = cv2.resize(Vf, (W0, H0), interpolation=cv2.INTER_NEAREST)
    bad = (np.abs(Ul - Un) > 3 * k) | (np.abs(Vl - Vn) > 3 * k)
    Ul[bad], Vl[bad] = Un[bad], Vn[bad]
    valid = cv2.resize((~np.isnan(U)).astype(np.uint8), (W0, H0), interpolation=cv2.INTER_NEAREST) > 0
    return np.mod(Ul, Wsrc).astype(np.float32), Vl.astype(np.float32), valid


def fill_one_v2(sc: "Scene", name: str, out_dir: Path, dc: DepthCache, max_sources: int = 12, nadir_deg: float = 62.0,
                feather_frac: float = 0.006, nadir_blur_deg: float | None = 72.0) -> dict:
    import cv2
    from scipy import ndimage
    pano = _imread(sc.work / "equirect" / name)
    H0, W0 = pano.shape[:2]
    W, H = dc.W, dc.H
    dirs = pix_dirs(W, H)
    Dp, hole_s, info_p, stick_px = dc.get(name, nadir_deg)
    # the region to replace (work res) and a ring around it (exposure matching)
    ring_s = cv2.dilate(hole_s.astype(np.uint8), np.ones((W // 50,) * 2, np.uint8)).astype(bool) & ~hole_s
    need = hole_s | ring_s
    hole = cv2.resize(hole_s.astype(np.uint8), (W0, H0), interpolation=cv2.INTER_NEAREST) > 0
    me = sc.frames[name]
    cands = [f for f in sc.frames.values() if f["name"] != name and f["name"] in sc.poses and f["clip"] == me["clip"]]
    cands.sort(key=lambda f: (abs((f["t"] or 0) - (me["t"] or 0))))
    comp = np.zeros((H0, W0, 3), np.float32)
    have = np.zeros((H0, W0), bool)
    checked = np.zeros((H0, W0), bool)
    doubt = np.zeros((H0, W0), bool)
    used = []
    for f in cands[:max_sources]:
        if have[hole].all() and checked[hole].mean() > 0.8:
            break
        q = f["name"]
        Dq, mq, _, _ = dc.get(q, nadir_deg)
        U, V = forward_warp(sc, q, name, Dq, mq, need, W, H, dirs)
        if np.isnan(U[hole_s]).all():
            continue
        src = _imread(sc.work / "equirect" / q)
        Uf, Vf, valid = _upmap(U, V, W0, H0, src.shape[1])
        samp = cv2.remap(src, Uf, Vf, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        # exposure: per-channel gain from the ring (same surfaces seen by both frames, no person in either)
        ring = cv2.resize(ring_s.astype(np.uint8), (W0, H0), interpolation=cv2.INTER_NEAREST) > 0
        rr = ring & valid
        gain = np.ones(3, np.float32)
        if rr.sum() > 500:
            gain = np.median(pano[rr].astype(np.float32), 0) / np.maximum(np.median(samp[rr], 0), 1)
            # a source that needs a colour-unbalanced or extreme correction is looking at something else there
            # (wrong depth through glass, another object, a missed person): do not use it
            if gain.max() / max(gain.min(), 1e-3) > 1.6 or gain.min() < 0.3 or gain.max() > 3.5:
                used.append({"frame": q, "t": f["t"], "pixels": 0, "rejected": "gain", "gain": [round(float(g), 3) for g in gain]})
                continue
        samp *= gain
        new = hole & valid & ~have
        both = hole & valid & have & ~checked
        if both.any():
            diff = np.abs(comp[both] - samp[both]).mean(1)
            bad = np.zeros_like(both)
            bad[both] = diff > 35
            doubt |= bad
            checked |= both
        comp[new] = samp[new]
        have |= new
        used.append({"frame": q, "t": f["t"], "pixels": int(new.sum()), "gain": [round(float(g), 3) for g in gain]})
    # smooth exposure correction: difference to the original on the ring, diffused into the hole (push-pull)
    diff = np.zeros((H, W, 3), np.float32)
    m = np.zeros((H, W), np.float32)
    comp_s = cv2.resize(comp, (W, H), interpolation=cv2.INTER_AREA)
    have_s = cv2.resize(have.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST) > 0
    pano_s = cv2.resize(pano, (W, H), interpolation=cv2.INTER_AREA).astype(np.float32)
    ringb = cv2.dilate(hole_s.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & ~hole_s
    # compare the ORIGINAL just outside the hole with the fill just inside it
    inner = hole_s & ~cv2.erode(hole_s.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool) & have_s
    if inner.any():
        _, (iy, ix) = ndimage.distance_transform_edt(~ringb, return_indices=True)
        d_in = pano_s[iy[inner], ix[inner]] - comp_s[inner]
        diff[inner] = d_in
        m[inner] = 1
    sig = W / 60
    corr = cv2.GaussianBlur(diff, (0, 0), sig) / np.maximum(cv2.GaussianBlur(m, (0, 0), sig), 1e-3)[..., None]
    corr = np.where(cv2.GaussianBlur(m, (0, 0), sig)[..., None] > 1e-3, corr, 0)
    corr = np.clip(corr, -60, 60)
    comp += cv2.resize(corr, (W0, H0), interpolation=cv2.INTER_LINEAR) * have[..., None]
    # feathered blend: alpha ramps up over `feather` px inside the hole
    feather = max(3, int(feather_frac * W0))
    dt_in = ndimage.distance_transform_edt(hole & have)
    alpha = np.clip(dt_in / feather, 0, 1)[..., None]
    res = pano.astype(np.float32) * (1 - alpha) + comp * alpha
    res = np.clip(res, 0, 255).astype(np.uint8)
    todo = hole & ~have
    if todo.any():  # placeholder until the AI fill: diffuse the surroundings in (Telea) so the person never shows
        sm = cv2.resize(res, (W0 // 2, H0 // 2), interpolation=cv2.INTER_AREA)
        tm = cv2.dilate(cv2.resize(todo.astype(np.uint8), (W0 // 2, H0 // 2), interpolation=cv2.INTER_NEAREST), np.ones((3, 3), np.uint8))
        ip = cv2.resize(cv2.inpaint(sm, tm, 5, cv2.INPAINT_TELEA), (W0, H0), interpolation=cv2.INTER_CUBIC)
        res[todo] = ip[todo]
    out_dir.mkdir(parents=True, exist_ok=True)
    if nadir_blur_deg:  # the floor right under the camera is where re-projection is least reliable: soft nadir disc
        from .pano360 import nadir_patch
        res = nadir_patch(res, nadir_blur_deg, 8.0)
    _imwrite(out_dir / name, res, [cv2.IMWRITE_JPEG_QUALITY, 94])
    _imwrite(out_dir / (Path(name).stem + "_hole.png"), (hole * 255).astype(np.uint8))
    dd = cv2.morphologyEx(doubt.astype(np.uint8), cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    dd = cv2.dilate(dd, np.ones((15, 15), np.uint8)).astype(bool) & hole
    _imwrite(out_dir / (Path(name).stem + "_ai.png"), ((todo | dd) * 255).astype(np.uint8))
    jobs = inpaint_jobs(out_dir / name, todo | dd, out_dir / "inpaint_jobs", Path(name).stem)
    return {"pano": name, "size": [W0, H0], "method": "forward re-projection of other frames of the same video; depth = Depth Anything V2 "
                                                     "(small) scaled to the SfM points; exposure: per-source gain + smooth boundary correction",
            "hole_px": int(hole.sum()), "stick_px_workres": stick_px, "filled_px": int((hole & have).sum()), "residual_px": int(todo.sum()),
            "filled_share": round(float((hole & have).sum()) / max(1, int(hole.sum())), 3),
            "confirmed_by_2nd_frame_share": round(float((checked & ~doubt)[hole].mean()), 3), "doubt_px": int(dd.sum()),
            "depth_fit": info_p, "sources": used, "inpaint_jobs": jobs, "nadir_blur_below_deg": nadir_blur_deg}


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m splattour.pano360_fill")
    ap.add_argument("work", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--frames", help="comma-separated panorama names (default: the nav nodes' source frames)")
    ap.add_argument("--max-sources", type=int, default=12)
    ap.add_argument("--plane", action="store_true", help="old depth model (floor plane + ring of SfM points) instead of Depth Anything")
    ap.add_argument("--nadir-deg", type=float, default=62.0)
    ap.add_argument("--model", type=int, default=0, help="0 = main SfM model, k = secondary model k (nav_m<k>)")
    ap.add_argument("--apply", action="store_true", help="put the inpainted crops (<job>_filled.jpg) back into the filled panoramas")
    a = ap.parse_args(argv)
    if a.apply:
        out = a.out or a.work / ("nav_filled" if not a.model else f"nav_filled_m{a.model}")
        man = json.loads((out / "inpaint_jobs.json").read_text(encoding="utf-8"))
        by = {}
        for j in man["jobs"]:
            by.setdefault(j["pano"], []).append(j)
        logs = []
        for pano, jobs in by.items():
            pre = out / "before_ai" / pano  # the real-pixel-only version, kept once
            if not pre.exists():
                pre.parent.mkdir(exist_ok=True)
                import shutil
                shutil.copyfile(out / pano, pre)
            logs += apply_inpaint(pre, jobs, out / "inpaint_jobs", out / pano)
        lp = out / "ai_fill_log.json"  # one entry per applied region (re-running --apply replaces the log)
        lp.write_text(json.dumps(logs, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps({"applied": len(logs)}))
        return
    sc = Scene(a.work, a.model)
    out = a.out or a.work / ("nav_filled" if not a.model else f"nav_filled_m{a.model}")
    if a.frames:
        names = a.frames.split(",")
    else:
        nav = json.loads((a.work / ("nav" if not a.model else f"nav_m{a.model}") / "nav.json").read_text(encoding="utf-8"))
        names = [n["source"]["frame"] for n in nav["nodes"]]
    logs = []
    t = time.time()
    dc = None
    if not a.plane:
        from .pano360_depth import ensure
        same = sorted({f["name"] for n in names for f in sc.frames.values() if f["clip"] == sc.frames[n]["clip"] and f["name"] in sc.poses})
        log("depth network", ensure(a.work, same))
        dc = DepthCache(sc, 1280, 640)
    for n in names:
        r = fill_one(sc, n, out, a.max_sources, a.nadir_deg) if a.plane else fill_one_v2(sc, n, out, dc, a.max_sources, a.nadir_deg)
        log(f"{n}: hole {r['hole_px']} px, filled {r['filled_share']:.0%} from {len(r['sources'])} frames, AI jobs {len(r['inpaint_jobs'])}")
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
