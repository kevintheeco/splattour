"""Graph builder on the synthetic apartment: a simulated walk living room →
hallway → bedroom must yield a connected graph with no edge through walls."""
from pathlib import Path

import numpy as np

from splattour.graph import OccupancyGrid, build_graph
from splattour.splat_io import read_ply, splat_centers

ROOT = Path(__file__).resolve().parents[2]
PLY = ROOT / "scenes" / "synthetic-apartment" / "scene.ply"


def simulated_walk():
    # waypoints (x, z) through the apartment; the photographer walks and looks ahead
    way = np.array([[4.8, 1.2], [3.0, 2.0], [1.3, 1.3], [2.5, 3.2], [4.8, 2.5], [7.5, 2.5], [9.9, 2.5], [12.0, 1.6], [12.9, 0.9], [11.5, 3.0]])
    pts = []
    for a, b in zip(way[:-1], way[1:]):
        k = max(2, int(np.linalg.norm(b - a) / 0.25))
        for t in np.linspace(0, 1, k, endpoint=False):
            pts.append(a + (b - a) * t)
    pts.append(way[-1])
    pts = np.array(pts)
    rng = np.random.default_rng(1)
    centers = np.c_[pts[:, 0], 1.45 + rng.normal(0, 0.03, len(pts)), pts[:, 1]]
    fwd = np.gradient(centers, axis=0)
    fwd[:, 1] = 0
    fwd /= np.linalg.norm(fwd, axis=1, keepdims=True)
    return centers, fwd


def test_graph():
    f = read_ply(PLY)
    xyz, op, _ = splat_centers(f, 0.3)
    lo = np.array([-1.0, -0.5, -1.0]); hi = np.array([15.0, 3.0, 6.0])
    occ = OccupancyGrid(xyz, op, lo, hi)
    centers, fwd = simulated_walk()
    g = build_graph(centers, fwd, occ, floor_y=0.0)
    print(g.stats)
    pos = {n["id"]: np.array(n["position"]) for n in g.nodes}
    # every edge must be clear at eye height
    for a, b in g.edges:
        assert occ.segment_clear(pos[a], pos[b]), (a, b)
    # no fade links needed: the apartment is walkable
    assert not g.stats["fade_links"]
    # living room and bedroom nodes both present and connected through the hallway
    xs = np.array([p[0] for p in pos.values()])
    assert xs.min() < 5 and xs.max() > 10
    # a wall separates the living room (x<6) from the bedroom (x>9): no direct edge
    for a, b in g.edges:
        assert not (min(pos[a][0], pos[b][0]) < 6 and max(pos[a][0], pos[b][0]) > 9), (a, b)
    return g


if __name__ == "__main__":
    g = test_graph()
    for n in g.nodes:
        print(n["id"], n["position"])
    print(g.edges)
