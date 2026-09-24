import numpy as np

from splattour.colmap_io import qvec_to_rotmat, rotmat_to_qvec


def test_roundtrip():
    rng = np.random.default_rng(0)
    for _ in range(200):
        q = rng.normal(size=4)
        q /= np.linalg.norm(q)
        R = qvec_to_rotmat(q)
        assert np.allclose(qvec_to_rotmat(rotmat_to_qvec(R)), R, atol=1e-9)


if __name__ == "__main__":
    test_roundtrip()
    print("ok")
