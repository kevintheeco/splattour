"""Automatic light-source detection in a trained splat.

Lamps photograph as over-exposed, so their Gaussians have near-white base
colour. We keep very bright splats, bin them into a coarse voxel grid,
flood-fill connected voxels into clusters and keep clusters that are
compact (a bulb, a chandelier, a pendant) while rejecting large flat bright
regions (windows, sunlit walls), which the ambient/day-night control already
handles.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

C0 = 0.28209479177387814


def _shell_occupancy(occ, c: np.ndarray, radii=(0.35, 0.5, 0.7), n_dirs: int = 160) -> float:
    """Fraction of occupied samples on spheres around `c`. A lamp hangs or
    stands in free space (low); a bright patch on a wall or window has the
    wall filling half its surroundings (high)."""
    i = np.arange(n_dirs) + 0.5
    phi = np.arccos(1 - 2 * i / n_dirs)
    th = np.pi * (1 + 5 ** 0.5) * i
    d = np.stack([np.cos(th) * np.sin(phi), np.cos(phi), np.sin(th) * np.sin(phi)], 1)
    pts = np.concatenate([c + r * d for r in radii])
    return float(occ.occupied(pts).mean())


def detect_lights(fields: dict, to_world, floor_y: float = 0.0, max_lights: int = 12, voxel: float = 0.12,
                  lum_thresh: float = 0.92, min_splats: int = 60, occ=None, max_shell: float = 0.22) -> list[dict]:
    dc = np.stack([fields[f"f_dc_{i}"] for i in range(3)], 1)
    rgb = np.clip(dc * C0 + 0.5, 0, 1.5)
    op = 1 / (1 + np.exp(-fields["opacity"]))
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    # bright, fairly opaque, and not strongly coloured (lamps clip to white/warm)
    sat = rgb.max(1) - rgb.min(1)
    keep = (lum > lum_thresh) & (op > 0.5) & (sat < 0.35)
    if keep.sum() < min_splats:
        return []
    xyz = to_world(np.stack([fields["x"][keep], fields["y"][keep], fields["z"][keep]], 1).astype(np.float64))
    lo = xyz.min(0)
    ijk = np.floor((xyz - lo) / voxel).astype(int)
    shape = ijk.max(0) + 1
    if np.prod(shape) > 60_000_000:  # absurd extent: distant sky etc.
        return []
    grid = np.zeros(shape, np.int32)
    np.add.at(grid, tuple(ijk.T), 1)
    labels, n = ndimage.label(grid >= 2, structure=np.ones((3, 3, 3)))
    if n == 0:
        return []
    lab_pts = labels[tuple(ijk.T)]
    out = []
    for k in range(1, n + 1):
        m = lab_pts == k
        cnt = int(m.sum())
        if cnt < min_splats:
            continue
        p = xyz[m]
        ext = np.percentile(p, 95, 0) - np.percentile(p, 5, 0)
        dims = np.sort(ext)[::-1]
        # windows / bright walls: large, flat (one thin dimension, two big ones)
        if dims[0] > 1.6 or (dims[1] > 0.9 and dims[2] < 0.15):
            continue
        # light leaks (shutter gaps, door edges) are long thin streaks
        if dims[0] > 3.0 * max(dims[1], 0.03):
            continue
        # daylight patches sit on walls: the cluster hugs one plane
        if dims[2] < 0.06 and dims[1] > 0.25:
            continue
        c = np.median(p, 0)
        h = c[1] - floor_y
        if h < 0.3:  # reflections on the floor
            continue
        # Low objects must be genuinely clipped and small to count as a lamp:
        # white radiators, skirting and fireplaces are bright but not emitting.
        core = lum[keep][m]
        if h < 1.5 and (np.percentile(core, 50) < 0.985 or dims[0] > 0.7):
            continue
        shell = _shell_occupancy(occ, c) if occ is not None else 0.0
        if shell > max_shell:
            continue
        warmth = float(rgb[keep][m][:, 0].mean() - rgb[keep][m][:, 2].mean())
        kelvin = int(np.clip(3400 - warmth * 4000, 2400, 5000))
        # reach grows with cluster size (a chandelier lights a room, a bulb a corner)
        radius = float(np.clip(2.2 + 1.4 * np.log10(cnt / min_splats + 1) + dims[0], 2.2, 5.5))
        out.append({"position": [round(float(x), 3) for x in c], "radius": round(radius, 2), "emitter": round(float(max(0.2, dims[0] * 0.6)), 2),
                    "kelvin": kelvin, "score": cnt, "shell": round(shell, 3), "kind": "ceiling" if h > 1.9 else "lamp"})
    out.sort(key=lambda l: -l["score"])
    # merge detections closer than 0.8 m (one chandelier, several bulbs)
    merged = []
    for l in out:
        if all(np.linalg.norm(np.subtract(l["position"], o["position"])) > 0.8 for o in merged):
            merged.append(l)
    merged = merged[:max_lights]
    for i, l in enumerate(merged):
        l["id"] = f"light{i}"
        l["name"] = ("천장등" if l["kind"] == "ceiling" else "스탠드") + f" {i + 1}"
        l["capturedOn"] = True
    return merged
