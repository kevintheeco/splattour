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
