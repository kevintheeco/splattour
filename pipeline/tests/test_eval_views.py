"""The viewer-frame pose from eval_views must project COLMAP points to the
same pixels as the original COLMAP pose (so held-out renders line up)."""
from pathlib import Path

import numpy as np

from splattour.colmap_io import qvec_to_rotmat, read_model
from splattour.eval_views import quat_xyzw_to_mat, views

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "data/jobs/playroom/sfm/dense/sparse/0"


def test_pose_matches_colmap_projection():
    import json
    tour = json.loads((ROOT / "scenes/playroom/tour.json").read_text(encoding="utf-8"))
    t = tour["splatTransform"]
    P, Rq, s = np.array(t["position"]), quat_xyzw_to_mat(t["quaternion"]), float(t["scale"])
    m = read_model(MODEL)
    by_name = {im.name: im for im in m.images.values()}
    pts = m.xyz[:: max(1, len(m.xyz) // 400)]
    worst = 0.0
    for v in views("playroom", MODEL, every=8)[:8]:
        im = by_name[v["name"]]
        cam = m.cameras[im.camera_id]
        fx, fy, cx, cy = cam.params[:4]
        # COLMAP projection
        pc = (qvec_to_rotmat(im.qvec) @ pts.T).T + im.tvec
        ok = pc[:, 2] > 0.1
        uv0 = np.c_[fx * pc[ok, 0] / pc[ok, 2] + cx, fy * pc[ok, 1] / pc[ok, 2] + cy]
        # viewer projection: world = P + s R p ; three.js camera looks down -Z, +Y up
        pw = P + s * (Rq @ pts[ok].T).T
        Rc = quat_xyzw_to_mat(v["quaternion"])
        pcam = (Rc.T @ (pw - np.array(v["position"])).T).T
        f = (v["h"] / 2) / np.tan(np.radians(v["fovY"]) / 2)
        uv1 = np.c_[f * pcam[:, 0] / -pcam[:, 2] + v["w"] / 2, -f * pcam[:, 1] / -pcam[:, 2] + v["h"] / 2]
        inside = (uv0[:, 0] > 0) & (uv0[:, 0] < v["w"]) & (uv0[:, 1] > 0) & (uv0[:, 1] < v["h"])
        worst = max(worst, float(np.abs(uv0[inside] - uv1[inside]).max()))
    # principal point is assumed centred by the viewer; undistorted COLMAP keeps it at w/2,h/2 ±1px
    assert worst < 1.5, worst


if __name__ == "__main__":
    test_pose_matches_colmap_projection()
    print("ok")
