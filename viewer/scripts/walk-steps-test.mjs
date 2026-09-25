// Step-up walking on a synthetic occupancy grid (no browser): a courtyard at
// 0 m, a 마루 0.5 m up with a capture point standing on it, a 댓돌 (0.25 m
// stone) in front of it, and things that must NOT become steps: a solid chest
// on the courtyard floor, a chair (seat on legs), a table top at 마루 height,
// a 0.8 m block, and a second platform 0.75 m up (higher than a step).
//   node scripts/walk-steps-test.mjs      -> prints checks, exits 1 on failure
// Also used by scripts/steps-check.mjs (same scene, injected into a real view).
import * as THREE from "three";
import { WalkMap } from "../src/walk.js";

export function syntheticScene({ stone = true } = {}) {
  const v = 0.08, min = new THREE.Vector3(-4, -0.5, -4);
  const nx = 100, ny = 45, nz = 100; // 8 x 3.6 x 8 m
  const solid = new Uint8Array(nx * ny * nz);
  const box = (x0, x1, y0, y1, z0, z1) => {
    const I = (w, m) => Math.floor((w - m) / v);
    for (let y = Math.max(0, I(y0, min.y)); y <= Math.min(ny - 1, I(y1 - 1e-4, min.y)); y++)
      for (let z = Math.max(0, I(z0, min.z)); z <= Math.min(nz - 1, I(z1 - 1e-4, min.z)); z++)
        for (let x = Math.max(0, I(x0, min.x)); x <= Math.min(nx - 1, I(x1 - 1e-4, min.x)); x++) solid[(y * nz + z) * nx + x] = 1;
  };
  const parts = [];
  const add = (name, b) => { parts.push({ name, b }); box(...b); };
  add("floor", [-4, 4, -0.16, 0, -4, 4]);
  add("walls", [-4, -3.8, 0, 3, -4, 4]); add("walls", [3.8, 4, 0, 3, -4, 4]); add("walls", [-4, 4, 0, 3, -4, -3.8]); add("walls", [-4, 4, 0, 3, 3.8, 4]);
  add("maru", [-3.8, 3.8, 0, 0.5, -3.8, -1.5]); // 마루 along the back, 0.5 m up
  if (stone) add("stone", [0.6, 1.2, 0, 0.25, -1.5, -1.0]); // 댓돌 in front of it, a little off the straight line
  add("chest", [2.4, 3.2, 0, 0.5, 1.5, 2.0]); // solid, on the courtyard
  add("chair-seat", [-2.6, -2.1, 0.4, 0.48, 1.6, 2.1]); // seat on legs
  for (const [x, z] of [[-2.6, 1.6], [-2.18, 1.6], [-2.6, 2.02], [-2.18, 2.02]]) add("chair-leg", [x, x + 0.08, 0, 0.4, z, z + 0.08]);
  add("chair-back", [-2.6, -2.1, 0.48, 0.95, 2.02, 2.1]);
  add("table-top", [-1.2, 0.2, 0.44, 0.52, 2.4, 3.2]); // at 마루 height, on legs
  for (const [x, z] of [[-1.2, 2.4], [0.12, 2.4], [-1.2, 3.12], [0.12, 3.12]]) add("table-leg", [x, x + 0.08, 0, 0.44, z, z + 0.08]);
  add("block", [1.6, 2.2, 0, 0.8, 0.2, 0.8]); // too high to step onto
  add("high-deck", [-3.8, -2.4, 0, 0.75, -1.5, 0.2]); // a deck higher than a step
  const occ = { voxel: v, box: new THREE.Box3(min, min.clone().add(new THREE.Vector3(nx * v, ny * v, nz * v))), nx, ny, nz, solid };
  occ.occupied = (p) => {
    const x = Math.floor((p.x - min.x) / v), y = Math.floor((p.y - min.y) / v), z = Math.floor((p.z - min.z) / v);
    return x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && solid[(y * nz + z) * nx + x] === 1;
  };
  const node = (id, x, z, fy) => ({ id, position: new THREE.Vector3(x, fy + 1.45, z), floorY: fy });
  const tour = { nodes: [node("yard", 0, 1.8, 0), node("yard2", 2.5, -0.6, 0), node("maru", 0, -2.8, 0.5)] };
  return { occ, tour, parts };
}

function run() {
  globalThis.performance ??= { now: () => Date.now() };
  const res = [];
  const check = (name, ok, info = "") => { res.push({ name, ok }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`); };
  const { occ, tour } = syntheticScene();
  const W = new WalkMap(occ, tour);
  const g = W.level(0);
  const H = (x, z) => W.heightAt(g, x, z);
  check("courtyard is floor at 0 m", H(0, 1.0) === 0);
  check("마루 is floor at 0.5 m", Math.abs(H(0, -2.6) - 0.5) < 1e-6, `h=${H(0, -2.6)}`);
  check("댓돌 is a step (~0.25 m)", Math.abs(H(0.9, -1.25) - 0.24) < 0.06, `h=${H(0.9, -1.25)?.toFixed(3)}`);
  for (const [name, x, z] of [["chest", 2.8, 1.75], ["chair", -2.35, 1.85], ["table", -0.5, 2.8], ["0.8 m block", 1.9, 0.5], ["0.75 m deck", -3.1, -0.6]]) check(`${name} is not walkable`, Number.isNaN(H(x, z)));
  const a = tour.nodes[0].position, b = tour.nodes[2].position;
  const r = W.route(g, a, b);
  check("route courtyard -> 마루 exists", !!r);
  // floors met along the route (sampled every 4 cm)
  const along = (W, g, r) => {
    const out = [];
    for (let i = 1; i < r.length; i++) {
      const [ax, az] = r[i - 1], [bx, bz] = r[i], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.04);
      for (let k = 0; k <= n; k++) { const h = +W.heightAt(g, ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n).toFixed(2); if (out.at(-1) !== h) out.push(h); }
    }
    return out;
  };
  const hs = r ? along(W, g, r) : [];
  check("route climbs by the 댓돌 (0 -> 0.25 -> 0.5)", hs.some((h) => h > 0.1 && h < 0.4) && Math.max(...hs.slice(1).map((h, i) => Math.abs(h - hs[i]))) < 0.3, `floors along the way ${hs.join(" ")}, ${r?.length} waypoints`);
  // no stone: one 0.5 m step, still walkable
  const s2 = syntheticScene({ stone: false });
  const W2 = new WalkMap(s2.occ, s2.tour), g2 = W2.level(0);
  const r2 = W2.route(g2, a, b);
  check("without the 댓돌: one 0.5 m step up", !!r2 && Math.abs(r2.at(-1)[2] - 0.5) < 1e-6, r2 ? `floors along the way ${along(W2, g2, r2).join(" ")}` : "no route");
  // the 0.75 m deck can't be reached
  check("0.75 m deck unreachable", !W.route(g, a, new THREE.Vector3(-3.1, 2.2, -0.6), { snap: 0.1 }));
  // keyboard steps
  check("step 0 -> 0.25 allowed", W.canStep(g, 0.9, -0.9, 0.9, -1.2));
  check("step 0 -> 0.5 allowed", W.canStep(g, -2.0, -1.3, -2.0, -1.6));
  const fail = res.filter((x) => !x.ok).length;
  console.log(fail ? `${fail} FAILED` : "all ok");
  return fail;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("walk-steps-test.mjs")) process.exitCode = run() ? 1 : 0;
