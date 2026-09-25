"""VSR pilot (docs/PANO360.md "VSR 시험"): same perspective crops, 16 consecutive 30 fps frames each.
  A) faithfulness with ground truth: native crop -> area 2x down -> each method 2x -> compare to native
  B) real use: native crop -> 2x; sharpness, plain-wall invented texture, temporal consistency
Methods: bicubic (= no SR), Real-ESRGAN x2plus (single image), BasicVSR++ REDS BI (x4 -> area 2x), RealBasicVSR (x4 -> area 2x).
    python -m splattour.vsr_pilot <seq root> <weights dir> <out dir>   (from pipeline/, torch python e.g. data/pano360/segenv)
"""
import json, sys, time
from pathlib import Path
import cv2, numpy as np, torch, torch.nn.functional as F
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from splattour import vsr

torch.set_num_threads(8)
root, wdir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
N = 16
S = 256
PATCHES = [  # (sequence, x, y, kind)
    ("c10_bed", 150, 820, "lattice door"), ("c10_bed", 1150, 720, "wall + small window"),
    ("c10_wall", 1100, 450, "octagon lattice"), ("c10_wall", 1700, 1000, "plain wall"),
    ("c8_court", 900, 800, "courtyard through door"), ("c8_lattice", 800, 800, "dark lattice"),
    ("c9_wall", 1000, 700, "dark plain wall"), ("c8_court", 1450, 300, "roof/tiles"),
]
nets = {"x2plus": vsr.load_esrgan_x2(wdir / "RealESRGAN_x2plus.pth"),
        "basicvsrpp": vsr.load("basicvsrpp", wdir / "basicvsr_plusplus_c64n7_8x1_600k_reds4_20210217-db622b2f.pth"),
        "realbasicvsr": vsr.load("realbasicvsr", wdir / "realbasicvsr_c64b20_1x30x8_lr5e-5_150k_reds_20211104-52f77c2c.pth")}


def run(name, x):  # x [T,3,h,w] 0..1 -> [T,3,2h,2w]
    with torch.no_grad():
        if name == "bicubic":
            return F.interpolate(x, scale_factor=2, mode="bicubic", align_corners=False).clamp(0, 1)
        if name == "x2plus":
            return torch.cat([nets["x2plus"](x[i:i + 1]).clamp(0, 1) for i in range(len(x))])
        return vsr.upscale(nets[name], x, scale=2)


def psnr(a, b):
    return float(10 * np.log10(1 / max(1e-10, np.mean((a - b) ** 2))))


def ssim(a, b):
    a, b = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY).astype(np.float64), cv2.cvtColor(b, cv2.COLOR_RGB2GRAY).astype(np.float64)
    g = lambda z: cv2.GaussianBlur(z, (11, 11), 1.5)  # noqa: E731
    ma, mb = g(a), g(b)
    va, vb, cab = g(a * a) - ma ** 2, g(b * b) - mb ** 2, g(a * b) - ma * mb
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    return float(np.mean(((2 * ma * mb + c1) * (2 * cab + c2)) / ((ma ** 2 + mb ** 2 + c1) * (va + vb + c2))))


def hf(img):  # high-frequency energy (detail / noise / invented texture), grey 0..1
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32)
    return float(np.mean(np.abs(g - cv2.GaussianBlur(g, (0, 0), 1.5))))


def grad(img):
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32)
    return float(np.mean(np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))))


def flicker(frames, ref):
    """mean |out_t - warp(out_t+1 -> t)|, flow from the (bicubic) reference frames: temporal consistency."""
    d = []
    for t in range(len(frames) - 1):
        a = (cv2.cvtColor(ref[t], cv2.COLOR_RGB2GRAY) * 255).astype(np.uint8)
        b = (cv2.cvtColor(ref[t + 1], cv2.COLOR_RGB2GRAY) * 255).astype(np.uint8)
        fl = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 4, 21, 3, 5, 1.2, 0)
        h, w = a.shape
        gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        wb = cv2.remap(frames[t + 1], gx + fl[..., 0], gy + fl[..., 1], cv2.INTER_LINEAR)
        m = 12
        d.append(float(np.mean(np.abs(frames[t] - wb)[m:-m, m:-m])))
    return float(np.mean(d))


def to_np(y):
    return y.permute(0, 2, 3, 1).numpy()


methods = ["bicubic", "x2plus", "basicvsrpp", "realbasicvsr"]
report = []
for k, (seq, x, y, kind) in enumerate(PATCHES):
    fr = [cv2.imread(str(root / seq / f"f{i:02d}.png"))[:, :, ::-1] for i in range(1, N + 1)]
    nat = np.stack([f[y:y + S, x:x + S] for f in fr]).astype(np.float32) / 255
    X = torch.from_numpy(nat).permute(0, 3, 1, 2).contiguous()
    lr = F.interpolate(X, scale_factor=0.5, mode="area")
    rec = {"patch": k, "seq": seq, "xy": [x, y], "kind": kind, "A": {}, "B": {}}
    outs_b = {}
    for m in methods:
        t = time.time()
        ya = to_np(run(m, lr))
        rec["A"][m] = {"psnr": round(np.mean([psnr(ya[i], nat[i]) for i in range(N)]), 2),
                       "ssim": round(np.mean([ssim(ya[i], nat[i]) for i in range(N)]), 4)}
        yb = to_np(run(m, X))
        outs_b[m] = yb
        rec["B"][m] = {"grad": round(np.mean([grad(f) for f in yb]), 4), "hf": round(np.mean([hf(f) for f in yb]), 5), "sec": round(time.time() - t, 1)}
        print(seq, kind, m, rec["A"][m], rec["B"][m], flush=True)
    for m in methods:
        rec["B"][m]["flicker"] = round(flicker(outs_b[m], outs_b["bicubic"]), 5)
    # the native input itself (no upscaling) for reference: hf of the 1x native
    rec["native_hf_1x"] = round(np.mean([hf(f) for f in nat]), 5)
    report.append(rec)
    # images: middle frame, 2x of each method, plus a 2x crop (128 px of the 2x = 64 native px) at 3x for eyes
    i = N // 2
    tiles = [cv2.resize(np.ascontiguousarray(nat[i]), (2 * S, 2 * S), interpolation=cv2.INTER_NEAREST)] + [outs_b[m][i] for m in methods]
    row = np.hstack([np.pad(t, ((24, 0), (0, 4), (0, 0)), constant_values=1) for t in tiles])
    labels = ["native (pixel x2)", "bicubic", "Real-ESRGAN x2plus", "BasicVSR++", "RealBasicVSR"]
    img = (row[:, :, ::-1] * 255).clip(0, 255).astype(np.uint8)
    for j, lab in enumerate(labels):
        cv2.putText(img, lab, (6 + j * (2 * S + 4), 17), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 200), 1, cv2.LINE_AA)
    cv2.imwrite(str(out / f"p{k}_{seq}_{kind.replace(' ', '-').replace('/', '-')}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 93])
    # temporal strip: 4 consecutive frames of BasicVSR++ vs x2plus (same 160x160 region of the 2x)
    c0 = S - 80
    strip = []
    for m in ("bicubic", "x2plus", "basicvsrpp"):
        strip.append(np.hstack([np.pad(outs_b[m][t][c0:c0 + 160, c0:c0 + 160], ((0, 2), (0, 2), (0, 0)), constant_values=1) for t in range(i - 2, i + 2)]))
    st = cv2.resize((np.vstack(strip)[:, :, ::-1] * 255).clip(0, 255).astype(np.uint8), None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(str(out / f"p{k}_temporal_bicubic-x2plus-basicvsrpp.jpg"), st, [cv2.IMWRITE_JPEG_QUALITY, 93])
    (out / "pilot_metrics.json").write_text(json.dumps(report, indent=1))
print("done")
