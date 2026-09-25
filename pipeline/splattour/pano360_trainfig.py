"""Training-process record for the thesis figures (how the Gaussians come together), inside gsplat's trainer.

Loaded by pano360.TRAIN_WRAPPER when PANO360_FIG_DIR is set; it wraps the densification strategy's
step_post_backward (called every step with the live Gaussians) and never touches the optimisation itself.
Everything is wrapped in try/except: a figure problem can not stop the training.

Env:
  PANO360_FIG_DIR      output folder
  PANO360_FIG_VIEWS    json [{"name": "courtyard", "clip": 1, "t": 110, "view": 7, "focal": 0.6}, ...]
                       (training cameras resolved by clip / video time / rig view; focal < 1 = wider)
  PANO360_FIG_SNAPS    iterations for snapshots (default 0,500,1000,2000,5000,10000,20000,30000 + final)
  PANO360_FIG_SAVE     iterations whose Gaussians are saved (float16 npz: means, log-scales, quats, opacity logits, sh0)
  PANO360_FIG_EVAL     held-out PSNR/SSIM every N iterations (default 1000) on PANO360_FIG_EVAL_N views (default 24)
Output:
  counts.csv       step, gaussians, dead share (opacity <= 0.005, what MCMC relocates at its refine steps)
  eval.csv         iteration, held-out PSNR, SSIM (person pixels excluded), views
  snapshots.jsonl  per snapshot: count, scale mean/median/p90 (largest axis, world units), opacity histogram
  views/<view>/<iter>.png, views/<view>/gt.png, views/<view>/final_ellipsoids.png, final_lowopacity.png
  gaussians_<iter>.npz
The train loss comes from the trainer's own tensorboard log (tb_to_csv below -> loss.csv).
"""
from __future__ import annotations

import json
import math
import os
import time
import traceback

import numpy as np
import torch

OUT = os.environ.get("PANO360_FIG_DIR", "figures")
_state = {"ds": None, "total": None, "t0": time.time(), "views": None}


def _log_err(where):
    with open(os.path.join(OUT, "errors.log"), "a") as f:
        f.write(f"--- {where}\n{traceback.format_exc()}\n")


def _steps(argv):
    def val(names, default):
        for i, a in enumerate(argv):
            if a in names and i + 1 < len(argv):
                return int(float(argv[i + 1]))
        return default
    return val(("--max-steps", "--max_steps"), 30000) * val(("--steps-scaler", "--steps_scaler"), 1)


def _render(p, c2w, K, W, H, scale_mul=None, opacity=None, sh0_only=False, keep=None, bg=0.0):
    from gsplat.rendering import rasterization
    means, quats, scales, op = p["means"], p["quats"], torch.exp(p["scales"]), torch.sigmoid(p["opacities"])
    colors = p["sh0"] if sh0_only else torch.cat([p["sh0"], p["shN"]], 1)
    if keep is not None:
        means, quats, scales, op, colors = means[keep], quats[keep], scales[keep], op[keep], colors[keep]
    if scale_mul is not None:
        scales = scales * scale_mul
    if opacity is not None:
        op = opacity if torch.is_tensor(opacity) else torch.full_like(op, float(opacity))
    deg = int(round(math.sqrt(colors.shape[1]))) - 1
    c2w = torch.as_tensor(c2w, dtype=torch.float32, device=means.device)
    K = torch.as_tensor(K, dtype=torch.float32, device=means.device)
    img, _, _ = rasterization(means, quats, scales, op, colors, torch.linalg.inv(c2w)[None], K[None], int(W), int(H), sh_degree=deg,
                              packed=False, rasterize_mode="antialiased", backgrounds=torch.full((1, 3), bg, device=means.device))
    return img[0].clamp(0, 1)


def _save_png(path, img):
    import imageio.v2 as imageio
    os.makedirs(os.path.dirname(path), exist_ok=True)
    a = img.detach().cpu().numpy() if torch.is_tensor(img) else img
    imageio.imwrite(path, (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8) if a.dtype != np.uint8 else a)


def _resolve_views():
    ds = _state["ds"].get("train")
    parser = ds.parser
    specs = json.loads(os.environ.get("PANO360_FIG_VIEWS") or "[]")
    out = []
    for sp in specs:
        pre = f"pano_camera{sp['view']}/c{int(sp['clip']):02d}_"
        best, bd = None, 1e9
        for i, nm in enumerate(parser.image_names):
            if nm.startswith(pre):
                try:
                    t = int(nm[len(pre):].split(".")[0]) / float(sp.get("fps", 30))
                except ValueError:
                    continue
                if abs(t - sp["t"]) < bd:
                    best, bd = i, abs(t - sp["t"])
        if best is None:
            continue
        cid = parser.camera_ids[best]
        K = np.array(parser.Ks_dict[cid], dtype=np.float64).copy()
        W, H = parser.imsize_dict[cid]
        s = float(sp.get("scale", 0.5))
        K[:2] *= s
        f = float(sp.get("focal", 1.0))
        K[0, 0] *= f
        K[1, 1] *= f
        rec = {"name": sp["name"], "image": parser.image_names[best], "dt": round(bd, 3), "c2w": np.array(parser.camtoworlds[best]),
               "K": K, "W": int(W * s), "H": int(H * s), "focal": f}
        out.append(rec)
        try:
            import cv2
            im = cv2.imread(parser.image_paths[best])[:, :, ::-1]
            if f > 1.0:  # narrower than the photo: the same central crop
                h0, w0 = im.shape[:2]
                cw, ch = int(w0 / f), int(h0 / f)
                im = im[(h0 - ch) // 2:(h0 - ch) // 2 + ch, (w0 - cw) // 2:(w0 - cw) // 2 + cw]
            # wider than the photo (f < 1): the photo keeps its own 90 x 70 deg view (labelled as such in figures.py)
            im = cv2.resize(np.ascontiguousarray(im), (rec["W"], rec["H"]), interpolation=cv2.INTER_AREA)
            _save_png(os.path.join(OUT, "views", sp["name"], "gt.png"), im)
        except Exception:  # noqa: BLE001
            _log_err("gt")
    with open(os.path.join(OUT, "views.json"), "w") as fh:
        json.dump([{k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in r.items()} for r in out], fh, indent=1)
    return out


def _eval(p, it):
    ds = _state["ds"].get("val")
    if ds is None or len(ds) == 0:
        return
    from torchmetrics.image import StructuralSimilarityIndexMeasure
    n = int(os.environ.get("PANO360_FIG_EVAL_N", 24))
    idx = np.linspace(0, len(ds) - 1, min(n, len(ds))).round().astype(int)
    ssim = StructuralSimilarityIndexMeasure(data_range=1.0).to(p["means"].device)
    ps, ss = [], []
    for i in idx:
        d = ds[int(i)]
        gt = d["image"].to(p["means"].device).float() / 255.0
        H, W = gt.shape[:2]
        img = _render(p, d["camtoworld"], d["K"], W, H)
        m = d.get("mask")
        if m is not None:
            m = m.to(img.device)[..., None].float()
            img, gt = img * m, gt * m
            mse = ((img - gt) ** 2).sum() / (m.sum() * 3).clamp(min=1)
        else:
            mse = ((img - gt) ** 2).mean()
        ps.append(float(10 * torch.log10(1 / mse.clamp(min=1e-10))))
        ss.append(float(ssim(img.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None])))
    new = not os.path.exists(os.path.join(OUT, "eval.csv"))
    with open(os.path.join(OUT, "eval.csv"), "a") as f:
        if new:
            f.write("iteration,psnr,ssim,views,seconds\n")
        f.write(f"{it},{np.mean(ps):.3f},{np.mean(ss):.4f},{len(ps)},{time.time() - _state['t0']:.0f}\n")


def _prune_check(p, thr: float = 0.02):
    """Held-out PSNR/SSIM with and without the Gaussians of opacity < thr (the post-train prune): prune_eval.json."""
    ev = {}
    for tag, keep in (("full", None), ("pruned", torch.where(torch.sigmoid(p["opacities"]).flatten() >= thr)[0])):
        q = p if keep is None else {k: v[keep] for k, v in p.items()}
        f = os.path.join(OUT, "eval.csv")
        before = open(f).read() if os.path.exists(f) else None
        _eval(q, f"final_{tag}")
        rows = open(f).read().splitlines()
        last = rows[-1].split(",")
        ev[tag] = {"psnr": float(last[1]), "ssim": float(last[2]), "gaussians": int((q["means"]).shape[0])}
    ev["threshold"] = thr
    ev["prune_ok"] = ev["pruned"]["psnr"] >= ev["full"]["psnr"] - 0.05
    with open(os.path.join(OUT, "prune_eval.json"), "w") as fh:
        json.dump(ev, fh, indent=1)


def _snapshot(p, it, final=False):
    with torch.no_grad():
        n = p["means"].shape[0]
        sc = torch.exp(p["scales"]).max(1).values
        op = torch.sigmoid(p["opacities"]).flatten()
        hist = torch.histc(op, bins=20, min=0, max=1).long().tolist()
        q = torch.quantile(sc[torch.randperm(n, device=sc.device)[:1_000_000]], torch.tensor([0.5, 0.9], device=sc.device)).tolist()
        rec = {"iteration": it, "final": final, "gaussians": n, "scale_mean": float(sc.mean()), "scale_median": q[0], "scale_p90": q[1],
               "opacity_hist20": hist, "dead_share": float((op <= 0.005).float().mean()), "seconds": round(time.time() - _state["t0"])}
        with open(os.path.join(OUT, "snapshots.jsonl"), "a") as f:
            f.write(json.dumps(rec) + "\n")
        saves = {int(x) for x in (os.environ.get("PANO360_FIG_SAVE") or "0,1000,5000,20000").split(",") if x}
        if it in saves:
            np.savez_compressed(os.path.join(OUT, f"gaussians_{it:06d}.npz"), means=p["means"].detach().half().cpu().numpy(),
                                scales=p["scales"].detach().half().cpu().numpy(), quats=p["quats"].detach().half().cpu().numpy(),
                                opacities=p["opacities"].detach().half().cpu().numpy().reshape(-1), sh0=p["sh0"].detach().half().cpu().numpy())
        if _state["views"] is None:
            _state["views"] = _resolve_views()
        tag = "final" if final else f"{it:06d}"
        for v in _state["views"]:
            _save_png(os.path.join(OUT, "views", v["name"], f"{tag}.png"), _render(p, v["c2w"], v["K"], v["W"], v["H"]))
        if final:
            opac = torch.sigmoid(p["opacities"]).flatten()
            keep = torch.where(opac > 0.3)[0]
            for v in _state["views"]:
                # the primitives themselves: every solid Gaussian shrunk to 30% of its size, flat base colour, on dark grey
                _save_png(os.path.join(OUT, "views", v["name"], "final_ellipsoids.png"),
                          _render(p, v["c2w"], v["K"], v["W"], v["H"], scale_mul=0.3, opacity=0.9, sh0_only=True, keep=keep, bg=0.08))
                # all Gaussians at a quarter of their opacity: the overlapping soft blobs
                _save_png(os.path.join(OUT, "views", v["name"], "final_lowopacity.png"),
                          _render(p, v["c2w"], v["K"], v["W"], v["H"], opacity=torch.sigmoid(p["opacities"]).flatten() * 0.25, bg=0.0))


def install(DS: dict, argv: list[str]) -> None:
    from gsplat import strategy as S
    os.makedirs(OUT, exist_ok=True)
    _state["ds"] = DS
    _state["total"] = total = _steps(argv)
    snaps = sorted({int(x) for x in (os.environ.get("PANO360_FIG_SNAPS") or "0,500,1000,2000,5000,10000,20000,30000").split(",") if x})
    ev = int(os.environ.get("PANO360_FIG_EVAL", 1000))
    with open(os.path.join(OUT, "counts.csv"), "w") as f:
        f.write("step,gaussians,dead_share\n")

    def wrap(cls):
        orig = cls.step_post_backward

        def spb(self, params, optimizers, state, step, *a, **k):
            if step % 100 == 0:  # before the strategy acts: the dead share is what MCMC relocates at this refine step
                try:
                    with torch.no_grad():
                        op = torch.sigmoid(params["opacities"]).flatten()
                        with open(os.path.join(OUT, "counts.csv"), "a") as f:
                            f.write(f"{step},{op.shape[0]},{float((op <= 0.005).float().mean()):.5f}\n")
                except Exception:  # noqa: BLE001
                    _log_err(f"counts {step}")
            r = orig(self, params, optimizers, state, step, *a, **k)
            it = step + 1
            try:
                with torch.no_grad():
                    if step == 0 or it in snaps:
                        _snapshot(params, 0 if step == 0 else it)
                    if it % ev == 0:
                        _eval(params, it)
                    if it == total:
                        _snapshot(params, it, final=True)
                        _prune_check(params, float(os.environ.get("PANO360_PRUNE_OPACITY", 0.02)))
            except Exception:  # noqa: BLE001
                _log_err(f"snapshot {step}")
            return r
        cls.step_post_backward = spb
    for name in ("MCMCStrategy", "DefaultStrategy"):
        if hasattr(S, name):
            wrap(getattr(S, name))


def tb_to_csv(result_dir: str, out_csv: str) -> int:
    """The trainer's tensorboard scalars (train/loss, l1loss, ssimloss, num_GS) -> one CSV row per logged step."""
    from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
    import glob
    rows = {}
    for ev in glob.glob(os.path.join(result_dir, "tb", "**", "events.*"), recursive=True):
        acc = EventAccumulator(ev, size_guidance={"scalars": 0})
        acc.Reload()
        for tag in acc.Tags().get("scalars", []):
            for e in acc.Scalars(tag):
                rows.setdefault(e.step, {})[tag] = e.value
    tags = sorted({t for r in rows.values() for t in r})
    with open(out_csv, "w") as f:
        f.write("step," + ",".join(tags) + "\n")
        for s in sorted(rows):
            f.write(f"{s}," + ",".join(f"{rows[s].get(t, '')}" for t in tags) + "\n")
    return len(rows)


if __name__ == "__main__":
    import sys
    print(tb_to_csv(sys.argv[1], sys.argv[2]))
