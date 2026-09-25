"""Max-quality path (maxq.py): the SfM model solved on small photos, rescaled to the large training
photos by sfm.hires_dataset, must describe the same cameras pixel for pixel.

Setup: 10 Dr Johnson views, their camera given lens distortion (OPENCV) so undistortion does
real work; "small" photos = the 1332 px originals, "large" = the same ×2. Both are undistorted
(small: with the original model, large: with the rescaled one) and the large result, sampled
through the small undistorted camera, must reproduce the small result."""
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "data/samples/deepblending_drjohnson/colmap"

pycolmap = pytest.importorskip("pycolmap")
cv2 = pytest.importorskip("cv2")


def _psnr(a, b):
    return 10 * np.log10(255 ** 2 / np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))


@pytest.mark.skipif(not (SAMPLE / "sparse/0/images.bin").exists(), reason="Dr Johnson sample not downloaded")
def test_hires_model_matches_small_model(tmp_path):
    from PIL import Image

    from splattour.sfm import _hires_dataset

    rec = pycolmap.Reconstruction(str(SAMPLE / "sparse/0"))
    keep = sorted(rec.images.values(), key=lambda im: im.name)[40:50]
    keep_ids = {im.image_id for im in keep}
    for iid, im in list(rec.images.items()):
        if iid not in keep_ids:
            rec.deregister_frame(im.frame_id)
    cam = rec.cameras[keep[0].camera_id]
    fx, fy, cx, cy = cam.params
    cam.model = pycolmap.CameraModelId.OPENCV
    cam.params = [fx, fy, cx, cy, -0.06, 0.015, 0.0008, -0.0005]
    work = tmp_path / "sfm"
    (work / "sparse" / "best").mkdir(parents=True)
    rec.write(str(work / "sparse" / "best"))
    lo, hi = tmp_path / "images", tmp_path / "images_hi"
    lo.mkdir()
    hi.mkdir()
    for im in keep:
        src = Image.open(SAMPLE / "images" / im.name).convert("RGB")
        src.save(lo / im.name, quality=95)
        src.resize((src.width * 2, src.height * 2), Image.LANCZOS).save(hi / im.name, quality=95)

    pycolmap.undistort_images(str(tmp_path / "dense"), str(work / "sparse" / "best"), str(lo), output_type="COLMAP")
    info = _hires_dataset(work, hi, tmp_path / "dense_hi")
    assert info["images"] == 10 and info["scales"][1]["sx"] == 2.0

    small = pycolmap.Reconstruction(str(tmp_path / "dense" / "sparse"))
    big = pycolmap.Reconstruction(str(tmp_path / "dense_hi" / "sparse" / "0"))
    cl, ch = small.cameras[1], big.cameras[1]
    assert ch.model_name == "PINHOLE"
    # the large images and their camera agree (what gsplat reads at data_factor 1)
    for im in big.images.values():
        assert Image.open(tmp_path / "dense_hi" / "images" / im.name).size == (ch.width, ch.height)
    np.testing.assert_allclose(np.array(ch.params) / np.array(cl.params), 2.0, rtol=2e-3)

    # observations were rescaled with the camera: reprojection error doubles in pixels
    def median_err(r):
        e = []
        for im in r.images.values():
            c = r.cameras[im.camera_id]
            for p in im.points2D:
                if p.has_point3D():
                    uv = c.img_from_cam(im.cam_from_world() * r.points3D[p.point3D_id].xyz)
                    e.append(np.linalg.norm(uv[:2] - p.xy))
        return np.median(e)
    assert abs(median_err(big) / median_err(small) - 2.0) < 0.05

    # photometric: large undistorted photo, sampled through the small camera, equals the small one
    u, v = np.meshgrid(np.arange(cl.width) + 0.5, np.arange(cl.height) + 0.5)  # COLMAP pixel centres
    x, y = (u - cl.params[2]) / cl.params[0], (v - cl.params[3]) / cl.params[1]
    for im in list(small.images.values())[:4]:
        a = cv2.imread(str(tmp_path / "dense" / "images" / im.name))
        b = cv2.GaussianBlur(cv2.imread(str(tmp_path / "dense_hi" / "images" / im.name)), (0, 0), 1.0)

        def sample(dx=0.0):
            r = cv2.remap(b, (ch.params[0] * x + ch.params[2] - 0.5 + dx).astype(np.float32),
                          (ch.params[1] * y + ch.params[3] - 0.5).astype(np.float32), cv2.INTER_LINEAR)
            return _psnr(a[12:-12, 12:-12], r[12:-12, 12:-12])
        good, shifted = sample(), sample(2.0)  # 2 large px = 1 small px off
        assert good > 38, good
        assert good - shifted > 5, (good, shifted)
