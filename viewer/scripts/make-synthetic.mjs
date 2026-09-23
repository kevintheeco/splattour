// Generates a synthetic two-room apartment as a 3DGS .ply plus tour.json,
// so the viewer can be developed and regression-tested without a GPU
// reconstruction. Usage: node scripts/make-synthetic.mjs [outDir]
import fs from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] || new URL("../../scenes/synthetic-apartment", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
fs.mkdirSync(out, { recursive: true });

const C0 = 0.28209479177387814;
const splats = [];
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// axis: which scale axis is thin (0=x,1=y,2=z)
function push(x, y, z, [r, g, b], axis, size = 0.022, opacity = 0.97) {
  const s = [size, size, size];
  s[axis] = 0.002;
  splats.push({ x, y, z, r, g, b, s, o: opacity });
}

function surface({ axis, at, u0, u1, v0, v1, color, step = 0.03, holes = [] }) {
  // axis is the normal; u,v are the other two in order
  const [ua, va] = [[1, 2], [0, 2], [0, 1]][axis];
  for (let u = u0; u < u1; u += step) {
    for (let v = v0; v < v1; v += step) {
      const ju = u + (rnd() - 0.5) * step * 0.6;
      const jv = v + (rnd() - 0.5) * step * 0.6;
      if (holes.some((h) => ju > h[0] && ju < h[1] && jv > h[2] && jv < h[3])) continue;
      const p = [0, 0, 0];
      p[axis] = at;
      p[ua] = ju;
      p[va] = jv;
      push(p[0], p[1], p[2], color(ju, jv, p), axis);
    }
  }
}

const H = 2.6;
const clamp = (x) => Math.max(0, Math.min(1, x));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const noise = (a) => (rnd() - 0.5) * a;

// Wood floor: planks along x with per-plank tone and grain.
const wood = (x, z) => {
  const plank = Math.floor(z / 0.18);
  const off = (plank * 0.37) % 1.2;
  const seam = Math.abs(((x + off) % 1.2) - 0.0) < 0.01 || Math.abs((z % 0.18) - 0) < 0.008;
  const tone = 0.85 + ((plank * 7919) % 13) / 60;
  const grain = 0.06 * Math.sin(x * 40 + plank * 3) + noise(0.04);
  const base = [0.55 * tone + grain, 0.38 * tone + grain * 0.7, 0.24 * tone + grain * 0.4];
  return seam ? base.map((c) => c * 0.55) : base;
};
const paint = (base) => () => base.map((c) => clamp(c + noise(0.025)));
const tile = (x, z) => {
  const g = (Math.abs((x % 0.4)) < 0.01 || Math.abs(z % 0.4) < 0.01);
  return g ? [0.62, 0.62, 0.6] : [0.86 + noise(0.03), 0.85 + noise(0.03), 0.82 + noise(0.03)];
};

// ----- Floors & ceilings -----
// Living room 0..6 x 0..5 ; hallway 6..9 x 1.8..3.2 ; bedroom 9..14 x 0..5
surface({ axis: 1, at: 0, u0: 0, u1: 6, v0: 0, v1: 5, color: (x, z) => wood(x, z) });
surface({ axis: 1, at: 0, u0: 6, u1: 9, v0: 1.8, v1: 3.2, color: (x, z) => tile(x, z) });
surface({ axis: 1, at: 0, u0: 9, u1: 14, v0: 0, v1: 5, color: (x, z) => mix(wood(x, z), [0.7, 0.62, 0.55], 0.35) });
const ceilingLight = (cx, cz) => (x, z) => {
  const d = Math.hypot(x - cx, z - cz);
  return d < 0.35 ? [1, 0.98, 0.9] : [0.93 - d * 0.02, 0.92 - d * 0.02, 0.9 - d * 0.02];
};
surface({ axis: 1, at: H, u0: 0, u1: 6, v0: 0, v1: 5, color: ceilingLight(3, 2.5), step: 0.04 });
surface({ axis: 1, at: H, u0: 6, u1: 9, v0: 1.8, v1: 3.2, color: ceilingLight(7.5, 2.5), step: 0.04 });
surface({ axis: 1, at: H, u0: 9, u1: 14, v0: 0, v1: 5, color: ceilingLight(11.5, 2.5), step: 0.04 });

// ----- Walls -----
const door = (a, b) => [a, b, 0, 2.1]; // hole in (u, y) space
const sage = paint([0.62, 0.68, 0.6]);
const cream = paint([0.9, 0.86, 0.78]);
const terracotta = paint([0.78, 0.52, 0.42]);
const blush = paint([0.86, 0.74, 0.72]);
// Living room walls (x=0, x=6, z=0, z=5); wall axis x → u=y,v=z ; axis z → u=x,v=y
surface({ axis: 0, at: 0, u0: 0, u1: H, v0: 0, v1: 5, color: sage });
surface({ axis: 0, at: 6, u0: 0, u1: H, v0: 0, v1: 5, color: cream, holes: [[0, 2.1, 1.8, 3.2]] });
surface({ axis: 2, at: 0, u0: 0, u1: 6, v0: 0, v1: H, color: cream, holes: [[1.5, 4.5, 0.9, 2.1]] }); // window
surface({ axis: 2, at: 5, u0: 0, u1: 6, v0: 0, v1: H, color: terracotta });
// Hallway walls
surface({ axis: 2, at: 1.8, u0: 6, u1: 9, v0: 0, v1: H, color: cream });
surface({ axis: 2, at: 3.2, u0: 6, u1: 9, v0: 0, v1: H, color: cream });
// Bedroom walls
surface({ axis: 0, at: 9, u0: 0, u1: H, v0: 0, v1: 5, color: blush, holes: [[0, 2.1, 1.8, 3.2]] });
surface({ axis: 0, at: 14, u0: 0, u1: H, v0: 0, v1: 5, color: paint([0.52, 0.58, 0.7]) });
surface({ axis: 2, at: 0, u0: 9, u1: 14, v0: 0, v1: H, color: blush });
surface({ axis: 2, at: 5, u0: 9, u1: 14, v0: 0, v1: H, color: blush, holes: [[10.5, 12.5, 0.9, 2.1]] });

// Outside view through windows: a sky/garden backdrop plane.
surface({ axis: 2, at: -2.5, u0: -2, u1: 8, v0: -0.5, v1: 4, step: 0.05, color: (x, y) => (y < 1.0 ? [0.3 + noise(0.1), 0.5 + noise(0.1), 0.25] : mix([0.75, 0.85, 0.95], [0.45, 0.65, 0.9], clamp((y - 1) / 3))) });
surface({ axis: 2, at: 7.5, u0: 8, u1: 15, v0: -0.5, v1: 4, step: 0.05, color: (x, y) => (y < 1.2 ? [0.25 + noise(0.1), 0.45 + noise(0.1), 0.3] : mix([0.95, 0.8, 0.65], [0.5, 0.6, 0.85], clamp((y - 1.2) / 2.8))) });

// ----- Furniture (boxes) -----
function box(x0, x1, y0, y1, z0, z1, color, step = 0.03) {
  surface({ axis: 1, at: y1, u0: x0, u1: x1, v0: z0, v1: z1, color, step });
  surface({ axis: 0, at: x0, u0: y0, u1: y1, v0: z0, v1: z1, color, step });
  surface({ axis: 0, at: x1, u0: y0, u1: y1, v0: z0, v1: z1, color, step });
  surface({ axis: 2, at: z0, u0: x0, u1: x1, v0: y0, v1: y1, color, step });
  surface({ axis: 2, at: z1, u0: x0, u1: x1, v0: y0, v1: y1, color, step });
}
// sofa against terracotta wall
box(1.2, 4.2, 0, 0.45, 4.1, 4.95, paint([0.25, 0.32, 0.45]));
box(1.2, 4.2, 0.45, 0.95, 4.7, 4.95, paint([0.22, 0.29, 0.42]));
// coffee table + rug
surface({ axis: 1, at: 0.005, u0: 1.4, u1: 4.2, v0: 2.2, v1: 3.9, color: (x, z) => ((Math.floor(x * 4) + Math.floor(z * 4)) % 2 ? [0.82, 0.76, 0.66] : [0.7, 0.3, 0.25]) });
box(2.1, 3.4, 0, 0.42, 2.8, 3.5, paint([0.35, 0.24, 0.16]));
// shelf on sage wall with coloured books
box(0.02, 0.4, 0, 1.9, 0.6, 2.2, paint([0.8, 0.78, 0.74]));
for (let i = 0; i < 24; i++) {
  const z = 0.65 + i * 0.065;
  const c = [[0.7, 0.2, 0.2], [0.2, 0.4, 0.7], [0.9, 0.7, 0.2], [0.2, 0.55, 0.4], [0.5, 0.3, 0.6]][i % 5];
  box(0.4, 0.43, 1.0, 1.25 + (i % 3) * 0.05, z, z + 0.05, () => c, 0.012);
}
// artwork frames
const art = (x0, x1, y0, y1, z, hue) =>
  surface({ axis: 2, at: z, u0: x0, u1: x1, v0: y0, v1: y1, step: 0.015, color: (x, y) => {
    const fx = (x - x0) / (x1 - x0), fy = (y - y0) / (y1 - y0);
    if (fx < 0.05 || fx > 0.95 || fy < 0.06 || fy > 0.94) return [0.12, 0.1, 0.08];
    return [clamp(hue[0] + 0.3 * Math.sin(fx * 9 + fy * 4)), clamp(hue[1] + 0.3 * Math.sin(fy * 7)), clamp(hue[2] + 0.3 * Math.cos(fx * 5 - fy * 6))];
  } });
art(2.0, 3.4, 1.35, 2.2, 4.98, [0.8, 0.5, 0.2]);
art(6.5, 7.4, 1.2, 1.9, 3.18, [0.2, 0.5, 0.8]);
art(7.7, 8.6, 1.2, 1.9, 1.82, [0.7, 0.2, 0.5]);
// bed
box(10.2, 12.4, 0, 0.5, 2.6, 4.95, paint([0.95, 0.94, 0.92]));
box(10.2, 12.4, 0.5, 1.2, 4.8, 4.95, paint([0.45, 0.35, 0.28]));
box(10.4, 11.2, 0.5, 0.62, 4.3, 4.75, paint([0.98, 0.98, 0.97]));
box(11.4, 12.2, 0.5, 0.62, 4.3, 4.75, paint([0.98, 0.98, 0.97]));
box(10.2, 12.4, 0.5, 0.55, 2.6, 3.8, paint([0.55, 0.62, 0.72]));
// desk + lamp in bedroom
box(13.2, 13.95, 0, 0.75, 0.3, 1.8, paint([0.4, 0.3, 0.2]));
box(13.5, 13.7, 0.75, 1.25, 0.5, 0.7, () => [1, 0.9, 0.6]);
// plant in living room corner
for (let i = 0; i < 4000; i++) {
  const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.35, y = 0.4 + rnd() * 0.9;
  push(5.5 + Math.cos(a) * r * (1.3 - y / 1.3), y, 0.5 + Math.sin(a) * r * (1.3 - y / 1.3), [0.15 + noise(0.1), 0.45 + noise(0.2), 0.18], 1, 0.03, 0.9);
}
box(5.3, 5.7, 0, 0.4, 0.3, 0.7, paint([0.7, 0.45, 0.3]));

// ----- write PLY -----
const props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`;
const buf = Buffer.alloc(splats.length * props.length * 4);
let o = 0;
const logit = (p) => Math.log(p / (1 - p));
for (const s of splats) {
  const vals = [s.x, s.y, s.z, 0, 0, 0, (s.r - 0.5) / C0, (s.g - 0.5) / C0, (s.b - 0.5) / C0, logit(s.o), Math.log(s.s[0]), Math.log(s.s[1]), Math.log(s.s[2]), 1, 0, 0, 0];
  for (const v of vals) { buf.writeFloatLE(v, o); o += 4; }
}
fs.writeFileSync(path.join(out, "scene.ply"), Buffer.concat([Buffer.from(header), buf]));

const eye = 1.55;
const nodes = [
  { id: "living-entry", name: "거실 입구", position: [4.8, eye, 1.2], yaw: 2.4 },
  { id: "living-center", name: "거실", position: [3.0, eye, 2.0], yaw: Math.PI },
  { id: "living-shelf", name: "책장 앞", position: [1.3, eye, 1.3], yaw: Math.PI / 2 },
  { id: "hall", name: "복도", position: [7.5, eye, 2.5], yaw: -Math.PI / 2 },
  { id: "bed-door", name: "침실 입구", position: [9.9, eye, 2.5], yaw: -Math.PI / 2 },
  { id: "bed-center", name: "침실", position: [12.0, eye, 1.6], yaw: Math.PI },
  { id: "bed-desk", name: "책상 옆", position: [12.9, eye, 0.9], yaw: 2.0 },
];
const edges = [
  ["living-entry", "living-center"], ["living-center", "living-shelf"], ["living-entry", "living-shelf"],
  ["living-entry", "hall"], ["hall", "bed-door"], ["bed-door", "bed-center"], ["bed-center", "bed-desk"], ["bed-door", "bed-desk"],
];
fs.writeFileSync(
  path.join(out, "tour.json"),
  JSON.stringify({ version: 1, title: "Synthetic Apartment", subtitle: "합성 테스트 공간 · 거실·복도·침실", splat: "scene.ply", eyeHeight: eye, start: "living-entry", nodes, edges, lights: [{"id": "living-ceiling", "name": "거실 천장등", "position": [3.0, 2.55, 2.5], "radius": 4.2, "emitter": 0.45, "kelvin": 3000}, {"id": "hall-ceiling", "name": "복도등", "position": [7.5, 2.55, 2.5], "radius": 2.6, "emitter": 0.45, "kelvin": 3200}, {"id": "bed-ceiling", "name": "침실 천장등", "position": [11.5, 2.55, 2.5], "radius": 4.0, "emitter": 0.45, "kelvin": 2900}, {"id": "desk-lamp", "name": "책상 스탠드", "position": [13.6, 1.15, 0.6], "radius": 1.8, "emitter": 0.25, "kelvin": 2700, "gain": 1.6}] }, null, 2),
);
console.log(`wrote ${splats.length.toLocaleString()} splats → ${out}`);
