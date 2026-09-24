"""Read/write standard 3DGS PLY files (the INRIA layout used by Brush,
gsplat, nerfstudio and most viewers) with plain numpy."""
from __future__ import annotations

from pathlib import Path

import numpy as np

_TYPES = {"float": "f4", "float32": "f4", "double": "f8", "uchar": "u1", "uint8": "u1", "int": "i4", "uint": "u4", "short": "i2", "ushort": "u2"}


def read_ply(path: str | Path) -> dict[str, np.ndarray]:
    path = Path(path)
    with open(path, "rb") as f:
        header = []
        while True:
            line = f.readline().decode("ascii").strip()
            header.append(line)
            if line == "end_header":
                break
        if "format binary_little_endian 1.0" not in header:
            raise ValueError(f"{path}: only binary little-endian PLY is supported")
        count = 0
        props = []
        in_vertex = False
        for line in header:
            p = line.split()
            if p[:2] == ["element", "vertex"]:
                count = int(p[2])
                in_vertex = True
            elif p and p[0] == "element":
                in_vertex = False
            elif in_vertex and p and p[0] == "property":
                props.append((p[2], "<" + _TYPES[p[1]]))
        data = np.frombuffer(f.read(count * np.dtype(props).itemsize), dtype=np.dtype(props), count=count)
    return {name: data[name] for name, _ in props}


def write_ply(path: str | Path, fields: dict[str, np.ndarray]) -> None:
    names = list(fields)
    n = len(fields[names[0]])
    arr = np.empty(n, dtype=[(k, "<f4") for k in names])
    for k in names:
        arr[k] = fields[k]
    header = "ply\nformat binary_little_endian 1.0\n" f"element vertex {n}\n" + "".join(f"property float {k}\n" for k in names) + "end_header\n"
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(arr.tobytes())


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def splat_centers(fields: dict[str, np.ndarray], min_opacity: float = 0.0):
    """Return (xyz, opacity, max_scale) for splats above `min_opacity`."""
    xyz = np.stack([fields["x"], fields["y"], fields["z"]], 1).astype(np.float64)
    op = sigmoid(fields["opacity"].astype(np.float64)) if "opacity" in fields else np.ones(len(xyz))
    if "scale_0" in fields:
        sc = np.exp(np.stack([fields["scale_0"], fields["scale_1"], fields["scale_2"]], 1).astype(np.float64)).max(1)
    else:
        sc = np.zeros(len(xyz))
    keep = op >= min_opacity
    return xyz[keep], op[keep], sc[keep]


def splat_footprints(fields: dict[str, np.ndarray], voxel: float, min_opacity: float = 0.3, sigmas: float = 1.0, max_steps: int = 6):
    """Sample points over each splat's visible disc (its two largest axes,
    out to `sigmas` std devs) so large, flat splats register as surfaces.
    Optimisers cover plain walls with a few big Gaussians; counting centres
    alone leaves those walls full of holes. Returns (points, weights)."""
    xyz, op, _ = splat_centers(fields, min_opacity)
    keep = (sigmoid(fields["opacity"].astype(np.float64)) >= min_opacity) if "opacity" in fields else np.ones(len(fields["x"]), bool)
    if "scale_0" not in fields or "rot_0" not in fields:
        return xyz, op
    sc = np.exp(np.stack([fields[f"scale_{i}"] for i in range(3)], 1).astype(np.float64))[keep]
    q = np.stack([fields[f"rot_{i}"] for i in range(4)], 1).astype(np.float64)[keep]
    q /= np.linalg.norm(q, axis=1, keepdims=True) + 1e-12
    w, x, y, z = q.T
    R = np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], 1),
        np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], 1),
        np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], 1),
    ], 1)  # (N,3,3), columns = local axes
    fin = np.all(np.isfinite(sc), 1) & np.all(np.isfinite(q), 1) & np.all(np.isfinite(xyz), 1)
    xyz, op, sc, q, R = xyz[fin], op[fin], sc[fin], q[fin], R[fin]
    order = np.argsort(-sc, 1)
    big = sc[np.arange(len(sc)), order[:, 0]] * sigmas > 0.75 * voxel
    pts, wts = [xyz], [op]
    # samples per half-axis ~ one per voxel, so memory scales with the area
    # actually covered, not with a fixed grid per splat
    steps = np.minimum(max_steps, np.ceil(sc[np.arange(len(sc)), order[:, 0]] * sigmas / voxel)).astype(int)
    for k in range(1, max_steps + 1):
        idx = np.where(big & (steps == k))[0]
        if not len(idx):
            continue
        a0 = R[idx, :, order[idx, 0]] * (sc[idx, order[idx, 0]] * sigmas)[:, None]
        a1 = R[idx, :, order[idx, 1]] * (sc[idx, order[idx, 1]] * sigmas)[:, None]
        g = np.linspace(-1, 1, 2 * k + 1)
        for u in g:
            for v in g:
                if (u == 0 and v == 0) or u * u + v * v > 1:
                    continue
                pts.append(xyz[idx] + u * a0 + v * a1)
                wts.append(op[idx])
    return np.concatenate(pts), np.concatenate(wts)
