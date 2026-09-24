"""SPZ v2 encoder (Niantic's compressed Gaussian splat format) in numpy.

Written in-house because current converters emit SPZ v4, which Spark 2.2
cannot read. Layout (all gzip-compressed):

  header   magic 'NGSP' (u32 0x5053474e), version u32 = 2, count u32,
           sh_degree u8, fractional_bits u8, flags u8, reserved u8
  position count × 3 × int24 fixed point (value · 2^fractional_bits)
  alpha    count × u8  sigmoid(opacity) · 255
  color    count × 3 × u8  (f_dc · 0.15 + 0.5) · 255
  scale    count × 3 × u8  (log_scale + 10) · 16
  rotation count × 3 × u8  xyz of the unit quaternion with w ≥ 0, (q · 127.5 + 127.5)
  sh       count × coeffs × 3 × u8, coefficient-major with RGB interleaved,
           quantised to 5 bits (degree 1) / 4 bits (degree 2–3) around 128
"""
from __future__ import annotations

import gzip
import io
import struct
from pathlib import Path

import numpy as np

from .splat_io import read_ply

MAGIC = 0x5053474E
COLOR_SCALE = 0.15


def _u8(x: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(x), 0, 255).astype(np.uint8)


def _quantize_sh(x: np.ndarray, bucket: int) -> np.ndarray:
    q = np.rint(x * 128.0) + 128.0
    q = np.floor((q + bucket / 2) / bucket) * bucket
    return np.clip(q, 0, 255).astype(np.uint8)


def encode(fields: dict[str, np.ndarray], fractional_bits: int = 12, max_sh: int = 3, antialiased: bool = False) -> tuple[bytes, dict]:
    n0 = len(fields["x"])
    pos = np.stack([fields["x"], fields["y"], fields["z"]], 1).astype(np.float64)
    scl = np.stack([fields[f"scale_{i}"] for i in range(3)], 1).astype(np.float64)
    rot = np.stack([fields[f"rot_{i}"] for i in range(4)], 1).astype(np.float64)  # w x y z
    dc = np.stack([fields[f"f_dc_{i}"] for i in range(3)], 1).astype(np.float64)
    op = fields["opacity"].astype(np.float64)

    # drop invalid splats (NaN / Inf / zero quaternion)
    qn = np.linalg.norm(rot, axis=1)
    ok = np.isfinite(pos).all(1) & np.isfinite(scl).all(1) & np.isfinite(dc).all(1) & np.isfinite(op) & (qn > 1e-8)
    rest_names = sorted((k for k in fields if k.startswith("f_rest_")), key=lambda k: int(k.split("_")[-1]))
    n_rest = len(rest_names) // 3
    deg_available = {0: 0, 3: 1, 8: 2, 15: 3}.get(n_rest, 0)
    deg = min(deg_available, max_sh)
    if deg:
        rest = np.stack([fields[k] for k in rest_names], 1).astype(np.float64)  # channel-major: R coeffs, G, B
        ok &= np.isfinite(rest).all(1)
    pos, scl, rot, dc, op, qn = pos[ok], scl[ok], rot[ok], dc[ok], op[ok], qn[ok]
    n = len(pos)

    lim = (1 << 23) - 1
    fixed = np.clip(np.rint(pos * (1 << fractional_bits)), -lim - 1, lim).astype(np.int32)
    b = fixed.astype("<i4").view(np.uint8).reshape(n, 3, 4)[:, :, :3]  # little-endian low 3 bytes
    positions = np.ascontiguousarray(b).reshape(-1)

    alphas = _u8(1.0 / (1.0 + np.exp(-op)) * 255.0)
    colors = _u8((dc * COLOR_SCALE + 0.5) * 255.0).reshape(-1)
    scales = _u8((scl + 10.0) * 16.0).reshape(-1)
    q = rot / qn[:, None]
    q[q[:, 0] < 0] *= -1  # w >= 0
    rotations = _u8(q[:, 1:] * 127.5 + 127.5).reshape(-1)

    parts = [positions, alphas, colors, scales, rotations]
    if deg:
        coeffs = (deg + 1) ** 2 - 1
        r = rest[ok].reshape(n, 3, n_rest)[:, :, :coeffs]  # (n, channel, coeff)
        r = np.transpose(r, (0, 2, 1))  # (n, coeff, channel)
        sh = np.empty_like(r, dtype=np.uint8)
        sh[:, :3] = _quantize_sh(r[:, :3], 8)  # degree 1: 5 bits
        if coeffs > 3:
            sh[:, 3:] = _quantize_sh(r[:, 3:], 16)  # degree 2–3: 4 bits
        parts.append(sh.reshape(-1))

    header = struct.pack("<IIIBBBB", MAGIC, 2, n, deg, fractional_bits, 1 if antialiased else 0, 0)
    raw = io.BytesIO()
    raw.write(header)
    for p in parts:
        raw.write(p.tobytes())
    data = gzip.compress(raw.getvalue(), compresslevel=6)
    return data, {"splats": n, "dropped_invalid": int(n0 - n), "sh_degree": deg, "bytes": len(data)}


def ply_to_spz(src: str | Path, dst: str | Path, **kw) -> dict:
    data, info = encode(read_ply(src), **kw)
    Path(dst).write_bytes(data)
    return info
