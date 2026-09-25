# make_dataset.py <sparse_model_dir> <out_dir> [drop_list.txt]: undistort the native PNG frames with an SfM model
# (solved on .jpg SfM copies of the same frames, same pixel size) -> <out>/{images, sparse/0} for gsplat.
import pycolmap, sys, os, shutil, json
from pathlib import Path
src, out = Path(sys.argv[1]), Path(sys.argv[2])
drop = set(Path(sys.argv[3]).read_text().split()) if len(sys.argv) > 3 else set()
rec = pycolmap.Reconstruction(str(src))
for iid, im in list(rec.images.items()):
    if im.name in drop or im.name.replace(".jpg", ".png") in drop:
        rec.deregister_frame(im.frame_id)
for im in rec.images.values():
    im.name = im.name[:-4] + ".png"
tmp = out.parent / (out.name + "_distorted")
shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir(parents=True)
rec.write(str(tmp))
shutil.rmtree(out, ignore_errors=True)
opts = pycolmap.UndistortCameraOptions()
opts.max_image_size = -1
pycolmap.undistort_images(str(out), str(tmp), "/workspace/raw", output_type="COLMAP", undistort_options=opts)
s = out / "sparse"; (s / "0").mkdir(exist_ok=True)
for f in ("cameras.bin", "images.bin", "points3D.bin", "rigs.bin", "frames.bin"):
    if (s / f).exists(): os.replace(s / f, s / "0" / f)
und = pycolmap.Reconstruction(str(s / "0"))
print(json.dumps({"images": und.num_reg_images(), "points": und.num_points3D(),
                  "cameras": {int(k): [c.model.name, c.width, c.height] + [round(float(v), 2) for v in c.params] for k, c in und.cameras.items()}}))
