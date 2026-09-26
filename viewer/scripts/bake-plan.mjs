// Floor plan of a space for both viewers (the same image in the 360° and the
// 3DGS condition): room shapes and walls from the scene's occupancy grid,
// rooms named after nav.json (each floor cell takes the room of its nearest
// capture point), drawn as a clean light-theme architectural plan.
//   node scripts/bake-plan.mjs <space> [scene=<space>] [pxPerBin=24] [--rotation <deg>] [--bin 0.25]
// The plan is north-up in its own frame: aligned with the walls, unless
// --rotation says otherwise (set it so that true north is up, if known).
// Reads  /scenes/<scene>/tour.json + lod/occupancy.bin (the grid baked for phones)
//        /spaces/<space>/nav.json
// Writes public/spaces/<space>/plan.png        styled plan (transparent outside)
//        public/spaces/<space>/plan-rooms.png  one exact colour per room (for highlighting)
//        public/spaces/<space>/plan.json       frame, scale, room colours and label points
// Needs the dev server (VIEWER_URL, default http://localhost:5190). Re-run when
// nav.json changes (room names/positions) or the scene is retrained.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const rotArg = flag("--rotation", null);
const binArg = flag("--bin", "0.25");
const [space = "drjohnson", scene = space, pxArg = "24"] = argv;
const base = process.env.VIEWER_URL || "http://localhost:5190";
const dir = path.resolve(import.meta.dirname, `../public/spaces/${space}`);

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`${base}/home.html`);
const res = await page.evaluate(async ({ space, scene, P, ROT, q }) => {
  const { Occupancy } = await import("/src/occupancy.js");
  const { loadTour } = await import("/src/tour.js");
  const tour = await loadTour(new URL(`/scenes/${scene}/`, location.href));
  const r = await fetch(`/scenes/${scene}/lod/occupancy.bin`);
  if (!r.ok) throw new Error(`no /scenes/${scene}/lod/occupancy.bin (bake it: node scripts/bake-lod-aux.mjs ${scene})`);
  const o = Occupancy.fromBuffer(await r.arrayBuffer());
  const nav = await (await fetch(`/spaces/${space}/nav.json`)).json();
  const v = o.voxel, nx = o.nx, nz = o.nz, N = nx * nz;
  const floors = tour.nodes.map((n) => n.floorY).sort((a, b) => a - b);
  const fy = floors[floors.length >> 1];
  const yi = (y) => Math.floor((y - o.box.min.y) / v);

  // ---------- cell masks on the scene's grid ----------
  const band = (y0, y1) => {
    const m = new Uint8Array(N);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++)
      for (let y = Math.max(0, yi(y0)); y <= Math.min(o.ny - 1, yi(y1)); y++) if (o.solid[(y * nz + z) * nx + x]) { m[z * nx + x] = 1; break; }
    return m;
  };
  const dilate = (m, rad) => {
    const out = new Uint8Array(N);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      if (!m[z * nx + x]) continue;
      for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
        if (dx * dx + dz * dz > rad * rad) continue;
        const X = x + dx, Z = z + dz;
        if (X >= 0 && Z >= 0 && X < nx && Z < nz) out[Z * nx + X] = 1;
      }
    }
    return out;
  };
  const not = (m) => m.map((a) => 1 - a);
  const erode = (m, rad) => not(dilate(not(m), rad));
  const and = (a, b) => a.map((x, i) => x & b[i]);
  const flood = (seedCells, pass) => {
    const out = new Uint8Array(N), st = [];
    for (const i of seedCells) if (i >= 0 && pass[i] && !out[i]) { out[i] = 1; st.push(i); }
    while (st.length) {
      const i = st.pop(), x = i % nx, z = (i - x) / nx;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
        const j = Z * nx + X;
        if (pass[j] && !out[j]) { out[j] = 1; st.push(j); }
      }
    }
    return out;
  };
  const cellAt = (x, z) => { const X = Math.floor((x - o.box.min.x) / v), Z = Math.floor((z - o.box.min.z) / v); return X < 0 || Z < 0 || X >= nx || Z >= nz ? -1 : Z * nx + X; };

  const O = band(fy + 0.3, fy + 1.8); // body height: walls, furniture
  const F = erode(dilate(band(fy - 0.3, fy + 0.15), 3), 3); // floor, small holes closed
  const free = and(F, not(O));
  const seeds = nav.nodes.map((n) => {
    const [cx, cz] = [Math.floor((n.position[0] - o.box.min.x) / v), Math.floor((n.position[2] - o.box.min.z) / v)];
    let best = -1, bd = 1e9;
    const R = Math.ceil(1 / v);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const X = cx + dx, Z = cz + dz;
      if (X < 0 || Z < 0 || X >= nx || Z >= nz || !free[Z * nx + X]) continue;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = Z * nx + X; }
    }
    return best;
  });
  let inside = flood(seeds, free);
  // Raised floors (nav floorY from scripts/space-from-scene.mjs, e.g. a 거실
  // 0.7 m above the courtyard): the same flood at that height, a little looser
  // (interiors reconstruct noisier), seeded by the points standing there.
  const eyeH = tour.eyeHeight ?? 1.45;
  const upper = [...new Set(nav.nodes.map((n) => n.floorY ?? +(n.position[1] - eyeH).toFixed(2)).filter((y) => y - fy > 0.25))];
  for (const L of upper) {
    const freeL = and(erode(dilate(band(L - 0.2, L + 0.3), 3), 3), not(band(L + 0.45, L + 1.6)));
    const seedsL = nav.nodes.filter((n) => Math.abs((n.floorY ?? n.position[1] - eyeH) - L) < 0.1).map((n) => {
      const [cx, cz] = [Math.floor((n.position[0] - o.box.min.x) / v), Math.floor((n.position[2] - o.box.min.z) / v)];
      let best = -1, bd = 1e9;
      const R = Math.ceil(1 / v);
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const X = cx + dx, Z = cz + dz;
        if (X < 0 || Z < 0 || X >= nx || Z >= nz || !freeL[Z * nx + X]) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = Z * nx + X; }
      }
      return best;
    });
    const inL = flood(seedsL, freeL);
    for (let i = 0; i < N; i++) if (inL[i]) inside[i] = 1;
  }
  inside = erode(dilate(inside, 4), 4); // close gaps
  const border = [];
  for (let x = 0; x < nx; x++) border.push(x, (nz - 1) * nx + x);
  for (let z = 0; z < nz; z++) border.push(z * nx, z * nx + nx - 1);
  inside = not(flood(border, not(inside))); // fill furniture holes
  const clipR = (nav.range?.radius ?? 2) + 2.5; // only around the explored area (same in both conditions)
  for (let i = 0; i < N; i++) {
    if (!inside[i]) continue;
    const x = i % nx, z = (i - x) / nx;
    const wx = o.box.min.x + (x + 0.5) * v, wz = o.box.min.z + (z + 0.5) * v;
    if (!nav.nodes.some((n) => (n.position[0] - wx) ** 2 + (n.position[2] - wz) ** 2 <= clipR * clipR)) inside[i] = 0;
  }
  const furn = and(O, erode(inside, 2));
  const roomIds = [...new Set([...(nav.rooms || []).map((rr) => rr.id), ...nav.nodes.map((n) => n.room)])];
  const label = new Int16Array(N).fill(-1);
  const pts = [];
  for (let i = 0; i < N; i++) {
    if (!inside[i]) continue;
    const x = i % nx, z = (i - x) / nx;
    const wx = o.box.min.x + (x + 0.5) * v, wz = o.box.min.z + (z + 0.5) * v;
    let best = null, bd = 1e9;
    for (const n of nav.nodes) { const d = (n.position[0] - wx) ** 2 + (n.position[2] - wz) ** 2; if (d < bd) { bd = d; best = n; } }
    label[i] = roomIds.indexOf(best.room);
    pts.push([wx, wz]);
  }

  // ---------- plan frame: aligned with the walls (shortest outline on a coarse grid) ----------
  const perim = (th) => {
    const c = Math.cos(th), s = Math.sin(th), set = new Set();
    for (const [x, z] of pts) set.add(`${Math.floor((x * c + z * s) / 0.24)},${Math.floor((-x * s + z * c) / 0.24)}`);
    let n = 0;
    for (const k of set) { const [a, b] = k.split(",").map(Number); for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!set.has(`${a + da},${b + db}`)) n++; }
    return n;
  };
  let th = 0;
  if (ROT !== null) th = (ROT * Math.PI) / 180;
  else {
    let bp = Infinity;
    for (let d = 0; d < 90; d += 0.5) { const p = perim((d * Math.PI) / 180); if (p < bp) { bp = p; th = (d * Math.PI) / 180; } }
    // of the two wall-aligned frames, the wider one (phones in landscape, bottom sheets)
    const ext = (t) => { const cc = Math.cos(t), sn = Math.sin(t); let a = [Infinity, -Infinity, Infinity, -Infinity]; for (const [x, z] of pts) { const u = x * cc + z * sn, w = -x * sn + z * cc; a = [Math.min(a[0], u), Math.max(a[1], u), Math.min(a[2], w), Math.max(a[3], w)]; } return (a[1] - a[0]) / (a[3] - a[2]); };
    if (ext(th) < 1) th += Math.PI / 2;
  }
  const c = Math.cos(th), s = Math.sin(th);
  const toPlan = (x, z) => [x * c + z * s, -x * s + z * c];
  const toWorld = (u, w) => [u * c - w * s, u * s + w * c];

  // ---------- coarse bins (q metres): majority of 4x4 samples ----------
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (const [x, z] of pts) { const [u, w] = toPlan(x, z); u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
  u0 -= 0.6; w0 -= 0.6; u1 += 0.6; w1 += 0.6;
  const bu = Math.ceil((u1 - u0) / q), bw = Math.ceil((w1 - w0) / q);
  const room = new Int16Array(bu * bw).fill(-1), fb = new Uint8Array(bu * bw);
  for (let j = 0; j < bw; j++) for (let i = 0; i < bu; i++) {
    const votes = new Map();
    let fur = 0, n = 0;
    for (let sj = 0; sj < 4; sj++) for (let si = 0; si < 4; si++) {
      const [x, z] = toWorld(u0 + (i + (si + 0.5) / 4) * q, w0 + (j + (sj + 0.5) / 4) * q);
      const k = cellAt(x, z);
      if (k < 0 || !inside[k]) continue;
      n++;
      votes.set(label[k], (votes.get(label[k]) || 0) + 1);
      if (furn[k]) fur++;
    }
    if (n < 8) continue;
    let bk = -1, bv = 0;
    for (const [k, vv] of votes) if (vv > bv) { bv = vv; bk = k; }
    room[j * bu + i] = bk;
    fb[j * bu + i] = fur >= 8 ? 1 : 0;
  }
  for (let pass = 0; pass < 3; pass++) { // drop one-bin notches and islands
    const cp = room.slice();
    for (let j = 1; j < bw - 1; j++) for (let i = 1; i < bu - 1; i++) {
      const nb = [cp[j * bu + i - 1], cp[j * bu + i + 1], cp[(j - 1) * bu + i], cp[(j + 1) * bu + i]];
      const ins = nb.filter((k) => k >= 0).length;
      if (cp[j * bu + i] < 0 && ins >= 3) room[j * bu + i] = nb.find((k) => k >= 0);
      if (cp[j * bu + i] >= 0 && ins <= 1) room[j * bu + i] = -1;
    }
  }

  // ---------- draw ----------
  const W = bu * P, H = bw * P;
  const mk = () => { const cv = document.createElement("canvas"); cv.width = W; cv.height = H; return cv; };
  const cv = mk(), iv = mk(), g = cv.getContext("2d"), gi = iv.getContext("2d");
  const PAL = ["#F4E9D8", "#E2ECDE", "#E0E8F3", "#F3E2E0", "#ECE4F2", "#F2EED6", "#DCEEEC", "#EEE6DE"];
  const FUR = ["#EADCC6", "#D3E0CE", "#D0DAE9", "#E8D2CE", "#DFD3E8", "#E7E1C2", "#CBE3DF", "#E2D7CA"];
  const at = (i, j) => (i < 0 || j < 0 || i >= bu || j >= bw ? -1 : room[j * bu + i]);
  for (let j = 0; j < bw; j++) for (let i = 0; i < bu; i++) {
    const k = at(i, j);
    if (k < 0) continue;
    g.fillStyle = (fb[j * bu + i] ? FUR : PAL)[k % PAL.length];
    g.fillRect(i * P, j * P, P, P);
    gi.fillStyle = `rgb(${10 * (k + 1)},0,0)`;
    gi.fillRect(i * P, j * P, P, P);
  }
  const WALL = Math.max(3, Math.round(P * 0.34)), DIV = Math.max(2, Math.round(P * 0.13));
  const seg = (x, y, horiz, t, col) => { g.fillStyle = col; if (horiz) g.fillRect(x, y - t / 2, P, t); else g.fillRect(x - t / 2, y, t, P); };
  // room dividers first, walls on top
  for (const wallPass of [false, true])
    for (let j = 0; j <= bw; j++) for (let i = 0; i <= bu; i++) {
      for (const [a, b, horiz] of [[at(i - 1, j), at(i, j), false], [at(i, j - 1), at(i, j), true]]) {
        if (a === b) continue;
        const isWall = a < 0 || b < 0;
        if (isWall !== wallPass) continue;
        if (!horiz && j >= bw) continue;
        if (horiz && i >= bu) continue;
        seg(i * P, j * P, horiz, isWall ? WALL : DIV, isWall ? "#4A453E" : "rgba(255,255,255,0.96)");
      }
    }
  for (let j = 0; j <= bw; j++) for (let i = 0; i <= bu; i++) { // wall corners
    const ins = [at(i - 1, j - 1), at(i, j - 1), at(i - 1, j), at(i, j)].filter((k) => k >= 0).length;
    if (ins > 0 && ins < 4) { g.fillStyle = "#4A453E"; g.fillRect(i * P - WALL / 2, j * P - WALL / 2, WALL, WALL); }
  }
  const png = (cnv) => cnv.toDataURL("image/png").split(",")[1];
  const labels = {};
  roomIds.forEach((id, k) => {
    let su = 0, sw = 0, n = 0;
    for (let j = 0; j < bw; j++) for (let i = 0; i < bu; i++) if (room[j * bu + i] === k) { su += i; sw += j; n++; }
    if (!n) return;
    const cu = su / n, cw = sw / n;
    let best = null, bd = 1e9;
    for (let j = 0; j < bw; j++) for (let i = 0; i < bu; i++) if (room[j * bu + i] === k) {
      const d = (i - cu) ** 2 + (j - cw) ** 2;
      if (d < bd) { bd = d; best = [i, j]; }
    }
    labels[id] = toWorld(u0 + (best[0] + 0.5) * q, w0 + (best[1] + 0.5) * q).map((t) => +t.toFixed(3));
  });
  return {
    png: png(cv), idx: png(iv), size: [W, H], rotationDeg: +((th * 180) / Math.PI).toFixed(1),
    json: {
      version: 1, scene, bakedAt: new Date().toISOString(),
      about: "Plan frame: u = x cos r + z sin r, w = -x sin r + z cos r (metres, scene coordinates); image pixel = ((u - bounds[0]) * pxPerM, (w - bounds[1]) * pxPerM). Up on the plan = -w.",
      rotation: +th.toFixed(5), bounds: [u0, w0, u0 + bu * q, w0 + bw * q].map((t) => +t.toFixed(3)),
      pxPerM: +(P / q).toFixed(3), image: "plan.png", roomImage: "plan-rooms.png",
      rooms: Object.fromEntries(roomIds.filter((id) => labels[id]).map((id) => [id, { color: 10 * (roomIds.indexOf(id) + 1), label: labels[id] }])),
    },
  };
}, { space, scene, P: +pxArg, ROT: rotArg === null ? null : +rotArg, q: +binArg });
fs.writeFileSync(path.join(dir, "plan.png"), Buffer.from(res.png, "base64"));
fs.writeFileSync(path.join(dir, "plan-rooms.png"), Buffer.from(res.idx, "base64"));
fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(res.json, null, 1));
console.log(JSON.stringify({ size: res.size, rotationDeg: res.rotationDeg, rooms: Object.keys(res.json.rooms), bounds: res.json.bounds }));
await browser.close();
