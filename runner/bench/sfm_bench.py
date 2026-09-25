# One SfM variant on the workbench: python sfm_bench.py <variant> <camera_model> <mapper: incremental|global|both> <match: seq|exh>
import pycolmap, sys, os, time, json, shutil
from pathlib import Path
v, cam, mapper, match = sys.argv[1:5]
IMG = Path(os.environ.get("IMG", "/workspace/img_sfm"))
W = Path("/workspace/sfm") / v; W.mkdir(parents=True, exist_ok=True)
db = W / "database.db"
log = {"variant": v, "camera_model": cam, "mapper": mapper, "match": match}
t = time.time()
shared = Path("/workspace/sfm") / f"_db_{cam}_{match}.db"
if shared.exists():
    shutil.copy(shared, db)
else:
    if db.exists(): db.unlink()
    reader = pycolmap.ImageReaderOptions(); reader.camera_model = cam
    fx = os.environ.get("FOCAL")
    if fx: reader.camera_params = fx
    ext = pycolmap.FeatureExtractionOptions(); ext.max_image_size = 1920
    ext.sift.max_num_features = 12000
    pycolmap.extract_features(db, IMG, camera_mode=pycolmap.CameraMode.SINGLE, reader_options=reader, extraction_options=ext, device=pycolmap.Device.cuda)
    log["extract_s"] = round(time.time() - t); t = time.time()
    if match == "seq":
        po = pycolmap.SequentialPairingOptions()
        po.overlap, po.quadratic_overlap, po.loop_detection = 30, True, True
        po.loop_detection_period, po.loop_detection_num_images = 2, 60
        po.vocab_tree_path = "/workspace/vocab.bin"
        po.num_threads = int(os.environ.get("PAIR_THREADS", "8"))
        pycolmap.match_sequential(db, pairing_options=po, device=pycolmap.Device.cuda)
    else:
        pycolmap.match_exhaustive(db, device=pycolmap.Device.cuda)
    log["match_s"] = round(time.time() - t); t = time.time()
    shutil.copy(db, shared)
def summarize(recs, tag):
    out = []
    for k, r in recs.items():
        out.append({"id": k, "reg": r.num_reg_images(), "points": r.num_points3D(), "reproj": round(r.compute_mean_reprojection_error(), 3),
                    "cam": [round(x, 4) for x in list(r.cameras.values())[0].params]})
    out.sort(key=lambda d: -d["reg"])
    log[tag] = out
for mp in (["incremental", "global"] if mapper == "both" else [mapper]):
    t = time.time()
    sp = W / f"sparse_{mp}"; shutil.rmtree(sp, ignore_errors=True); sp.mkdir()
    try:
        if mp == "incremental":
            opt = pycolmap.IncrementalPipelineOptions()
            opt.multiple_models = True
            if os.environ.get("BA_GPU"): opt.ba_use_gpu = True
            recs = pycolmap.incremental_mapping(db, IMG, sp, options=opt)
        else:
            recs = pycolmap.global_mapping(db, IMG, sp)
        summarize(recs, mp)
        for k, r in recs.items():
            (sp / str(k)).mkdir(exist_ok=True); r.write(sp / str(k))
    except Exception as e:
        log[mp] = f"ERROR {e}"
    log[mp + "_s"] = round(time.time() - t)
    (W / "summary.json").write_text(json.dumps(log, indent=1))
print(json.dumps(log))
