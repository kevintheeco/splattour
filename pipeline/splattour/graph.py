"""Automatic tour-graph construction (RQ2).

Given aligned camera poses (the path the photographer actually walked) and an
occupancy grid of the reconstruction, choose viewpoint nodes and connect the
ones a visitor could plausibly walk between.

Nodes
  Cameras are candidates because the radiance field is most faithful near
  training views. Candidates are scored by local view support (how many other
  cameras see the same area from nearby) and picked greedily with a minimum
  spacing, in capture order, so nodes follow the walked path evenly.

Edges
  1. Walk edges: consecutive nodes along the capture trajectory — physically
     traversed, so always valid.
  2. Visibility edges: node pairs within `max_edge` metres whose straight
     segment is free at eye height *and* at knee height (so flights never
     clip furniture or walls) in the occupancy grid.
  3. Pruning: a relative-neighbourhood test removes an edge a–c when some b
     is closer to both, which removes near-duplicate "skip" edges and keeps the
     hotspot count per view small and legible.
  4. Connectivity: components are bridged with the shortest clear links (or
     marked for a fade transition when none exists).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


class OccupancyGrid:
    def __init__(self, points: np.ndarray, weights: np.ndarray, lo: np.ndarray, hi: np.ndarray, voxel: float = 0.08, threshold: float = 0.6):
        self.voxel = voxel
        self.lo = lo
        self.shape = np.maximum(1, np.ceil((hi - lo) / voxel).astype(int))
        acc = np.zeros(self.shape, np.float32)
        ijk = np.floor((points - lo) / voxel).astype(int)
        ok = np.all((ijk >= 0) & (ijk < self.shape), 1)
        np.add.at(acc, tuple(ijk[ok].T), weights[ok])
        solid = acc >= threshold
        # one-voxel dilation along each axis so sparse surfaces are watertight
        d = solid.copy()
        for ax in range(3):
            d |= np.roll(solid, 1, ax) | np.roll(solid, -1, ax)
        self.solid = d

    def occupied(self, p: np.ndarray) -> np.ndarray:
        ijk = np.floor((np.atleast_2d(p) - self.lo) / self.voxel).astype(int)
        ok = np.all((ijk >= 0) & (ijk < self.shape), 1)
        out = np.zeros(len(ijk), bool)
        out[ok] = self.solid[tuple(ijk[ok].T)]
        return out

    def segment_clear(self, a: np.ndarray, b: np.ndarray, end_skip: float = 0.3) -> bool:
        d = b - a
        L = float(np.linalg.norm(d))
        if L <= 2 * end_skip:
            return True
        ts = np.arange(end_skip, L - end_skip, self.voxel * 0.5)
        pts = a + np.outer(ts / L, d)
        return not self.occupied(pts).any()


@dataclass
class TourGraph:
    nodes: list[dict] = field(default_factory=list)
    edges: list[tuple[str, str]] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


def _view_support(centers: np.ndarray, forwards: np.ndarray, radius: float) -> np.ndarray:
    """Number of other cameras within `radius` whose view direction differs
    by < 90° — a proxy for how well-constrained the scene is around a pose."""
    d = np.linalg.norm(centers[:, None] - centers[None], axis=-1)
    cos = forwards @ forwards.T
    return ((d < radius) & (cos > 0)).sum(1) - 1


def build_graph(
    centers: np.ndarray,
    forwards: np.ndarray,
    occ: OccupancyGrid,
    floor_y: float = 0.0,
    eye_height: float | None = None,
    spacing: float = 1.3,
    max_edge: float = 4.0,
    knee: float = 0.55,
    names: list[str] | None = None,
) -> TourGraph:
    """centers/forwards: (N,3) aligned camera centres and view directions in
    capture order. Returns nodes with positions at a uniform eye height."""
    n = len(centers)
    if eye_height is None:
        eye_height = float(np.median(centers[:, 1] - floor_y))
    support = _view_support(centers, forwards, radius=spacing)
    # Discard cameras far off the floor band (e.g. held overhead) or poorly supported.
    h = centers[:, 1] - floor_y
    valid = (np.abs(h - eye_height) < 0.6) & (support >= 1)
    if valid.sum() == 0:
        valid[:] = True

    # Greedy spacing in capture order, but within each spacing window prefer
    # the best-supported camera.
    chosen: list[int] = []
    order = np.arange(n)
    for i in order:
        if not valid[i]:
            continue
        p = centers[i]
        if chosen:
            dists = np.linalg.norm(centers[chosen][:, [0, 2]] - p[[0, 2]], axis=1)
            j = int(np.argmin(dists))
            if dists[j] < spacing:
                # swap in if clearly better supported and still spaced from others
                k = chosen[j]
                others = [c for c in chosen if c != k]
                far = not others or np.min(np.linalg.norm(centers[others][:, [0, 2]] - p[[0, 2]], axis=1)) >= spacing
                if support[i] > support[k] * 1.25 and far:
                    chosen[j] = i
                continue
        chosen.append(i)
    # Coverage pass: trajectory ends and detours (room corners, the spot by
    # the desk) are often what visitors want to see; add any valid camera
    # that is far from every node, farthest first.
    while True:
        cand = np.where(valid)[0]
        dmin = np.min(np.linalg.norm(centers[cand][:, None, [0, 2]] - centers[chosen][None, :, [0, 2]], axis=-1), axis=1)
        k = int(np.argmax(dmin))
        if dmin[k] < spacing * 0.9:
            break
        chosen.append(int(cand[k]))
    chosen.sort()  # keep capture order so walk edges follow the path
    chosen_arr = np.array(chosen)

    # Node positions: camera xz at a common eye height (stable horizon for users).
    pos = centers[chosen_arr].copy()
    pos[:, 1] = floor_y + eye_height
    # If the eye-height point sits inside geometry (low ceiling, shelf), keep the camera height.
    inside = occ.occupied(pos)
    pos[inside] = centers[chosen_arr][inside]

    m = len(chosen_arr)
    ids = [f"n{i}" for i in range(m)]
    edges: set[tuple[int, int]] = set()

    # 1. walk edges: consecutive chosen cameras, if the walked sub-path is short
    for a in range(m - 1):
        seg = centers[chosen_arr[a] : chosen_arr[a + 1] + 1]
        walked = float(np.linalg.norm(np.diff(seg, axis=0), axis=1).sum()) if len(seg) > 1 else 0.0
        direct = float(np.linalg.norm(pos[a + 1] - pos[a]))
        if walked < max(2.5 * direct, direct + 2.0) and direct < max_edge * 1.5:
            edges.add((a, a + 1))

    # 2. visibility edges
    def clear(a: int, b: int) -> bool:
        pa, pb = pos[a], pos[b]
        ka = pa.copy(); ka[1] = floor_y + knee
        kb = pb.copy(); kb[1] = floor_y + knee
        return occ.segment_clear(pa, pb) and occ.segment_clear(ka, kb)

    D = np.linalg.norm(pos[:, None, [0, 2]] - pos[None, :, [0, 2]], axis=-1)
    for a in range(m):
        for b in range(a + 1, m):
            if D[a, b] <= max_edge and clear(a, b):
                edges.add((a, b))

    # 3. relative neighbourhood pruning (walk edges are kept)
    walk = {(a, a + 1) for a in range(m - 1)} & edges
    adj = {i: set() for i in range(m)}
    for a, b in edges:
        adj[a].add(b); adj[b].add(a)
    pruned = set()
    for a, b in edges:
        if (a, b) in walk:
            pruned.add((a, b)); continue
        dab = D[a, b]
        redundant = any(max(D[a, c], D[b, c]) < dab * 0.92 for c in adj[a] & adj[b])
        if not redundant:
            pruned.add((a, b))

    # 4. bridge disconnected components with the shortest clear link
    def components(E):
        parent = list(range(m))
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]; x = parent[x]
            return x
        for a, b in E:
            parent[find(a)] = find(b)
        return [find(i) for i in range(m)]

    fade_links = []
    comp = components(pruned)
    while len(set(comp)) > 1:
        best = None
        for a in range(m):
            for b in range(m):
                if comp[a] != comp[b] and (best is None or D[a, b] < best[0]):
                    best = (D[a, b], a, b)
        _, a, b = best
        if clear(a, b) and D[a, b] <= max_edge * 1.75:
            pruned.add((min(a, b), max(a, b)))
        else:
            fade_links.append((ids[a], ids[b]))
            pruned.add((min(a, b), max(a, b)))  # still connect; viewer fades if flagged
        comp = components(pruned)

    nodes = []
    for i, ci in enumerate(chosen_arr):
        f = forwards[ci]
        yaw = float(np.arctan2(-f[0], -f[2]))  # viewer convention: yaw 0 looks at -Z
        nodes.append({
            "id": ids[i],
            "name": names[i] if names and i < len(names) else f"시점 {i + 1}",
            "position": [round(float(x), 4) for x in pos[i]],
            "yaw": round(yaw, 4),
            "floorY": round(float(floor_y), 4),
            "camera": int(ci),
        })
    degree = np.zeros(m, int)
    for a, b in pruned:
        degree[a] += 1; degree[b] += 1
    g = TourGraph(nodes=nodes, edges=sorted((ids[a], ids[b]) for a, b in pruned))
    g.stats = {
        "cameras": int(n), "nodes": int(m), "edges": len(pruned), "walk_edges": len(walk),
        "fade_links": fade_links, "eye_height": eye_height,
        "mean_degree": float(degree.mean()) if m else 0.0,
    }
    return g
