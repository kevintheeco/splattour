# Toolchain (local, Windows 11 / Intel Arc 130V, no CUDA)

Set up and verified 2026-09-24. Everything lives under `C:\Users\kevin\Desktop\주희`.
All commands below were actually run on this machine unless marked *(not run)*.

| Tool | Version | Executable |
|---|---|---|
| Brush (WebGPU/wgpu 3DGS trainer + viewer) | 0.3.0 (latest release, 2025-09-14) | `tools\brush\brush_app.exe` |
| COLMAP (no-CUDA build) | 4.2.0 (2026-08-31) | `tools\colmap\bin\colmap.exe` (GUI: `tools\colmap\COLMAP.bat`) |
| GLOMAP standalone (deprecated) | 1.2.0 | `tools\glomap\bin\glomap.exe` |
| uv | 0.12.18 | `tools\uv\uv.exe` |
| Python (uv-managed) | 3.12.14 | `tools\uv\python\...` ; venv `pipeline\.venv\Scripts\python.exe` |
| COLMAP panorama example | from tag 4.2.0 | `tools\colmap\examples\panorama_sfm.py` |

---

## 1. Brush

Download: `https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-x86_64-pc-windows-msvc.zip`
(SHA256 `b68e3e9c...cfcd6`, matched the published `.sha256`). Single exe, no install.
Note: `main` is still active (commits up to 2026-09-20) but no newer binary release exists; a newer build would need `cargo build --release` (Rust 1.88+).

Verified: `tools\brush\brush_app.exe --help` (exit 0, headless), `-V` -> `brush-cli 0.3.0`.

### GPU on Intel Arc: WORKS (Vulkan)
Log line from a real training run:
```
cubecl_wgpu::runtime] Using adapter AdapterInfo { name: "Intel(R) Arc(TM) 130V GPU (8GB)", ... device_type: IntegratedGpu, driver_info: "101.8626", backend: Vulkan }
```
`WGPU_BACKEND=dx12` is ignored by this build; it always picked Vulkan. That is fine.

### Train from a COLMAP folder and export .ply (verified)
The positional argument is a folder containing `images\` and `sparse\0\{cameras,images,points3D}.bin`.
```bash
# run from an output folder; RUST_LOG=info gives progress / eval logs
set RUST_LOG=info
tools\brush\brush_app.exe data\samples\deepblending_playroom\colmap ^
  --total-steps 30000 ^
  --max-resolution 1024 ^
  --max-splats 1500000 ^
  --eval-split-every 8 --eval-every 5000 ^
  --export-every 5000 --export-path out --export-name "scene_{iter}.ply"
```
Add `--with-viewer` to open the live UI while training.

Key flags (from `--help`):
- iterations: `--total-steps` (default 30000)
- splat cap: `--max-splats` (default 10,000,000). Densification: `--refine-every 200`, `--growth-grad-threshold 4e-5`, `--growth-select-fraction 0.1`, `--growth-stop-iter 15000`
- eval split: `--eval-split-every N` (every Nth image held out), `--eval-every`, `--eval-save-to-disk`
- data: `--max-resolution` (default 1920), `--max-frames`, `--subsample-frames`, `--subsample-points`
- model: `--sh-degree` (default 3)
- export: `--export-every`, `--export-path`, `--export-name` (`{iter}` placeholder)
- resume: `--start-iter`
- masks: a `masks\` folder next to `images\` (black = ignored), images with alpha are also respected.

Measured:
- playroom, 500 steps, `--max-resolution 640`: 15 s, eval PSNR 15.4 (just a smoke test), 42k splats, 10 MB ply.
- drjohnson 3000 steps @1024 / 1.5M cap: see "Timing" at the bottom.

Exported PLY is standard INRIA layout (x,y,z, nx..., f_dc_*, f_rest_*, opacity, scale_*, rot_*), header comments `Exported from Brush`, `Vertical axis: y`, `SH degree: 3`. Coordinates are the COLMAP world frame (no normalization).

### Gotchas (learned the hard way)
1. **Brush loads any `.ply` inside the dataset folder as the initial splats.** With the 3.2M-splat pretrained ply sitting next to `images/`, a run started from 3.18M splats and went ~1.5 s/step, using 7.2 GB shared GPU memory and leaving 0.2 GB free RAM. Keep plys OUT of the training folder (that is why samples use a `colmap\` subfolder).
2. It writes an autotune cache to `.\target\autotune\` in the current working directory. Run it from an output/scratch folder.
3. 16 GB RAM shared with the iGPU is the real limit. Use `--max-resolution 1024` (or lower) and `--max-splats 1-2M` on this laptop.

---

## 2. COLMAP 4.2.0 (no CUDA)

Download: `https://github.com/colmap/colmap/releases/download/4.2.0/colmap-x64-windows-nocuda.zip` -> `tools\colmap`.
Verified: `tools\colmap\bin\colmap.exe -h` prints `COLMAP 4.2.0 (Commit be5e291 on 2026-08-31 without GPU support)`.

### GLOMAP is merged into COLMAP
- COLMAP 4.0.0 (2026-03-14) "Integrated GLOMAP global SfM pipeline into COLMAP". The command is **`colmap global_mapper`**. The glomap repo README now says DEPRECATED.
- 4.2.0: global mapper reconstructs every connected component by default (`--GlobalMapper.multiple_models 1`, `--GlobalMapper.min_model_size 3`).
- Standalone GLOMAP 1.2.0 no-CUDA was still downloaded to `tools\glomap\bin\glomap.exe` (verified `-h`: commands `mapper`, `mapper_resume`, `rotation_averager`). Not needed; prefer `colmap global_mapper`.

### Verified end-to-end SfM (CPU, 40 playroom images, 51 s total)
```bash
C=tools\colmap\bin\colmap.exe
%C% feature_extractor --database_path db.db --image_path images ^
    --ImageReader.single_camera 1 --FeatureExtraction.use_gpu 0 --FeatureExtraction.max_image_size 1000
%C% sequential_matcher --database_path db.db --FeatureMatching.use_gpu 0     (exhaustive_matcher for unordered photos)
%C% global_mapper --database_path db.db --image_path images --output_path sparse
%C% model_analyzer --path sparse\0
```
Result: 40/40 images registered, 2903 points, 0.377 px mean reprojection error. Output `sparse\0` contains `cameras.bin images.bin points3D.bin rigs.bin frames.bin` (4.x adds rigs/frames).
Incremental alternative: `colmap mapper ...`. For Brush/3DGS training the images must be undistorted to PINHOLE: `colmap image_undistorter --image_path images --input_path sparse\0 --output_path undist` *(not run)*.
Other useful commands present: `rig_configurator` (`--rig_config_path rig.json`), `spatial_matcher`, `vocab_tree_matcher`, `hierarchical_mapper`, `pose_prior_mapper`, `model_aligner`, `model_orientation_aligner`, `view_graph_calibrator`.
Feature types: `--FeatureExtraction.type SIFT` (default) or ALIKED / LoMa (ONNX models auto-downloaded from GitHub on first use; CPU ONNX, will be slow).

### Rigs + 360 panoramas: supported, two ways
1. **Native equirectangular camera model** (added 4.1.0): camera model `EQUIRECTANGULAR` (params `w,h`, full 360x180 sphere). pycolmap confirms `CameraModelId.EQUIRECTANGULAR`. Changelog: "faster but less accurate than rendering perspective views".
2. **Panorama -> virtual perspective rig** (the recommended, more accurate path): `pycolmap.panorama` module + example script. It renders each equirect into several virtual pinhole cameras configured as one rig (fixed relative poses), runs matching + incremental or global mapping, and can convert the result back to equirectangular.
   ```bash
   pipeline\.venv\Scripts\python.exe tools\colmap\examples\panorama_sfm.py ^
     --input_image_path <folder_of_equirect_jpgs> --output_path <out> ^
     --matcher sequential --mapper global ^
     --pano_render_type perspective_overlapping --use_cpu
   ```
   Choices: `--matcher {sequential,exhaustive,vocabtree,spatial}`, `--mapper {incremental,global}`, `--pano_render_type {perspective_overlapping,perspective_non_overlapping,spherical}`. `--help` verified; not yet run on real 360 data (we have none yet). The perspective rig output (undistorted pinhole images + sparse model) is exactly what Brush/gsplat can train on.

---

## 3. Python pipeline env (uv)

uv: standalone zip `uv-x86_64-pc-windows-msvc.zip` -> `tools\uv\uv.exe` (not on PATH).
Python and cache are kept inside the project with env vars:
```bash
set UV_PYTHON_INSTALL_DIR=C:\Users\kevin\Desktop\주희\tools\uv\python
set UV_CACHE_DIR=C:\Users\kevin\Desktop\주희\tools\uv\cache
tools\uv\uv.exe python install 3.12
tools\uv\uv.exe venv --python 3.12 pipeline\.venv
tools\uv\uv.exe pip install --python pipeline\.venv\Scripts\python.exe ^
  numpy opencv-python-headless plyfile pillow scipy tqdm fastapi uvicorn python-multipart pycolmap
```
(`uv python install` also drops a `python3.12.exe` shim into `%USERPROFILE%\.local\bin`; it was deleted to keep changes inside the project. Use `--no-bin` next time.)

Installed (all imported OK):
numpy 2.5.3, opencv-python-headless 5.0.0.93, plyfile 1.1.5, pillow 12.3.0, scipy 1.18.1, tqdm 4.70.1, fastapi 0.141.1, uvicorn 0.53.0, python-multipart 0.0.32, **pycolmap 4.2.0** (win wheel exists; CPU only, `pycolmap.has_cuda == False`), plus pydantic 2.13.5, starlette 1.7.0.

Use: `pipeline\.venv\Scripts\python.exe ...` (or `pipeline\.venv\Scripts\activate`).

---

## 4. Sample data: Deep Blending (from the official 3DGS `tandt_db.zip`, 651 MB)

Source: `https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/datasets/input/tandt_db.zip` (the exact COLMAP inputs used by the 3DGS paper). Only the two indoor `db/` scenes were kept; the outdoor Tanks&Temples train/truck were discarded.

Pretrained 3DGS (official INRIA 3DGS, 30k iters, trained on this same COLMAP model, so same world frame) from HuggingFace
`https://huggingface.co/datasets/Voxel51/gaussian_splatting/resolve/main/FO_dataset/drjohnson/point_cloud/iteration_30000/point_cloud.ply` (788 MB).

```
data\samples\
  deepblending_drjohnson\          <- multi-room house walkthrough (best match for a virtual tour)
    colmap\images\                 263 jpg (IMG_6292.jpg ...), 1332x876
    colmap\sparse\0\               cameras.bin images.bin points3D.bin project.ini
                                   1 PINHOLE camera, 263/263 registered, 80,861 pts, reproj 0.56 px
    pretrained_3dgs\point_cloud_30000.ply   3,177,554 gaussians, SH3 (62 props)
  deepblending_playroom\           single room, 225 jpg 1264x832, PINHOLE, 37,005 pts, reproj 0.62 px
    colmap\images\  colmap\sparse\0\
```
Total ~1.1 GB on disk. Verified with pycolmap (`Reconstruction.summary()`) and plyfile. Frame check: pretrained ply 2-98 percentile bbox x[-4.5,3.8] y[-2.6,2.7] z[-6.3,5.2] vs. camera centers x[-3.6,3.3] y[-2.1,2.3] z[-5.9,5.0] -> same coordinate frame, so COLMAP camera poses can be used directly as tour viewpoints over the pretrained splat.
Train with Brush: point it at `...\colmap` (NOT the scene root, see Brush gotcha 1).
No pretrained playroom ply was downloaded (available at the same HF path, `FO_dataset/playroom/...`, 475 MB).

Why this dataset: drjohnson is a real multi-room indoor walkthrough, undistorted PINHOLE, ships COLMAP poses, and has an official pretrained 3DGS. Mip-NeRF 360 room/counter/kitchen are only distributed inside the 12 GB `360_v2.zip` and are single-room orbits.

---

## 5. Research notes (no downloads)

### (a) 360 / equirectangular input
- **COLMAP 4.1+/4.2**: native `EQUIRECTANGULAR` model and the `pycolmap.panorama` virtual-rig pipeline (above). This is now the default choice for SfM from 360 cameras (Insta360/Theta). Recommended flow for us: 360 video -> ffmpeg frame extraction -> `panorama_sfm.py` (perspective_overlapping rig, sequential matcher, global mapper) -> train on the perspective crops with Brush. No trainer we can run locally rasterizes equirect directly.
- **Brush**: pinhole only (COLMAP / nerfstudio formats); no equirect/fisheye rasterizer.
- **OpenSplat**: C++ 3DGS with CPU/CUDA/ROCm/Metal backends; pinhole only, CPU mode is very slow. Not better than Brush on this machine.
- Research trainers that rasterize equirect directly (all CUDA): **OmniGS** (analytic ERP rasterizer), **ODGS** (NeurIPS 2024, per-Gaussian local tangent-plane projection), **360-GS** (layout-guided, indoor panoramas), **ErpGS**, **Seam360GS**, SPaGS, UniTriSplat (2026, spherical rasterization for universal cameras). **gsplat 3DGUT** (`with_ut`) handles fisheye/f-theta distortion but not equirect.

### (b) Best-quality CUDA training today (for a rented GPU / lab server)
gsplat (latest release v1.5.3; `examples/simple_trainer.py` on main):
- `simple_trainer.py mcmc` (MCMCStrategy, fixed splat budget `--strategy.cap-max`, e.g. 1-3M) is the standard quality/size sweet spot.
- `--antialiased` (Mip-Splatting style 2D filter; exporters tag it so viewers use AA rendering).
- `--app_opt` (per-image appearance embedding) or bilateral grid (`lib_bilagrid.py` / fused_bilagrid) for exposure/white balance changes between photos. Useful for indoor phone captures with auto-exposure.
- `--pose_opt` for pose refinement, `--depth_loss` for depth supervision.
- `--with_ut --with_eval3d` = 3DGUT (unscented transform) for distorted fisheye / rolling shutter cameras without undistortion.
- Caveat: gsplat `normalize_world_space=True` by default, so its exported PLY is NOT in COLMAP world frame unless disabled or the transform is saved. Brush exports in COLMAP frame.

### (c) Web formats and Spark
- **@sparkjsdev/spark latest = 2.2.0** (2026-09-11; 2.0.0 released 2026-04-14 with the LoD system). Three.js peer dep >= 0.180.
- Loader (src/SplatLoader.ts) accepts: `.ply` (incl. compressed ply), `.spz`, `.splat`, `.ksplat`, `.sog` (PlayCanvas SOG zip), and **`.rad`**.
- **.RAD** = Spark 2 LoD tree format. Build with `npm run build-lod -- scene.ply --quality` (Rust tool in `rust/build-lod`, needs rustup) -> `scene-lod.rad`. Load with `new SplatMesh({ url: "scene-lod.rad", paged: true })` for streaming. Or `new SplatMesh({ url, lod: true })` builds LoD in a worker at load time (1-3 s per 1M splats). Budget via `SparkRenderer.lodSplatScale` (desktop default 2.5M splats), foveation `coneFov0/coneFov/behindFoveate`. `extSplats: true` for float32 centers in large scenes.
- **SPZ** (Niantic, gzip, ~10x smaller than PLY): universally supported (Spark, splat-transform read/write).
- **SOG** (PlayCanvas, `meta.json` + WebP textures, bundled `.sog`, ~15-20x smaller) and **Streamed SOG** (`lod-meta.json`, multi-LOD chunks for PlayCanvas engine). Tool: `@playcanvas/splat-transform` (npm, v3.6.4, 2026-09-23): `npx @playcanvas/splat-transform in.ply out.sog`, also writes `.spz`, `.compressed.ply`, `.glb` (KHR_gaussian_splatting), streamed SOG, voxel collision. Spark reads bundled `.sog`; Streamed SOG is a PlayCanvas-engine format.
- Suggested for the tour: Brush PLY -> `splat-transform` cleanup (`--filter-nan`, `--filter-floaters`) -> Spark `build-lod` `.rad` with `paged: true`; keep `.spz` as a simple fallback.

---

## Timing (Brush on this laptop)
- drjohnson, from scratch (no ply in folder), `--total-steps 3000 --max-resolution 1024 --max-splats 1500000 --eval-split-every 8`:
  **233 s**, 230 train / 33 eval views, 243k splats at step 2800, **eval PSNR 26.61, SSIM 0.872 at 3k steps**, 57 MB ply (`scratch_brushtest\drj_3000.ply`).
  Speed ~13-15 steps/s early, slowing as splats grow. A full 30k run is roughly 1 hour here (estimate, not measured).
- Brush also trained directly on the COLMAP 4.2 `global_mapper` output (`scratch_colmaptest`, SIMPLE_RADIAL camera, with rigs.bin/frames.bin present): 200 steps in 3 s, no errors. For real runs, undistort to PINHOLE first (`image_undistorter`) since Brush renders with a pinhole model (lens distortion is, as far as we can tell, not modeled; unverified).
- Pathological case: 3.2M initial splats (accidental ply-in-folder) ran at ~0.7 steps/s and nearly exhausted RAM.

## Scratch folders created during verification (safe to delete)
- `scratch_brushtest\` (test plys, logs, autotune cache)
- `scratch_colmaptest\` (40-image COLMAP global_mapper test)
- `tools\_dl\` (downloaded zips, ~320 MB)
