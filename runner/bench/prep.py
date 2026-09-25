# raw PNG frames -> SfM copies (JPEG, CLAHE + gamma lift so dark rooms get SIFT features), all frames kept.
import cv2, numpy as np, glob, os, sys
from concurrent.futures import ThreadPoolExecutor
src = sorted(glob.glob("/workspace/raw/*.png"))
out = sys.argv[1] if len(sys.argv) > 1 else "/workspace/img_sfm"
os.makedirs(out, exist_ok=True)
cl = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
def one(p):
    im = cv2.imread(p, cv2.IMREAD_COLOR)
    lab = cv2.cvtColor(im, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32) / 255
    m = L.mean()
    if m < 0.35:  # lift dark frames first (gamma), CLAHE alone amplifies banding
        L = L ** (np.log(0.4) / np.log(max(m, 0.02)))
    lab[:, :, 0] = cl.apply((np.clip(L, 0, 1) * 255).astype(np.uint8))
    cv2.imwrite(os.path.join(out, os.path.basename(p)[:-4] + ".jpg"), cv2.cvtColor(lab, cv2.COLOR_LAB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
with ThreadPoolExecutor(32) as ex: list(ex.map(one, src))
print("prep", len(src))
