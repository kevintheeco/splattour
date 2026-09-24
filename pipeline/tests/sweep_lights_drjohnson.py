import json, sys, tempfile, numpy as np, functools
from pathlib import Path
sys.path.insert(0, r"C:\Users\kevin\Desktop\주희\pipeline")
import splattour.build_tour as bt
from splattour.lights import detect_lights
from splattour.eval_views import quat_xyzw_to_mat
ROOT = Path(r"C:\Users\kevin\Desktop\주희")
def to_colmap(pts, tr):
    R = quat_xyzw_to_mat(tr["quaternion"]); P = np.array(tr["position"]); s = float(tr["scale"])
    return ((np.asarray(pts) - P) @ R) / s
old = json.loads((ROOT / "scenes/drjohnson/tour.json").read_text(encoding="utf-8"))
GT = to_colmap([l["position"] for l in old["lights"]], old["splatTransform"])
model = ROOT / "data/samples/deepblending_drjohnson/colmap/sparse/0"
variants = [dict(min_splats=40, max_shell=0.22), dict(min_splats=50, max_shell=0.22), dict(min_splats=30, max_shell=0.22), dict(min_splats=20, max_shell=0.22)]
for v in variants:
    bt.detect_lights = functools.partial(detect_lights, **v)
    res = []
    for scene in ["drjohnson", "drjohnson-hq"]:
        out = Path(tempfile.mkdtemp())
        bt.build_tour(model, ROOT / f"scenes/{scene}/scene.ply", out, title="t", copy_splat=False)
        t = json.loads((out / "tour.json").read_text(encoding="utf-8"))
        L = to_colmap([l["position"] for l in t["lights"]], t["splatTransform"]) if t["lights"] else np.zeros((0, 3))
        thr = 0.8 / float(t["splatTransform"]["scale"])
        d = np.linalg.norm(L[:, None] - GT[None], axis=2) if len(L) else np.zeros((0, 3))
        res.append(f"{scene}: {int((d.min(0) < thr).sum()) if len(L) else 0}/3 fp {int((d.min(1) >= thr).sum()) if len(L) else 0}")
    print(v, " | ".join(res), flush=True)
