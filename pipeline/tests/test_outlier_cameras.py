"""drop_outlier_cameras removes isolated mis-registered views and keeps a
normal walkthrough intact (GLOMAP throws a few views kilometres away)."""
import numpy as np

from splattour.colmap_io import Image, SparseModel


def _model(centers):
    ims = {}
    for i, c in enumerate(centers):
        # identity rotation: centre = -tvec
        ims[i + 1] = Image(id=i + 1, qvec=np.array([1.0, 0, 0, 0]), tvec=-np.asarray(c, float), camera_id=1, name=f"{i:04d}.jpg")
    xyz = np.array([[0, 0, 0], [1, 1, 1], [5e4, 0, 0]], float)
    return SparseModel(cameras={}, images=ims, xyz=xyz, rgb=np.zeros((3, 3), np.uint8), error=np.zeros(3), track_len=np.full(3, 3))


def test_walkthrough_kept_outliers_dropped():
    rng = np.random.default_rng(0)
    path = np.c_[np.linspace(0, 6, 60), np.zeros(60), np.sin(np.linspace(0, 3, 60))] + rng.normal(0, 0.05, (60, 3))
    far = np.array([[3e4, 10, -2e4], [-5e4, 3, 1e4], [120.0, 0, 0]])
    m = _model(np.r_[path, far])
    dropped = m.drop_outlier_cameras()
    assert sorted(dropped) == ["0060.jpg", "0061.jpg", "0062.jpg"], dropped
    assert len(m.images) == 60
    assert len(m.xyz) == 2  # the far point went with them


def test_nothing_dropped_on_clean_path():
    path = np.c_[np.linspace(0, 10, 40), np.zeros(40), np.zeros(40)]
    m = _model(path)
    assert m.drop_outlier_cameras() == []


if __name__ == "__main__":
    test_walkthrough_kept_outliers_dropped()
    test_nothing_dropped_on_clean_path()
    print("ok")
