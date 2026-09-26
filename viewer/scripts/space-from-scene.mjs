// Rebuild a space's capture points (nav.json) from a 3DGS scene, so the
// listing app (both conditions: room names, exploration range, plan, tasks)
// follows the scene's world frame. Rerun after a retrain (e.g. when 사랑방 is
// added to wolhajeong360-hq), then bake the plan:
//   node scripts/space-from-scene.mjs <space> <scene> [--labels <file>] [--fps 30] [--spacing 1.4] [--dry]
//   node scripts/bake-plan.mjs <space> <scene>          (dev server running)
//
// Reads  scenes/<scene>/tour.json            capture points (viewer world, floor y = 0)
//        scenes/<scene>/capture_path.json    every registered camera (to add points in rooms the tour skips)
//        room labels: --labels, else data/pano360/<scene>.labels*.json, else the same for <scene> without "-hq"
//          ({segments: [{clip, from, to, room}]}: seconds of each source clip; an image name "c<clip>_<frame>" is frame / fps)
//        scenes/<scene>/lod/occupancy.bin     walls, to link added points only where you can walk straight
// Keeps  from the old nav.json: status (360 readiness), transition, range, doorFx, doors (only if their rooms still exist),
//        and rooms captured as their own model (rooms[].scene + sceneTransform + floorY, e.g. 사랑방): their
//        capture points come from that scene's tour.json, placed in this frame; a region box is made if missing
// Writes viewer/public/spaces/<space>/nav.json   (the old one -> nav.before-<scene>.json the first time)
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const dry = argv.includes("--dry") && argv.splice(argv.indexOf("--dry"), 1);
const labelsArg = flag("--labels", null);
const fps = +flag("--fps", "30");
const spacing = +flag("--spacing", "1.4");
const [space, scene] = argv;
if (!space || !scene) { console.error("usage: space-from-scene.mjs <space> <scene> [--labels file] [--fps 30] [--spacing 1.4] [--dry]"); process.exit(1); }
const root = path.resolve(import.meta.dirname, "../..");
const sceneDir = path.join(root, "scenes", scene);
const spaceDir = path.join(root, "viewer/public/spaces", space);
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const tour = read(path.join(sceneDir, "tour.json"));
const capPath = path.join(sceneDir, "capture_path.json");
const cap = fs.existsSync(capPath) ? read(capPath) : null;
const oldNav = fs.existsSync(path.join(spaceDir, "nav.json")) ? read(path.join(spaceDir, "nav.json")) : {};

// ---- room labels
const findLabels = () => {
  if (labelsArg) return labelsArg;
  const dir = path.join(root, "data/pano360");
  for (const b of [scene, scene.replace(/-hq$/, "")]) {
    const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(`${b}.labels`) && n.endsWith(".json")).sort() : [];
    if (f.length) return path.join(dir, f[0]);
  }
  return null;
};
const labelsFile = findLabels();
const labels = labelsFile ? read(labelsFile) : { default: "공간", segments: [] };
const cleanName = (s) => String(s || "").replace(/^\?+\s*/, "").replace(/\s*\(.*\)\s*$/, "").trim();
const SLUG = { 앞마당: "yard", "안채 거실": "living", "어두운 실내": "dark", 대문: "gate", 대문간: "gate", "별채 사랑방": "sarang", 사랑방: "sarang", "안채 침실": "bedroom", 부엌: "kitchen", 욕실: "bath" };
const roomIds = new Map(); // name -> id
const roomId = (name) => {
  if (!roomIds.has(name)) {
    let id = SLUG[name] || `room${roomIds.size + 1}`;
    while ([...roomIds.values()].includes(id)) id += "2";
    roomIds.set(name, id);
  }
  return roomIds.get(name);
};
const roomOfImage = (img) => {
  const m = /c(\d+)_(\d+)/.exec(img || "");
  if (!m) return cleanName(labels.default);
  const clip = +m[1], s = +m[2] / fps;
  const seg = (labels.segments || []).find((g) => g.clip === clip && s >= g.from && s < g.to);
  return cleanName(seg?.room || labels.default);
};

// ---- walls (for linking added points) and floor heights
let solidAt = () => false, voxel = 0.08;
const occFile = path.join(sceneDir, "lod/occupancy.bin");
if (fs.existsSync(occFile)) {
  const u8 = new Uint8Array(fs.readFileSync(occFile));
  const hl = new DataView(u8.buffer, u8.byteOffset).getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  const bits = u8.subarray(8 + hl);
  voxel = h.voxel;
  solidAt = (x, y, z) => {
    const X = Math.floor((x - h.min[0]) / h.voxel), Y = Math.floor((y - h.min[1]) / h.voxel), Z = Math.floor((z - h.min[2]) / h.voxel);
    if (X < 0 || Y < 0 || Z < 0 || X >= h.nx || Y >= h.ny || Z >= h.nz) return false;
    const i = (Y * h.nz + Z) * h.nx + X;
    return ((bits[i >> 3] >> (i & 7)) & 1) === 1;
  };
}
const clearLine = (a, b) => {
  const d = Math.hypot(b[0] - a[0], b[2] - a[2]), n = Math.ceil(d / 0.04);
  for (let i = 2; i < n - 1; i++) {
    const t = i / n, x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
    for (const y of [0.6, 1.0, 1.4]) if (solidAt(x, y, z)) return false;
  }
  return true;
};

// ---- capture points: the tour's, then cameras in rooms the tour has none in
const eye = tour.eyeHeight ?? 1.45;
const r3 = (v) => +v.toFixed(4);
const nodes = tour.nodes.map((n) => ({
  id: n.id,
  room: roomId(roomOfImage(n.image)),
  position: [r3(n.position[0]), r3((n.floorY ?? 0) + eye), r3(n.position[2])],
  imageYawDeg: +(((n.yaw ?? 0) * 180) / Math.PI).toFixed(1),
  neighbors: [],
  from: n.image || null,
}));
const byId = new Map(nodes.map((n) => [n.id, n]));
for (const [a, b] of tour.edges || []) { byId.get(a)?.neighbors.push(b); byId.get(b)?.neighbors.push(a); }
const covered = new Set(nodes.map((n) => n.room));
const added = [];
if (cap?.cameras?.length) {
  const byRoom = new Map();
  for (const c of cap.cameras) {
    const name = roomOfImage(c.name);
    if (covered.has(roomId(name))) continue;
    if (!byRoom.has(name)) byRoom.set(name, []);
    byRoom.get(name).push(c);
  }
  let k = 0;
  for (const [name, cams] of byRoom) {
    // greedy: keep a camera when it is `spacing` away from every kept point of that room
    const kept = [];
    for (const c of cams) if (kept.every((o) => Math.hypot(o.position[0] - c.position[0], o.position[2] - c.position[2]) >= spacing)) kept.push(c);
    for (const c of kept) {
      const n = { id: `c${++k}`, room: roomId(name), position: [r3(c.position[0]), r3(eye), r3(c.position[2])], imageYawDeg: +(((c.yaw ?? 0) * 180) / Math.PI).toFixed(1), neighbors: [], from: c.name, added: true };
      nodes.push(n); byId.set(n.id, n); added.push(n);
    }
  }
}
// link added points to their nearest neighbours that are in plain sight (<= 3 m)
const dist = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
const link = (a, b) => { if (!a.neighbors.includes(b.id)) a.neighbors.push(b.id); if (!b.neighbors.includes(a.id)) b.neighbors.push(a.id); };
for (const n of added) {
  const near = nodes.filter((o) => o !== n).sort((a, b) => dist(n, a) - dist(n, b));
  let links = 0;
  for (const o of near) {
    if (dist(n, o) > 3 || links >= 3) break;
    if (clearLine(n.position, o.position)) { link(n, o); links++; }
  }
}
// everything reachable from the start: join stray groups by their closest pair
const start = tour.start || nodes[0].id;
for (let guard = 0; guard < nodes.length; guard++) {
  const seen = new Set([start]), st = [start];
  while (st.length) for (const m of byId.get(st.pop()).neighbors) if (!seen.has(m)) { seen.add(m); st.push(m); }
  const out = nodes.filter((n) => !seen.has(n.id));
  if (!out.length) break;
  let best = null;
  for (const a of out) for (const b of nodes.filter((n) => seen.has(n.id))) { const d = dist(a, b); if (!best || d < best.d) best = { a, b, d }; }
  link(best.a, best.b);
  console.warn(`joined ${best.a.id} (${best.a.room}) to ${best.b.id} across ${best.d.toFixed(2)} m (no straight clear line)`);
}

// ---- floor under each point (the tour's floorY is one plane for the whole
// capture; a hanok 거실/마루 is 0.6-0.7 m above the courtyard). Median of the
// highest surface below the knees in a 0.6 m disc (minus the grid's one-voxel
// growth), then grouped into levels 20 cm apart; the lowest level keeps the
// tour's floor exactly.
const floorOf = (x, z) => {
  const tops = [];
  for (let dz = -0.3; dz <= 0.301; dz += 0.1)
    for (let dx = -0.3; dx <= 0.301; dx += 0.1) {
      if (dx * dx + dz * dz > 0.09) continue;
      for (let y = 1.1; y > -0.6; y -= voxel / 2) if (solidAt(x + dx, y, z + dz)) { tops.push(y - voxel); break; }
    }
  tops.sort((a, b) => a - b);
  return tops.length >= 5 ? tops[Math.floor(tops.length / 2)] : null;
};
const base = Math.min(...tour.nodes.map((n) => n.floorY ?? 0));
const raw = nodes.map((n) => floorOf(n.position[0], n.position[2]));
const levels = [];
for (const v of raw.filter((v) => v !== null).sort((a, b) => a - b)) {
  const L = levels.at(-1);
  if (L && v - L.max <= 0.2) { L.vals.push(v); L.max = v; } else levels.push({ vals: [v], max: v });
}
const lvl = levels.map((L) => L.vals[Math.floor(L.vals.length / 2)]);
const floorAt = (v) => {
  if (v === null) return base;
  const i = levels.findIndex((L) => L.vals.includes(v));
  return i === 0 || lvl[i] - base < 0.25 ? base : +lvl[i].toFixed(2);
};
nodes.forEach((n, i) => { const f = floorAt(raw[i]); n.floorY = f; n.position[1] = r3(f + eye); });
// an added point whose floor is not its room's floor was labelled by time at
// a doorway (labels are approximate): leave it out
for (const n of [...added]) {
  const same = nodes.filter((o) => o.room === n.room).map((o) => o.floorY).sort((a, b) => a - b);
  const med = same[Math.floor(same.length / 2)];
  if (Math.abs(n.floorY - med) > 0.25) {
    nodes.splice(nodes.indexOf(n), 1); added.splice(added.indexOf(n), 1); byId.delete(n.id);
    for (const o of nodes) o.neighbors = o.neighbors.filter((m) => m !== n.id);
    console.warn(`dropped ${n.id} (${n.room}): floor ${n.floorY} m, its room's is ${med} m`);
  }
}
console.log("floors:", nodes.map((n, i) => `${n.id}=${n.floorY}${raw[i] === null ? "?" : ""}`).join(" "));

// ---- rooms captured as their own 3DGS model (portal rooms), placed by their sceneTransform
const modelRooms = (oldNav.rooms || []).filter((r) => r.scene && r.scene !== scene && r.sceneTransform);
for (const r of modelRooms) {
  const t2 = read(path.join(root, "scenes", r.scene, "tour.json"));
  const xf = r.sceneTransform;
  const q = xf.quaternion ? new THREE.Quaternion().fromArray(xf.quaternion).normalize() : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((xf.yawDeg || 0) * Math.PI) / 180);
  const M = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(xf.position), q, new THREE.Vector3(xf.scale, xf.scale, xf.scale));
  const yaw = new THREE.Euler().setFromQuaternion(q, "YXZ").y;
  const pre = r.id.slice(0, 1);
  const ids = new Map();
  for (const n of t2.nodes) {
    const p = new THREE.Vector3().fromArray(n.position).applyMatrix4(M);
    const id = `${pre}${n.id.replace(/^n/, "")}`;
    ids.set(n.id, id);
    const node = { id, room: r.id, position: [r3(p.x), r3(r.floorY + eye), r3(p.z)], imageYawDeg: +((((n.yaw ?? 0) + yaw) * 180) / Math.PI).toFixed(1), neighbors: [], from: `${r.scene}:${n.image || n.id}`, floorY: r.floorY };
    nodes.push(node); byId.set(id, node);
  }
  for (const [a, b] of t2.edges || []) link(byId.get(ids.get(a)), byId.get(ids.get(b)));
  if (!roomIds.has(r.name)) roomIds.set(r.name, r.id);
  // through its door(s): join the room point nearest the door to the nearest point outside it
  for (const d of (oldNav.doors || []).filter((dd) => dd.toRoom === r.id || dd.fromRoom === r.id)) {
    const dp = { position: d.position };
    const inside = nodes.filter((n) => n.room === r.id).sort((a, b) => dist(a, dp) - dist(b, dp))[0];
    const outside = nodes.filter((n) => n.room !== r.id && !modelRooms.some((m) => m.id === n.room)).sort((a, b) => dist(a, dp) - dist(b, dp))[0];
    if (inside && outside) { link(inside, outside); console.log(`${r.name}: ${inside.id} <-> ${outside.id} through ${d.id}`); }
  }
  // region: where this model is drawn instead of the space's (a box from its door plane over its capture points)
  if (!r.region) {
    const d = (oldNav.doors || []).find((dd) => dd.toRoom === r.id);
    const inRoom = nodes.filter((n) => n.room === r.id);
    const yawD = d ? (d.yaw * Math.PI) / 180 : 0;
    const nx = -Math.sin(yawD), nz = -Math.cos(yawD), tx = Math.cos(yawD), tz = -Math.sin(yawD);
    const o = d ? d.position : inRoom[0].position;
    const loc = inRoom.map((n) => [(n.position[0] - o[0]) * tx + (n.position[2] - o[2]) * tz, (n.position[0] - o[0]) * nx + (n.position[2] - o[2]) * nz]);
    const l0 = Math.min(...loc.map((v) => v[0])) - 1.3, l1 = Math.max(...loc.map((v) => v[0])) + 1.3;
    const d0 = 0.04, d1 = Math.max(...loc.map((v) => v[1])) + 1.2;
    const cl = (l0 + l1) / 2, cd = (d0 + d1) / 2;
    r.region = { center: [r3(o[0] + tx * cl + nx * cd), r3(r.floorY + 1.2), r3(o[2] + tz * cl + nz * cd)], size: [r3(l1 - l0), 3.0, r3(d1 - d0)], yaw: d ? d.yaw : 0, note: "made by space-from-scene.mjs: from the door plane over the room's capture points (+1.2-1.3 m)" };
  }
}

// ---- rooms, doors, nav
const rooms = [...roomIds].map(([name, id]) => ({ id, name, ...(modelRooms.find((m) => m.id === id) ? (({ id: _i, name: _n, ...rest }) => rest)(modelRooms.find((m) => m.id === id)) : {}) })).filter((r) => nodes.some((n) => n.room === r.id));
const keepDoors = (oldNav.doors || []).filter((d) => rooms.some((r) => r.id === d.fromRoom) && rooms.some((r) => r.id === d.toRoom));
const nav = {
  version: 1,
  about: oldNav.about || "촬영 지점 = 360° 시점 탐색의 핫스팟 그래프이자 두 조건 공통의 공간 명칭·탐색 범위·평면도 기준. 좌표는 3DGS 장면 좌표(미터, y 위, 시선 -Z가 yaw 0). imageYawDeg = 파노라마 가운데 열이 바라보는 방향(도, 왼쪽으로 돌면 +).",
  scene,
  generated: { by: "viewer/scripts/space-from-scene.mjs", at: new Date().toISOString(), from: `scenes/${scene}/tour.json${cap ? " + capture_path.json" : ""}`, labels: labelsFile ? path.relative(root, labelsFile).replace(/\\/g, "/") : null, addedPoints: added.length },
  status: { ...(oldNav.status || {}), ready: false, devPlaceholder: true, note: `촬영 지점은 3DGS ${scene}의 좌표계(자동 생성). 360 원본 파노라마는 아직 이 좌표계에 맞춰 넣지 않아 360° 조건은 준비 중.` },
  transition: oldNav.transition || { style: "warp", duration: 0.8 },
  range: oldNav.range || { radius: 1.5 },
  start,
  rooms,
  // floorY: the floor under the point (the 3DGS app uses it for eye height and walking levels)
  nodes: nodes.map(({ from, added: ad, ...n }) => ({ ...n, source: from || undefined, ...(ad ? { added: true } : {}) })),
  ...(oldNav.doorFx ? { doorFx: oldNav.doorFx } : {}),
  ...(keepDoors.length ? { doors: keepDoors } : {}),
};
const counts = Object.fromEntries(rooms.map((r) => [r.name, nodes.filter((n) => n.room === r.id).length]));
console.log(`${space} <- ${scene}: ${nodes.length} points (${added.length} added from cameras), rooms ${JSON.stringify(counts)}, start ${start}, labels ${labelsFile ? path.basename(labelsFile) : "none"}`);
if (!dry) {
  const bak = path.join(spaceDir, `nav.before-${scene}.json`);
  if (!fs.existsSync(bak) && fs.existsSync(path.join(spaceDir, "nav.json")) && oldNav.scene !== scene) fs.copyFileSync(path.join(spaceDir, "nav.json"), bak);
  fs.writeFileSync(path.join(spaceDir, "nav.json"), JSON.stringify(nav, null, 1) + "\n");
}
