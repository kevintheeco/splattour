"""2x AI super-resolution of every registered training frame + intrinsics x2.
    sr_all.py <ds1 (images/, sparse/0)> <ds2 out> <models dir>
Model: RealESRGAN_x2plus (chosen in the local pilot, docs/checks/wolhajeong-ai/pilot/). After SR, a
low-frequency tone correction puts the frame's brightness/colour back to the original: the blurred
(sigma 3 px at 1x) difference between the original and the 2x-area-downsampled SR frame is added
back, so only detail is new, never tone (x2plus darkened gravel by ~6 levels otherwise).
cameras.bin: width, height, fx, fy, cx, cy all x2 (continuous pixel coordinates scale uniformly)."""
import os
import queue
import shutil
import struct
import sys
import threading
import time

import cv2
import numpy as np
import torch
from spandrel import ModelLoader

ds1, ds2, mdir = sys.argv[1:4]
MODEL = os.environ.get("SR_MODEL", "RealESRGAN_x2plus.pth")
SIGMA = float(os.environ.get("SR_TONE_SIGMA", "3"))
os.makedirs(f"{ds2}/images", exist_ok=True)
os.makedirs(f"{ds2}/sparse/0", exist_ok=True)
for f in os.listdir(f"{ds1}/sparse/0"):
    shutil.copy(f"{ds1}/sparse/0/{f}", f"{ds2}/sparse/0/{f}")

b = bytearray(open(f"{ds1}/sparse/0/cameras.bin", "rb").read())
n, o = struct.unpack_from("<Q", b, 0)[0], 8
for _ in range(n):
    cid, model, w, h = struct.unpack_from("<iiQQ", b, o)
    if model != 1:
        raise SystemExit(f"expected PINHOLE (1), got model {model}")
    params = [p * 2 for p in struct.unpack_from("<4d", b, o + 24)]
    struct.pack_into("<iiQQ", b, o, cid, model, w * 2, h * 2)
    struct.pack_into("<4d", b, o + 24, *params)
    print("[sr] camera", cid, w, h, "->", w * 2, h * 2, [round(p, 3) for p in params], flush=True)
    o += 24 + 32
open(f"{ds2}/sparse/0/cameras.bin", "wb").write(bytes(b))

names = []
with open(f"{ds1}/sparse/0/images.bin", "rb") as fh:
    for _ in range(struct.unpack("<Q", fh.read(8))[0]):
        fh.read(4 + 32 + 24 + 4)
        nm = b""
        while (c := fh.read(1)) != b"\0":
            nm += c
        names.append(nm.decode())
        fh.seek(struct.unpack("<Q", fh.read(8))[0] * 24, 1)
names.sort()
print("[sr] frames", len(names), "model", MODEL, "tone sigma", SIGMA, flush=True)

d = ModelLoader().load_from_file(os.path.join(mdir, MODEL))
m = d.model.cuda().eval().half()
sc = d.scale
q: queue.Queue = queue.Queue(12)
stats = []


def worker():
    while (it := q.get()) is not None:
        nm, im, y = it
        H, W = im.shape[:2]
        y = y.astype(np.float32)
        if SIGMA > 0:
            down = cv2.resize(y, (W, H), interpolation=cv2.INTER_AREA)
            diff = cv2.GaussianBlur(im.astype(np.float32) - down, (0, 0), SIGMA)
            y = y + cv2.resize(diff, (W * 2, H * 2), interpolation=cv2.INTER_CUBIC)
        out = np.clip(y + 0.5, 0, 255).astype(np.uint8)
        cv2.imwrite(f"{ds2}/images/{nm}", out, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        dd = cv2.resize(out, (W, H), interpolation=cv2.INTER_AREA).astype(np.float32)
        stats.append(10 * np.log10(255 ** 2 / max(1e-6, float(np.mean((dd - im) ** 2)))))


ths = [threading.Thread(target=worker) for _ in range(8)]
[t.start() for t in ths]
t0 = time.time()
for i, nm in enumerate(names):
    im = cv2.imread(f"{ds1}/images/{nm}", cv2.IMREAD_COLOR)
    H, W = im.shape[:2]
    x = torch.from_numpy(np.ascontiguousarray(im[:, :, ::-1])).cuda().permute(2, 0, 1)[None].half() / 255
    x = torch.nn.functional.pad(x, (0, (-W) % 8, 0, (-H) % 8), mode="reflect")
    with torch.no_grad():
        y = m(x)[:, :, :H * sc, :W * sc].float().clamp(0, 1)
    if sc != 2:
        y = torch.nn.functional.interpolate(y, size=(H * 2, W * 2), mode="area")
    q.put((nm, im, y[0].permute(1, 2, 0).cpu().numpy()[:, :, ::-1] * 255))
    if i % 50 == 0:
        print(f"[sr] {i}/{len(names)} {time.time() - t0:.0f}s", flush=True)
for _ in ths:
    q.put(None)
[t.join() for t in ths]
print(f"[sr] done {len(names)} in {time.time() - t0:.0f}s; PSNR(area-down(SR), original) mean {np.mean(stats):.2f} min {np.min(stats):.2f}", flush=True)
