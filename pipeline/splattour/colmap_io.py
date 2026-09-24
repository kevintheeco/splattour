"""Minimal COLMAP sparse model reader (binary and text formats).

Only what the pipeline needs: camera intrinsics, per-image pose, and the
sparse point cloud. Avoids a hard dependency on pycolmap.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

CAMERA_MODEL_PARAMS = {
    0: ("SIMPLE_PINHOLE", 3), 1: ("PINHOLE", 4), 2: ("SIMPLE_RADIAL", 4), 3: ("RADIAL", 5),
    4: ("OPENCV", 8), 5: ("OPENCV_FISHEYE", 8), 6: ("FULL_OPENCV", 12), 7: ("FOV", 5),
    8: ("SIMPLE_RADIAL_FISHEYE", 4), 9: ("RADIAL_FISHEYE", 5), 10: ("THIN_PRISM_FISHEYE", 12),
    11: ("RAD_TAN_THIN_PRISM_FISHEYE", 16),
}


@dataclass
class Camera:
    id: int
    model: str
    width: int
    height: int
    params: np.ndarray


@dataclass
class Image:
    id: int
    name: str
    camera_id: int
    qvec: np.ndarray  # world-to-camera rotation, (w, x, y, z)
    tvec: np.ndarray  # world-to-camera translation
    point3d_ids: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))

    @property
    def R(self) -> np.ndarray:
        return qvec_to_rotmat(self.qvec)

    @property
    def center(self) -> np.ndarray:
        """Camera centre in world coordinates."""
        return -self.R.T @ self.tvec

    @property
    def forward(self) -> np.ndarray:
        """Viewing direction (+Z of the OpenCV camera) in world coordinates."""
        return self.R.T @ np.array([0.0, 0.0, 1.0])

    @property
    def up(self) -> np.ndarray:
        """Image-up direction (-Y of the OpenCV camera) in world coordinates."""
        return self.R.T @ np.array([0.0, -1.0, 0.0])


@dataclass
class SparseModel:
    cameras: dict[int, Camera]
    images: dict[int, Image]
    xyz: np.ndarray  # (N, 3)
    rgb: np.ndarray  # (N, 3) uint8
    error: np.ndarray  # (N,)
    track_len: np.ndarray  # (N,)

    def images_sorted(self) -> list[Image]:
        return sorted(self.images.values(), key=lambda im: im.name)

    def drop_outlier_cameras(self, k: int = 3, factor: float = 10.0, min_gap: float = 2.0, margin: float = 10.0) -> list[str]:
        """Remove mis-registered cameras (global SfM occasionally throws a few
        views hundreds of km away) and the sparse points far outside the
        capture. A walkthrough is a continuous path, so a real camera always
        has close neighbours; an isolated one is an outlier. Returns the
        names of the dropped images."""
        ids = list(self.images)
        if len(ids) <= k + 1:
            return []
        c = np.array([self.images[i].center for i in ids])
        d = np.linalg.norm(c[:, None] - c[None], axis=2)
        nn = np.sort(d, 1)[:, k]
        bad = nn > max(min_gap, factor * float(np.median(nn)))
        dropped = [self.images[i].name for i, b in zip(ids, bad) if b]
        for i, b in zip(ids, bad):
            if b:
                del self.images[i]
        good = c[~bad]
        if len(self.xyz):
            lo, hi = good.min(0) - margin, good.max(0) + margin
            keep = np.all((self.xyz >= lo) & (self.xyz <= hi), 1)
            self.xyz, self.rgb, self.error, self.track_len = self.xyz[keep], self.rgb[keep], self.error[keep], self.track_len[keep]
        return dropped


def qvec_to_rotmat(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * z * x + 2 * w * y],
        [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
        [2 * z * x - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
    ])


def rotmat_to_qvec(R: np.ndarray) -> np.ndarray:
    """Rotation matrix to (w, x, y, z), numerically stable."""
    K = np.array([
        [R[0, 0] - R[1, 1] - R[2, 2], 0, 0, 0],
        [R[1, 0] + R[0, 1], R[1, 1] - R[0, 0] - R[2, 2], 0, 0],
        [R[2, 0] + R[0, 2], R[2, 1] + R[1, 2], R[2, 2] - R[0, 0] - R[1, 1], 0],
        [R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1], R[0, 0] + R[1, 1] + R[2, 2]],
    ]) / 3.0
    vals, vecs = np.linalg.eigh(K)
    q = vecs[[3, 0, 1, 2], np.argmax(vals)]
    return q if q[0] >= 0 else -q


def _read(f, fmt: str):
    size = struct.calcsize("<" + fmt)
    return struct.unpack("<" + fmt, f.read(size))


def _read_cameras_bin(path: Path) -> dict[int, Camera]:
    cams = {}
    with open(path, "rb") as f:
        (n,) = _read(f, "Q")
        for _ in range(n):
            cid, model_id, w, h = _read(f, "iiQQ")
            name, nparams = CAMERA_MODEL_PARAMS[model_id]
            params = np.array(_read(f, "d" * nparams))
            cams[cid] = Camera(cid, name, w, h, params)
    return cams


def _read_images_bin(path: Path) -> dict[int, Image]:
    imgs = {}
    with open(path, "rb") as f:
        (n,) = _read(f, "Q")
        for _ in range(n):
            iid, qw, qx, qy, qz, tx, ty, tz, cid = _read(f, "idddddddi")
            name = b""
            while (c := f.read(1)) != b"\x00":
                name += c
            (npts,) = _read(f, "Q")
            data = np.frombuffer(f.read(24 * npts), dtype=np.dtype([("xy", "<f8", 2), ("id", "<i8")]))
            imgs[iid] = Image(iid, name.decode("utf-8"), cid, np.array([qw, qx, qy, qz]), np.array([tx, ty, tz]), data["id"].copy())
    return imgs


def _read_points_bin(path: Path):
    with open(path, "rb") as f:
        (n,) = _read(f, "Q")
        xyz = np.zeros((n, 3))
        rgb = np.zeros((n, 3), np.uint8)
        err = np.zeros(n)
        tl = np.zeros(n, np.int32)
        for i in range(n):
            _pid, x, y, z, r, g, b, e = _read(f, "QdddBBBd")
            (t,) = _read(f, "Q")
            f.seek(8 * t, 1)
            xyz[i] = (x, y, z)
            rgb[i] = (r, g, b)
            err[i] = e
            tl[i] = t
    return xyz, rgb, err, tl


def _read_cameras_txt(path: Path) -> dict[int, Camera]:
    cams = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        p = line.split()
        cams[int(p[0])] = Camera(int(p[0]), p[1], int(p[2]), int(p[3]), np.array([float(x) for x in p[4:]]))
    return cams


def _read_images_txt(path: Path) -> dict[int, Image]:
    imgs = {}
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if not ln.startswith("#")]
    for i in range(0, len(lines) - 1, 2):
        p = lines[i].split()
        if len(p) < 10:
            continue
        pts = lines[i + 1].split()
        ids = np.array([int(x) for x in pts[2::3]], np.int64) if pts else np.zeros(0, np.int64)
        imgs[int(p[0])] = Image(int(p[0]), " ".join(p[9:]), int(p[8]), np.array([float(x) for x in p[1:5]]), np.array([float(x) for x in p[5:8]]), ids)
    return imgs


def _read_points_txt(path: Path):
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        p = line.split()
        rows.append((float(p[1]), float(p[2]), float(p[3]), int(p[4]), int(p[5]), int(p[6]), float(p[7]), (len(p) - 8) // 2))
    if not rows:
        return np.zeros((0, 3)), np.zeros((0, 3), np.uint8), np.zeros(0), np.zeros(0, np.int32)
    a = np.array(rows)
    return a[:, :3], a[:, 3:6].astype(np.uint8), a[:, 6], a[:, 7].astype(np.int32)


def read_model(path: str | Path) -> SparseModel:
    """Read a COLMAP sparse model directory (e.g. `sparse/0`)."""
    path = Path(path)
    if (path / "images.bin").exists():
        cams = _read_cameras_bin(path / "cameras.bin")
        imgs = _read_images_bin(path / "images.bin")
        xyz, rgb, err, tl = _read_points_bin(path / "points3D.bin")
    elif (path / "images.txt").exists():
        cams = _read_cameras_txt(path / "cameras.txt")
        imgs = _read_images_txt(path / "images.txt")
        xyz, rgb, err, tl = _read_points_txt(path / "points3D.txt")
    else:
        raise FileNotFoundError(f"No COLMAP model in {path}")
    return SparseModel(cams, imgs, xyz, rgb, err, tl)


def find_model_dir(root: str | Path) -> Path:
    """Locate the largest sparse model under a dataset/workspace root."""
    root = Path(root)
    candidates = [p.parent for p in root.rglob("images.bin")] + [p.parent for p in root.rglob("images.txt")]
    if not candidates:
        raise FileNotFoundError(f"No COLMAP sparse model found under {root}")
    return max(candidates, key=lambda p: sum(f.stat().st_size for f in p.iterdir() if f.is_file()))
