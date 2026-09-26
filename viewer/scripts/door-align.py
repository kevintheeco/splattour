# Align a room captured as its own 3DGS model (e.g. 월하정 사랑방) to the space's model
# through a real door seen from both sides: door frame points picked in each model
# (raycasts on the frame wood: top corners + points along both vertical edges),
# rectangle frames fitted on each side, inside-left <-> outside-right (mirror),
# scale from the top edge. Prints nav.json rooms[].sceneTransform and checks.
# Used 2026-09-26 for wolhajeong360-sarang -> wolhajeong360-hq (edges within 5 cm).
#   pipeline/.venv/Scripts/python.exe viewer/scripts/door-align.py
import numpy as np, json, math
P = lambda *v: np.array(v, float)
# inside (사랑방 model frame), occupancy picks on the frame wood
iTL, iTR = P(-3.123, 1.459, -0.102), P(-2.608, 1.342, -1.46)
iL = [P(-2.947, 0.635, 0.054), P(-3.039, 1.035, -0.023), iTL]          # left edge, bottom -> top
iR = [P(-2.328, -0.085, -1.188), P(-2.403, 0.449, -1.27), P(-2.573, 0.91, -1.381), iTR]
# outside (hq world)
oTL, oTR, oBL, oBR = P(-1.709, 2.034, -2.661), P(-1.651, 2.057, -1.747), P(-1.71, 0.669, -2.63), P(-1.659, 0.673, -1.693)
oL = [oBL, P(-1.722, 1.373, -2.652), P(-1.714, 1.771, -2.657), oTL]
oR = [oBR, P(-1.74, 0.992, -1.753), P(-1.648, 1.369, -1.716), P(-1.631, 1.789, -1.725), oTR]
def edge_dir(pts):
    X = np.array(pts); X = X - X.mean(0); d = np.linalg.svd(X)[2][0]
    return d if d[1] > 0 else -d
def frame(TL, TR, L, R):
    u = TR - TL; u /= np.linalg.norm(u)
    v = edge_dir(L) + edge_dir(R); v -= (v @ u) * u; v /= np.linalg.norm(v)
    return u, v, np.cross(u, v)
ui, vi, ni = frame(iTL, iTR, iL, iR)
uo, vo, no = frame(oTL, oTR, oL, oR)
A = np.stack([ui, vi, ni], 1); B = np.stack([-uo, vo, -no], 1)
R = B @ A.T
s = np.linalg.norm(oTR - oTL) / np.linalg.norm(iTR - iTL)
# room side of the outside door: the side the inside frame's normal... use the model's capture points
tour = json.load(open("scenes/wolhajeong360-sarang/tour.json", encoding="utf8"))
midI, midO = (iTL + iTR) / 2, (oTL + oTR) / 2
t = midO - s * R @ midI
cams = np.array([s * R @ np.array(n["position"]) + t for n in tour["nodes"]])
nroom = no if (cams.mean(0) - midO) @ no > 0 else -no
t = t + nroom * 0.05
f = lambda p: s * R @ p + t
# residuals: inside edge points to the outside opposite edge lines (mirror), top corners to corners
def dist_line(p, pts):
    X = np.array(pts); c = X.mean(0); d = edge_dir(pts); w = p - c; return np.linalg.norm(w - (w @ d) * d)
print("scale", round(s, 4), "| up of model in world: tilt deg", round(math.degrees(math.acos(np.clip((R @ [0, 1, 0])[1], -1, 1))), 2))
print("corner errors (m):", round(np.linalg.norm(f(iTL) - oTR), 3), round(np.linalg.norm(f(iTR) - oTL), 3))
print("inside-left edge -> outside-right edge:", [round(dist_line(f(p), oR), 3) for p in iL])
print("inside-right edge -> outside-left edge:", [round(dist_line(f(p), oL), 3) for p in iR])
floor_in = -0.70
# the 사랑방 floor: a point on the model floor, mapped
fl = f(P(-2.4, floor_in, -0.8)); print("model floor (-0.70) lands at y", round(fl[1], 3), "(door sill outside 0.671)")
# quaternion of R (x, y, z, w)
def quat(M):
    w = math.sqrt(max(0, 1 + M[0,0] + M[1,1] + M[2,2])) / 2
    x = math.copysign(math.sqrt(max(0, 1 + M[0,0] - M[1,1] - M[2,2])) / 2, M[2,1] - M[1,2])
    y = math.copysign(math.sqrt(max(0, 1 - M[0,0] + M[1,1] - M[2,2])) / 2, M[0,2] - M[2,0])
    z = math.copysign(math.sqrt(max(0, 1 - M[0,0] - M[1,1] + M[2,2])) / 2, M[1,0] - M[0,1])
    return [x, y, z, w]
res = {"scale": round(float(s), 5), "quaternion": [round(q, 6) for q in quat(R)], "position": [round(float(v), 4) for v in t], "floorY": floor_in}
print(json.dumps(res))
for n in tour["nodes"]: print(n["id"], np.round(f(np.array(n["position"])), 2).tolist())

