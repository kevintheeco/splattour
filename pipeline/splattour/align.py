"""Gravity, floor and metric-scale alignment of an SfM reconstruction.

SfM output lives in an arbitrary similarity frame. For a walkable tour we
need: +Y up (gravity), the floor at a known height, and metres. We estimate

1. up    — the mean image-up vector of all cameras (people hold cameras
           level), refined by a RANSAC floor plane among the sparse points
           that lie below the cameras;
2. floor — that plane's offset;
3. scale — so the median camera height above the floor equals the capture
           height (≈1.45 m for a handheld phone, configurable);
4. yaw   — the dominant wall direction (Manhattan prior) is snapped to the
           X/Z axes so floor plans come out square.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .colmap_io import SparseModel, rotmat_to_qvec


@dataclass
class Alignment:
    R: np.ndarray  # 3x3 rotation, SfM → world
    s: float  # scale
    t: np.ndarray  # translation (applied after rotation+scale)
    floor_y: float  # floor height in world (0 by construction)
    up_confidence: float  # fraction of floor inliers / camera-up agreement
    info: dict

    def apply(self, p: np.ndarray) -> np.ndarray:
        return (self.s * (np.asarray(p) @ self.R.T)) + self.t

    def apply_dir(self, d: np.ndarray) -> np.ndarray:
        return np.asarray(d) @ self.R.T

    def as_splat_transform(self) -> dict:
        """three.js object transform: world = t + R * (s * p)."""
        q = rotmat_to_qvec(self.R)  # (w, x, y, z)
        return {"position": self.t.tolist(), "quaternion": [q[1], q[2], q[3], q[0]], "scale": float(self.s)}


def _rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:
        # 180°: rotate about any axis orthogonal to a
        axis = np.cross(a, [1, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def _ransac_floor(points: np.ndarray, up: np.ndarray, iters: int = 2000, thresh: float = 0.02, max_tilt_deg: float = 20, seed: int = 0):
    """RANSAC plane with normal constrained near `up`. `thresh` is relative to
    the scene extent. Returns (normal, d, inlier_mask) with n·p + d = 0."""
    rng = np.random.default_rng(seed)
    n_pts = len(points)
    if n_pts < 50:
        return None
    extent = np.linalg.norm(np.percentile(points, 95, 0) - np.percentile(points, 5, 0))
    tol = thresh * extent
    cos_max = np.cos(np.radians(max_tilt_deg))
    best = (0, None, None)
    for _ in range(iters):
        idx = rng.choice(n_pts, 3, replace=False)
        p0, p1, p2 = points[idx]
        n = np.cross(p1 - p0, p2 - p0)
        nn = np.linalg.norm(n)
        if nn < 1e-12:
            continue
        n /= nn
        if np.dot(n, up) < 0:
            n = -n
        if np.dot(n, up) < cos_max:
            continue
        d = -np.dot(n, p0)
        inl = np.abs(points @ n + d) < tol
        c = int(inl.sum())
        if c > best[0]:
            best = (c, n, d)
    if best[1] is None:
        return None
    # refine with least squares (SVD) on inliers
    n, d = best[1], best[2]
    inl = np.abs(points @ n + d) < tol
    P = points[inl]
    c = P.mean(0)
    # covariance eigen-decomposition: never materialise the N×N U of a full SVD
    w, v = np.linalg.eigh((P - c).T @ (P - c))
    vt = v.T[::-1]
    n2 = vt[2] if np.dot(vt[2], up) > 0 else -vt[2]
    return n2, -np.dot(n2, c), inl


def _manhattan_yaw(xz: np.ndarray, weights: np.ndarray | None = None) -> float:
    """Dominant orientation (mod 90°) of horizontal structure from local
    point-cloud gradients: build a 2D occupancy image, take the histogram of
    edge orientations, and return the angle that aligns its peak with X."""
    if len(xz) < 200:
        return 0.0
    lo = np.percentile(xz, 1, 0)
    hi = np.percentile(xz, 99, 0)
    res = max((hi - lo).max() / 256, 1e-6)
    W, H = np.ceil((hi - lo) / res).astype(int) + 1
    img = np.zeros((H, W))
    ij = np.clip(((xz - lo) / res).astype(int), 0, [W - 1, H - 1])
    np.add.at(img, (ij[:, 1], ij[:, 0]), 1 if weights is None else weights)
    img = np.log1p(img)
    gy, gx = np.gradient(img)
    mag = np.hypot(gx, gy)
    ang = np.mod(np.arctan2(gy, gx), np.pi / 2)  # fold to [0, 90°)
    hist, edges = np.histogram(ang, bins=90, range=(0, np.pi / 2), weights=mag)
    # circular smoothing
    hist = np.convolve(np.concatenate([hist[-3:], hist, hist[:3]]), np.ones(7) / 7, mode="valid")
    peak = (edges[np.argmax(hist)] + edges[1] / 2)
    return float(peak)


def align(model: SparseModel, capture_height: float = 1.45, manhattan: bool = True) -> Alignment:
    imgs = model.images_sorted()
    centers = np.array([im.center for im in imgs])
    ups = np.array([im.up for im in imgs])
    up0 = ups.mean(0)
    up_agreement = float(np.linalg.norm(up0))  # 1.0 = all cameras perfectly level
    up0 /= np.linalg.norm(up0)

    # Sparse points below the cameras are floor candidates.
    pts = model.xyz[(model.error < np.percentile(model.error, 90)) & (model.track_len >= 3)] if len(model.xyz) else model.xyz
    h_cam = centers @ up0
    h_pts = pts @ up0 if len(pts) else np.zeros(0)
    below = pts[h_pts < np.percentile(h_cam, 5) - 0.1 * (np.ptp(h_cam) + 1e-9)] if len(pts) else pts
    up = up0
    floor_d = None
    inlier_frac = 0.0
    if len(below) >= 50:
        res = _ransac_floor(below, up0)
        if res is not None:
            n, d, inl = res
            inlier_frac = float(inl.mean())
            # The floor must be below every camera.
            if np.all(centers @ n + d > 0) and inlier_frac > 0.08:
                up, floor_d = n, d
    if floor_d is None:
        # Fallback: lowest dense layer of points (or cameras if no points).
        base = h_pts if len(h_pts) else h_cam
        floor_d = -float(np.percentile(base, 2))

    R = _rotation_between(up, np.array([0.0, 1.0, 0.0]))
    cam_h = centers @ up + floor_d  # camera heights above floor (SfM units)
    med_h = float(np.median(cam_h))
    s = capture_height / med_h if med_h > 1e-9 else 1.0

    yaw = 0.0
    if manhattan and len(pts):
        rp = pts @ R.T
        hp = rp[:, 1] - (-floor_d)  # height above floor in SfM units
        wall = rp[(hp > 0.15 * med_h) & (hp < 1.6 * med_h)]
        yaw = _manhattan_yaw(wall[:, [0, 2]])
        # rotation about +Y by yaw maps direction (cos yaw, sin yaw) in (x, z) onto +X
        c, sn = np.cos(yaw), np.sin(yaw)
        Ry = np.array([[c, 0, sn], [0, 1, 0], [-sn, 0, c]])
        R = Ry @ R

    # Translate so the floor is at y=0 and the first camera is above the origin.
    c0 = s * (R @ centers[0])
    t = np.array([-c0[0], s * floor_d, -c0[2]])
    al = Alignment(R=R, s=s, t=t, floor_y=0.0, up_confidence=min(up_agreement, 1.0),
                   info={"floor_inlier_frac": inlier_frac, "median_cam_height_sfm": med_h,
                         "camera_up_agreement": up_agreement, "manhattan_yaw_deg": float(np.degrees(yaw)),
                         "floor_from_ransac": inlier_frac > 0})
    # sanity: floor plane maps to y≈0
    return al
