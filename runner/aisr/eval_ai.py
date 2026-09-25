"""Score the current and the AI-SR model on the SAME held-out frames against the ORIGINAL frames,
and render side-by-side views (left current, right AI).
Runs in gsplat/examples (datasets.colmap Parser = the trainer's own split: sorted names, i % 8 == 0).
Writes /workspace/evalout/{metrics.json, compare-*.jpg, heldout-*.jpg}."""
import json
import math
import os
import sys

import cv2
import numpy as np
import torch

sys.path.insert(0, "/workspace/gsplat/examples")
os.chdir("/workspace/gsplat/examples")
from datasets.colmap import Parser  # noqa: E402
from gsplat.rendering import rasterization  # noqa: E402
from torchmetrics.image import PeakSignalNoiseRatio, StructuralSimilarityIndexMeasure  # noqa: E402
from torchmetrics.image.lpip import LearnedPerceptualImagePatchSimilarity  # noqa: E402

OUT = "/workspace/evalout"
os.makedirs(OUT, exist_ok=True)
dev = "cuda"
ONLY_CURRENT = sys.argv[1:] == ["current"]  # early renderer check before training: must reproduce the published 29.67 dB
MODELS = {"current": "/workspace/old.ply"}
if not ONLY_CURRENT:
    MODELS["ai"] = sorted(__import__("glob").glob("/workspace/result/ply/*.ply"))[-1]
TOUR = json.load(open("/workspace/st/aisr/tour_nodes.json"))  # [[node id, image name], ...]


def load_ply(p):
    with open(p, "rb") as f:
        props, n = [], 0
        while (line := f.readline().decode().strip()) != "end_header":
            t = line.split()
            if t[0] == "element" and t[1] == "vertex":
                n = int(t[2])
            elif t[0] == "property":
                props.append(t[2])
        a = np.frombuffer(f.read(n * 4 * len(props)), dtype=np.float32).reshape(n, len(props))
    ix = {k: i for i, k in enumerate(props)}
    col = lambda *ks: torch.from_numpy(np.stack([a[:, ix[k]] for k in ks], 1).copy()).to(dev)  # noqa: E731
    rest = sorted([k for k in props if k.startswith("f_rest_")], key=lambda k: int(k[7:]))
    sh0 = col("f_dc_0", "f_dc_1", "f_dc_2")[:, None, :]
    shN = col(*rest).reshape(n, 3, -1).transpose(1, 2)
    return dict(means=col("x", "y", "z"), quats=torch.nn.functional.normalize(col("rot_0", "rot_1", "rot_2", "rot_3"), dim=-1),
                scales=torch.exp(col("scale_0", "scale_1", "scale_2")), opacities=torch.sigmoid(col("opacity")[:, 0]),
                colors=torch.cat([sh0, shN], 1), sh=int(math.isqrt(shN.shape[1] + 1) - 1))


@torch.no_grad()
def render(g, c2w, K, w, h):
    vm = torch.linalg.inv(torch.as_tensor(c2w, dtype=torch.float32, device=dev))[None]
    img, _, _ = rasterization(g["means"], g["quats"], g["scales"], g["opacities"], g["colors"], vm,
                              torch.as_tensor(K, dtype=torch.float32, device=dev)[None], w, h, sh_degree=g["sh"],
                              near_plane=0.01, far_plane=1e10, rasterize_mode="antialiased", packed=False)
    return img[0].clamp(0, 1)


P = Parser(data_dir="/workspace/ds1", factor=1, normalize=False, test_every=8)
N = len(P.image_names)
test = [i for i in range(N) if i % 8 == 0]
cid = P.camera_ids[0]
K1 = P.Ks_dict[cid]
W1, H1 = P.imsize_dict[cid]
print("images", N, "test", len(test), "size", W1, H1, flush=True)
name_ix = {n: i for i, n in enumerate(P.image_names)}

# views to compare: 11 tour nodes (their capture camera) + 5 off-path (moved 0.8 right / 0.5 forward in SfM units ~ 0.6 m / 0.4 m, turned 30 deg)
views = [(nid, P.camtoworlds[name_ix[im]]) for nid, im in TOUR if im in name_ix]
th = math.radians(30)
Ry = np.array([[math.cos(th), 0, math.sin(th), 0], [0, 1, 0, 0], [-math.sin(th), 0, math.cos(th), 0], [0, 0, 0, 1]])
for k, (nid, c2w) in enumerate(views[::2][:5]):
    T = np.eye(4); T[:3, 3] = [0.8 if k % 2 == 0 else -0.8, 0, 0.5]
    views.append((f"off{k + 1}-near-{nid}", c2w @ T @ (Ry if k % 2 == 0 else np.linalg.inv(Ry))))

psnr = PeakSignalNoiseRatio(data_range=1.0).to(dev)
ssim = StructuralSimilarityIndexMeasure(data_range=1.0).to(dev)
lp = LearnedPerceptualImagePatchSimilarity(net_type="alex", normalize=True).to(dev)
res, rend = {}, {}
K2 = K1.copy(); K2[:2] *= 2
for key, path in MODELS.items():
    g = load_ply(path)
    print(key, path, g["means"].shape[0], "splats, sh", g["sh"], flush=True)
    ps, ss, ls, per = [], [], [], {}
    for j, i in enumerate(test):
        gt = torch.from_numpy(cv2.imread(P.image_paths[i])[:, :, ::-1].copy()).to(dev).float() / 255
        im = render(g, P.camtoworlds[i], K1, W1, H1)
        a, b = im.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None]
        ps.append(psnr(a, b).item()); ss.append(ssim(a, b).item()); ls.append(lp(a, b).item())
        per[P.image_names[i]] = round(ps[-1], 3)
        if j in (3, 30, 60, 90):
            rend[(f"heldout-{P.image_names[i][:-4]}", key)] = (im.cpu().numpy() * 255).astype(np.uint8)[:, :, ::-1]
            rend[(f"heldout-{P.image_names[i][:-4]}", "original")] = (gt.cpu().numpy() * 255).astype(np.uint8)[:, :, ::-1]
    res[key] = {"psnr": float(np.mean(ps)), "ssim": float(np.mean(ss)), "lpips": float(np.mean(ls)), "n": len(ps), "per_image_psnr": per}
    print(key, {k: round(v, 4) for k, v in res[key].items() if k != "per_image_psnr"}, flush=True)
    for vid, c2w in views:
        a = (render(g, c2w, K1, W1, H1).cpu().numpy() * 255).astype(np.uint8)[:, :, ::-1]
        b = (render(g, c2w, K2, W1 * 2, H1 * 2).cpu().numpy() * 255).astype(np.uint8)[:, :, ::-1]
        rend[(vid, key)] = a
        rend[(vid, key + "2x")] = b[H1 // 2:H1 // 2 + H1, W1 // 2:W1 // 2 + W1]
    del g
    torch.cuda.empty_cache()
json.dump(res, open(f"{OUT}/metrics{'_current' if ONLY_CURRENT else ''}.json", "w"), indent=1)
if ONLY_CURRENT:
    print("EVAL_CURRENT", json.dumps({k: v for k, v in res["current"].items() if k != "per_image_psnr"}), flush=True)
    sys.exit(0)


def lab(im, t):
    im = im.copy()
    cv2.rectangle(im, (0, 0), (18 + 17 * len(t), 44), (0, 0, 0), -1)
    cv2.putText(im, t, (8, 32), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
    return im


for vid, _ in views:
    top = np.hstack([lab(rend[(vid, "current")], f"{vid} current (wolhajeong)"), lab(rend[(vid, "ai")], "AI (wolhajeong-ai)")])
    bot = np.hstack([lab(rend[(vid, "current2x")], "center, 2x zoom"), lab(rend[(vid, "ai2x")], "center, 2x zoom")])
    cv2.imwrite(f"{OUT}/compare-{vid}.jpg", np.vstack([top, bot]), [cv2.IMWRITE_JPEG_QUALITY, 88])
for v in sorted({k[0] for k in rend if k[0].startswith("heldout-")}):
    cv2.imwrite(f"{OUT}/{v}.jpg", np.hstack([lab(rend[(v, "original")], "original frame (not trained on)"),
                                            lab(rend[(v, "current")], "current"), lab(rend[(v, "ai")], "AI")]), [cv2.IMWRITE_JPEG_QUALITY, 88])
print("EVAL_DONE", json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "per_image_psnr"} for k, v in res.items()}), flush=True)
