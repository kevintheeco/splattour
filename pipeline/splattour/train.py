"""3DGS training backends.

brush  — WebGPU trainer, runs on this laptop's Intel Arc (Vulkan). Output
         stays in the COLMAP frame.
gsplat — CUDA reference trainer for thesis-quality results (lab GPU / cloud).
         We run it with world normalisation off so the output also stays in
         the COLMAP frame; MCMC densification, anti-aliasing and per-image
         appearance optimisation handle hanok-style exposure swings.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools"
BRUSH = os.environ.get("SPLATTOUR_BRUSH", str(TOOLS / "brush" / "brush_app.exe"))


def stage_dataset(dataset: Path, stage: Path) -> Path:
    """Brush loads any .ply inside the dataset as initial splats, so train
    from a staging folder that holds only images/ and sparse/0/."""
    stage.mkdir(parents=True, exist_ok=True)
    for sub in ("images", "sparse"):
        dst = stage / sub
        if dst.exists():
            continue
        src = dataset / sub
        try:
            os.symlink(src, dst, target_is_directory=True)
        except OSError:
            subprocess.run(["cmd", "/c", "mklink", "/J", str(dst), str(src)], check=True, capture_output=True)
    return stage


def train_brush(dataset: Path, out: Path, steps: int = 30000, max_resolution: int = 1024, max_splats: int = 1_500_000,
                sh_degree: int = 3, eval_every: int = 8) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    stage = stage_dataset(dataset, out / "_stage")
    log = out / "brush.log"
    args = [BRUSH, str(stage), "--total-steps", str(steps), "--max-resolution", str(max_resolution),
            "--max-splats", str(max_splats), "--sh-degree", str(sh_degree),
            "--eval-split-every", str(eval_every), "--eval-every", str(steps),
            "--export-every", str(steps), "--export-path", str(out), "--export-name", "splat_{iter}.ply"]
    env = {**os.environ, "RUST_LOG": "info"}
    t0 = time.time()
    with open(log, "w", encoding="utf-8") as f:
        r = subprocess.run(args, cwd=out, stdout=f, stderr=subprocess.STDOUT, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"brush failed ({r.returncode}), see {log}")
    ply = out / f"splat_{steps}.ply"
    if not ply.exists():
        cands = sorted(out.glob("splat_*.ply"))
        if not cands:
            raise RuntimeError(f"brush produced no ply, see {log}")
        ply = cands[-1]
    text = log.read_text(encoding="utf-8", errors="ignore")
    psnr = re.findall(r"psnr[^0-9]*([0-9]+\.[0-9]+)", text, re.I)
    ssim = re.findall(r"ssim[^0-9]*([0-9]+\.[0-9]+)", text, re.I)
    return {"backend": "brush", "ply": str(ply), "steps": steps, "seconds": round(time.time() - t0, 1),
            "eval_psnr": float(psnr[-1]) if psnr else None, "eval_ssim": float(ssim[-1]) if ssim else None}


GSPLAT_CMD = """# Run on a CUDA machine (lab server / RunPod). Requires: pip install gsplat
python simple_trainer.py mcmc \\
  --data_dir {dataset} --data_factor 1 --result_dir {out} \\
  --normalize_world_space False \\
  --antialiased --app_opt \\
  --strategy.cap_max {cap} \\
  --max_steps {steps} --eval_steps {steps} --save_steps {steps} --save_ply --ply_steps {steps} \\
  --test_every 8
"""


def gsplat_command(dataset: Path, out: Path, steps: int = 30000, cap: int = 3_000_000) -> str:
    return GSPLAT_CMD.format(dataset=dataset, out=out, steps=steps, cap=cap)
