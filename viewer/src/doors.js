// Doors between places ("문 여는 연출"), shared by both study conditions.
// One set of door data (nav.json "doors"), one look, one animation, one sound;
// each viewer only says where the eye is and whether the user is about to go
// through (3DGS: the walking route or the walker heading at it; 360°: the
// hotspot hop). So the two conditions still differ only in how you explore.
//
// A door is a pair of simple leaves (or one) standing in the real doorway,
// closed by default. Its face is either a photo of the actual door (a crop
// with alpha, `texture`) or drawn here: 띠살 lattice with hanji paper for
// hanok room doors, weathered planks for gates, painted panels for "plain".
// Brightness is matched to the imagery around the doorway (the walls beside
// it), so a door in a dim entrance is dim, not a bright prop.
//
// nav.json (hand-editable; see docs/INTERACTION.md "문 여는 연출"):
//   "doorFx": { "duration": 0.9, "sound": true },
//   "doors": [{ "id", "name", "fromRoom", "toRoom",
//               "position": [x, y, z]   bottom centre of the doorway (world, m)
//               "yaw": deg              facing direction, fromRoom -> toRoom (0 = -Z, + = turning left)
//               "width", "height",      m (the opening)
//               "style": "hanok-double" | "hanok-single" | "sliding" | "plain",
//               "open": "swing-in" | "swing-out" | "slide"   (in = into toRoom)
//               optional: "texture" (door photo, front = seen from fromRoom), "textureBack" (seen from toRoom, as photographed),
//               "pattern" ("ttisal" | "planks" | "panelled"), "leaves", "hinge" ("left"|"right"),
//               "openAngle" (deg, 92), "light" (fixed brightness instead of auto), "tint" "#rrggbb",
//               "visibleFrom" ([node ids] shown in the 360° view), "draft": true }]
import * as THREE from "three";

const DEG = Math.PI / 180;
export const DOOR_DEFAULTS = { duration: 0.9, sound: true, nearDist: 0.6, approachDist: 1.4, pathDist: 1.6, closeDelay: 0.7 };

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------- data
export function prepareDoors(nav, base = "") {
  const fx = { ...DOOR_DEFAULTS, ...(nav?.doorFx || {}) };
  const abs = new URL(base || "./", location.href);
  const doors = (nav?.doors || []).filter((d) => Array.isArray(d.position)).map((d, i) => {
    const yaw = (d.yaw || 0) * DEG;
    const style = d.style || "plain";
    const leaves = d.leaves ?? (style === "hanok-double" || style === "sliding" ? 2 : 1);
    return {
      ...d,
      id: d.id || `door${i}`,
      yawRad: yaw,
      n: [-Math.sin(yaw), -Math.cos(yaw)], // facing, fromRoom -> toRoom
      t: [Math.cos(yaw), -Math.sin(yaw)], // to the right when facing
      cx: d.position[0], cy: d.position[1] ?? 0, cz: d.position[2],
      width: d.width ?? 0.9,
      halfW: (d.width ?? 0.9) / 2,
      height: d.height ?? 2.1,
      style,
      leaves,
      pattern: d.pattern || (style === "plain" ? "panelled" : "ttisal"),
      open: d.open || (style === "sliding" ? "slide" : "swing-in"),
      openAngle: (d.openAngle ?? 92) * DEG,
      textureUrl: d.texture ? new URL(d.texture, abs).href : null,
      textureBackUrl: d.textureBack ? new URL(d.textureBack, abs).href : null,
    };
  });
  return { fx, doors };
}

// Position relative to a door: nd = signed distance along its facing (< 0 on
// the fromRoom side), lat = along the doorway (0 = centre).
export function doorLocal(d, x, z) {
  const dx = x - d.cx, dz = z - d.cz;
  return { nd: dx * d.n[0] + dz * d.n[1], lat: dx * d.t[0] + dz * d.t[1] };
}

// Does the straight step a -> b pass through the doorway? { u (0..1 along
// the step), lat, dir: +1 fromRoom -> toRoom, -1 back } or null.
export function segmentCrossing(d, ax, az, bx, bz, margin = 0.3) {
  const a = doorLocal(d, ax, az), b = doorLocal(d, bx, bz);
  if (a.nd === b.nd || (a.nd < 0) === (b.nd < 0)) return null;
  const u = a.nd / (a.nd - b.nd);
  const lat = a.lat + (b.lat - a.lat) * u;
  if (Math.abs(lat) > d.halfW + margin) return null;
  return { u, lat, dir: a.nd < 0 ? 1 : -1 };
}

// Doors a hop between two capture points goes through (360° condition). A
// hop between the two rooms a door joins counts when it crosses the door's
// plane near the doorway (hotspot edges are straight lines, the walk isn't).
export function doorsOnHop(doors, from, to) {
  const out = [];
  for (const d of doors) {
    const joins = (from.room === d.fromRoom && to.room === d.toRoom) || (from.room === d.toRoom && to.room === d.fromRoom);
    const c = segmentCrossing(d, from.position[0], from.position[2], to.position[0], to.position[2], joins ? 1.5 : 0.3);
    if (c) out.push({ door: d, ...c });
  }
  return out.sort((a, b) => a.u - b.u);
}

// Room names for the log: the side the viewer comes from and goes to.
export function passRooms(d, dir) {
  return dir > 0 ? { from: d.fromRoom, to: d.toRoom } : { from: d.toRoom, to: d.fromRoom };
}

// ---------------------------------------------------------------- textures
// Seeded random, so a door looks the same every visit and in both conditions.
function rng(seed) {
  let s = 0;
  for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) | 0;
  return () => ((s = (s * 1664525 + 1013904223) | 0) >>> 0) / 4294967296;
}
const PALETTE = {
  ttisal: { wood: [74, 52, 36], lath: [92, 66, 45], paper: [236, 226, 204], edge: [70, 50, 35] },
  planks: { wood: [88, 70, 54], lath: [70, 55, 42], paper: null, edge: [60, 47, 36] },
  panelled: { wood: [226, 221, 208], lath: [226, 221, 208], paper: null, edge: [200, 195, 182] },
};
const rgb = (c, k = 1, a = 1) => `rgba(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)},${a})`;
function hexTint(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Wood grain: fine streaks along `vertical` (or across) the board.
function grain(g, x, y, w, h, base, R, vertical = true, strength = 1) {
  g.fillStyle = rgb(base);
  g.fillRect(x, y, w, h);
  const n = Math.max(8, Math.round((vertical ? w : h) * 0.9));
  for (let i = 0; i < n; i++) {
    const p = R();
    const k = 0.82 + R() * 0.3;
    g.strokeStyle = rgb(base, k, 0.22 * strength);
    g.lineWidth = 0.6 + R() * 1.4;
    g.beginPath();
    if (vertical) {
      const px = x + p * w;
      g.moveTo(px, y);
      const wob = (R() - 0.5) * 3;
      g.bezierCurveTo(px + wob, y + h * 0.33, px - wob, y + h * 0.66, px + wob * 0.5, y + h);
    } else {
      const py = y + p * h;
      g.moveTo(x, py);
      const wob = (R() - 0.5) * 3;
      g.bezierCurveTo(x + w * 0.33, py + wob, x + w * 0.66, py - wob, x + w, py + wob * 0.5);
    }
    g.stroke();
  }
}

// A soft shadow line (for depth between members) and a highlight.
function bevel(g, x, y, w, h, s) {
  g.fillStyle = `rgba(255,255,255,${0.1 * s})`;
  g.fillRect(x, y, w, Math.max(1, h * 0.12));
  g.fillStyle = `rgba(0,0,0,${0.22 * s})`;
  g.fillRect(x, y + h - Math.max(1, h * 0.14), w, Math.max(1, h * 0.14));
}

// 띠살문: stiles and rails (울거미), a wooden bottom panel (궁판), and above it
// thin vertical laths with three bands of horizontal ones over hanji paper.
function drawTtisal(g, x0, W, H, ppm, R, pal) {
  const fw = Math.max(6, 0.055 * ppm); // stile / rail width
  const panelH = H * 0.2;
  grain(g, x0, 0, W, H, pal.wood, R, true);
  // paper field
  const px = x0 + fw, py = fw, pw = W - 2 * fw, ph = H - panelH - fw * 2.2;
  const paper = g.createLinearGradient(0, py, 0, py + ph);
  paper.addColorStop(0, rgb(pal.paper, 1.02));
  paper.addColorStop(1, rgb(pal.paper, 0.94));
  g.fillStyle = paper;
  g.fillRect(px, py, pw, ph);
  // fibres in the paper
  for (let i = 0; i < pw * ph * 0.004; i++) {
    g.strokeStyle = `rgba(160,140,110,${0.05 + R() * 0.06})`;
    g.lineWidth = 0.6;
    const fx = px + R() * pw, fy = py + R() * ph, a = R() * Math.PI;
    g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx + Math.cos(a) * 6, fy + Math.sin(a) * 6); g.stroke();
  }
  // laths
  const lw = Math.max(2, 0.011 * ppm), pitch = 0.034 * ppm;
  const nV = Math.max(3, Math.round(pw / pitch));
  for (let i = 1; i < nV; i++) {
    const lx = px + (i * pw) / nV - lw / 2;
    g.fillStyle = rgb(pal.lath);
    g.fillRect(lx, py, lw, ph);
    g.fillStyle = "rgba(0,0,0,0.18)";
    g.fillRect(lx + lw, py, Math.max(1, lw * 0.35), ph); // its shadow on the paper
  }
  const band = (cy) => {
    for (let k = 0; k < 4; k++) {
      const ly = cy + (k - 1.5) * pitch - lw / 2;
      g.fillStyle = rgb(pal.lath, 1.04);
      g.fillRect(px, ly, pw, lw);
      g.fillStyle = "rgba(0,0,0,0.16)";
      g.fillRect(px, ly + lw, pw, Math.max(1, lw * 0.35));
    }
  };
  band(py + pitch * 2.2);
  band(py + ph / 2);
  band(py + ph - pitch * 2.2);
  // the frame over the paper edge (inner shadow)
  g.strokeStyle = "rgba(0,0,0,0.28)";
  g.lineWidth = Math.max(1.5, fw * 0.12);
  g.strokeRect(px, py, pw, ph);
  // middle rail and bottom panel
  const railY = py + ph;
  grain(g, x0 + fw, railY, W - 2 * fw, fw * 1.2, pal.wood, R, false);
  bevel(g, x0 + fw, railY, W - 2 * fw, fw * 1.2, 1);
  const gy = railY + fw * 1.2, gh = H - fw - gy;
  grain(g, x0 + fw, gy, W - 2 * fw, gh, pal.wood.map((c) => c * 1.06), R, true, 0.8);
  g.strokeStyle = "rgba(0,0,0,0.3)";
  g.lineWidth = Math.max(1.5, fw * 0.1);
  g.strokeRect(x0 + fw * 1.6, gy + fw * 0.6, W - fw * 3.2, gh - fw * 1.2);
  // outer stiles catch a little light
  bevel(g, x0, 0, W, fw, 1);
}

// 널판문 (gate): vertical boards, three battens, clout nails, an iron ring.
function drawPlanks(g, x0, W, H, ppm, R, pal, leafIndex, leaves) {
  const bw = 0.15 * ppm;
  const n = Math.max(2, Math.round(W / bw));
  for (let i = 0; i < n; i++) {
    const x = x0 + (i * W) / n, w = W / n;
    const k = 0.9 + R() * 0.18;
    grain(g, x, 0, w, H, pal.wood.map((c) => c * k), R, true, 1.3);
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.fillRect(x, 0, Math.max(1.2, 0.004 * ppm), H); // gap between boards
  }
  // weathering: darker toward the bottom, lighter where hands touch
  const wg = g.createLinearGradient(0, 0, 0, H);
  wg.addColorStop(0, "rgba(0,0,0,0.08)");
  wg.addColorStop(0.75, "rgba(0,0,0,0)");
  wg.addColorStop(1, "rgba(0,0,0,0.28)");
  g.fillStyle = wg;
  g.fillRect(x0, 0, W, H);
  const batH = 0.1 * ppm;
  for (const fy of [0.12, 0.5, 0.86]) {
    const y = H * fy - batH / 2;
    grain(g, x0, y, W, batH, pal.lath, R, false, 1.2);
    bevel(g, x0, y, W, batH, 1.2);
    for (let i = 0; i < n; i++) {
      for (const dy of [0.28, 0.72]) {
        const cx = x0 + ((i + 0.5) * W) / n, cy = y + batH * dy, r = Math.max(1.6, 0.007 * ppm);
        g.fillStyle = "rgba(20,16,14,0.85)";
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = "rgba(255,240,220,0.18)";
        g.beginPath(); g.arc(cx - r * 0.3, cy - r * 0.3, r * 0.45, 0, Math.PI * 2); g.fill();
      }
    }
  }
  // iron ring pull (문고리) on the meeting edge
  const meetX = leaves === 2 ? (leafIndex === 0 ? x0 + W - 0.07 * ppm : x0 + 0.07 * ppm) : x0 + W - 0.09 * ppm;
  const ry = H * 0.46, rr = 0.045 * ppm;
  g.fillStyle = "rgba(25,22,20,0.9)";
  g.beginPath(); g.arc(meetX, ry - rr * 1.25, rr * 0.45, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(28,25,22,0.92)";
  g.lineWidth = Math.max(2, 0.009 * ppm);
  g.beginPath(); g.arc(meetX, ry, rr, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = "rgba(255,235,210,0.14)";
  g.lineWidth = Math.max(1, 0.003 * ppm);
  g.beginPath(); g.arc(meetX, ry, rr, Math.PI * 1.1, Math.PI * 1.6); g.stroke();
}

// Painted panel door: two columns of raised panels, soft bevel shading.
function drawPanelled(g, x0, W, H, ppm, R, pal, leafIndex = 0, leaves = 1) {
  g.fillStyle = rgb(pal.wood);
  g.fillRect(x0, 0, W, H);
  const fw = 0.1 * ppm, mid = 0.09 * ppm;
  const cols = W > 0.75 * ppm ? 2 : 1;
  const rows = [[0.06, 0.36], [0.42, 0.72], [0.78, 0.95]];
  const pw = (W - 2 * fw - (cols - 1) * mid) / cols;
  for (let c = 0; c < cols; c++)
    for (const [a, b] of rows) {
      const x = x0 + fw + c * (pw + mid), y = H * a, h = H * (b - a);
      const b2 = 0.018 * ppm;
      g.fillStyle = "rgba(0,0,0,0.13)"; // recess shadow (bottom / right)
      g.fillRect(x, y + h - b2, pw, b2);
      g.fillRect(x + pw - b2, y, b2, h);
      g.fillStyle = "rgba(255,255,255,0.35)"; // lit edges (top / left)
      g.fillRect(x, y, pw, b2 * 0.8);
      g.fillRect(x, y, b2 * 0.8, h);
      g.fillStyle = rgb(pal.wood, 1.015);
      g.fillRect(x + b2 * 1.6, y + b2 * 1.6, pw - b2 * 3.2, h - b2 * 3.2);
      g.strokeStyle = "rgba(0,0,0,0.07)";
      g.lineWidth = 1;
      g.strokeRect(x + b2 * 1.6, y + b2 * 1.6, pw - b2 * 3.2, h - b2 * 3.2);
    }
  // brass knob on the meeting edge
  const kx = leaves === 2 && leafIndex === 1 ? x0 + 0.08 * ppm : x0 + W - 0.08 * ppm, ky = H * 0.44, kr = 0.022 * ppm;
  const kg = g.createRadialGradient(kx - kr * 0.3, ky - kr * 0.3, kr * 0.1, kx, ky, kr);
  kg.addColorStop(0, "rgba(235,205,140,1)");
  kg.addColorStop(1, "rgba(120,90,40,1)");
  g.fillStyle = kg;
  g.beginPath(); g.arc(kx, ky, kr, 0, Math.PI * 2); g.fill();
  // a little grime low down
  const wg = g.createLinearGradient(0, H * 0.7, 0, H);
  wg.addColorStop(0, "rgba(90,80,60,0)");
  wg.addColorStop(1, "rgba(90,80,60,0.12)");
  g.fillStyle = wg;
  g.fillRect(x0, H * 0.7, W, H * 0.3);
}

// The whole doorway face as one canvas (all leaves side by side), so a photo
// of the real door and the drawn one map onto the leaves the same way.
export function doorCanvas(d) {
  const ppm = Math.min(420, 1024 / Math.max(d.width, d.height));
  const W = Math.round(d.width * ppm), H = Math.round(d.height * ppm);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const R = rng(d.id);
  const base = PALETTE[d.pattern] || PALETTE.ttisal;
  const tint = hexTint(d.tint);
  const pal = tint ? { ...base, wood: tint, lath: tint.map((v) => v * 1.12), edge: tint.map((v) => v * 0.85) } : base;
  const lw = W / d.leaves;
  for (let i = 0; i < d.leaves; i++) {
    const x0 = Math.round(i * lw), w = Math.round((i + 1) * lw) - x0;
    g.save();
    g.beginPath(); g.rect(x0, 0, w, H); g.clip();
    if (d.pattern === "planks") drawPlanks(g, x0, w, H, ppm, R, pal, i, d.leaves);
    else if (d.pattern === "panelled") drawPanelled(g, x0, w, H, ppm, R, pal, i, d.leaves);
    else drawTtisal(g, x0, w, H, ppm, R, pal);
    // ambient occlusion: a soft shade around the leaf (the frame and the
    // other leaf overhang it) and toward the floor
    const ao = (x, y, w2, h2, dx, dy) => {
      const gr = g.createLinearGradient(x, y, x + dx, y + dy);
      gr.addColorStop(0, "rgba(0,0,0,0.22)");
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.fillRect(x, y, w2, h2);
    };
    const r = 0.06 * ppm;
    ao(x0, 0, w, r, 0, r);
    ao(x0, 0, r, H, r, 0);
    ao(x0 + w - r, 0, r, H, -r, 0);
    ao(x0, H - r * 2.5, w, r * 2.5, 0, -r * 2.5);
    const fall = g.createLinearGradient(0, 0, 0, H);
    fall.addColorStop(0, "rgba(0,0,0,0.03)");
    fall.addColorStop(0.55, "rgba(0,0,0,0)");
    fall.addColorStop(1, "rgba(0,0,0,0.12)");
    g.fillStyle = fall;
    g.fillRect(x0, 0, w, H);
    // the leaf's own edge reads as a thin dark line where leaves meet
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(x0, 0, Math.max(1, ppm * 0.004), H);
    g.fillRect(x0 + w - Math.max(1, ppm * 0.004), 0, Math.max(1, ppm * 0.004), H);
    g.restore();
  }
  // fine photographic grain, so the drawn face sits with photo-based imagery instead of looking rendered
  const img = g.getImageData(0, 0, W, H), px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const k = 1 + (R() - 0.5) * 0.07;
    px[i] = Math.min(255, px[i] * k); px[i + 1] = Math.min(255, px[i + 1] * k); px[i + 2] = Math.min(255, px[i + 2] * k);
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, edge: pal.edge };
}

// ---------------------------------------------------------------- sound
// Soft wooden creak: stick-slip pulses exciting a few body modes, rendered
// once per kind. A heavy gate creaks lower; a painted panel door barely.
export class DoorSound {
  constructor(on = true) {
    this.on = on;
    this.ctx = null;
    this.cache = new Map();
    const unlock = () => {
      if (!this.on) return;
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === "suspended") this.ctx.resume();
      } catch {}
    };
    for (const ev of ["pointerdown", "keydown", "touchend"]) addEventListener(ev, unlock, { passive: true });
  }

  _creak(dur, f0, f1, modes, seed) {
    const ctx = this.ctx, rate = ctx.sampleRate, N = Math.floor(dur * rate);
    const buf = ctx.createBuffer(1, N, rate);
    const out = buf.getChannelData(0);
    const R = rng(seed);
    const pulses = [];
    let phase = 0;
    for (let i = 0; i < N; i++) {
      const t = i / rate, u = t / dur;
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.08)), 0.7) * (0.75 + 0.25 * Math.sin(t * 23 + R() * 0.3));
      const f = f0 + (f1 - f0) * u + 6 * Math.sin(2 * Math.PI * 2.7 * t);
      phase += f / rate;
      if (phase >= 1) {
        phase -= 1;
        pulses.push({ i, a: env * (0.6 + 0.4 * R()) });
        if (pulses.length > 4) pulses.shift();
      }
      let s = 0;
      for (const p of pulses) {
        const k = (i - p.i) / rate;
        for (const [fm, dec, g] of modes) s += p.a * g * Math.exp(-k / dec) * Math.sin(2 * Math.PI * fm * k);
      }
      out[i] = s;
    }
    let peak = 0;
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0) for (let i = 0; i < N; i++) out[i] /= peak;
    return buf;
  }

  _thud(seed, low = 95) {
    const ctx = this.ctx, rate = ctx.sampleRate, N = Math.floor(0.22 * rate);
    const buf = ctx.createBuffer(1, N, rate);
    const out = buf.getChannelData(0);
    const R = rng(seed);
    let lp = 0;
    for (let i = 0; i < N; i++) {
      const t = i / rate;
      lp += 0.08 * ((R() * 2 - 1) - lp);
      out[i] = Math.exp(-t / 0.05) * (0.8 * Math.sin(2 * Math.PI * low * t) + 0.5 * Math.sin(2 * Math.PI * low * 2.3 * t) * Math.exp(-t / 0.02)) + lp * Math.exp(-t / 0.012) * 0.6;
    }
    return buf;
  }

  _buffer(kind, weight) {
    const key = `${kind}:${weight}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const modes = weight === "heavy" ? [[190, 0.014, 1], [410, 0.01, 0.6], [690, 0.007, 0.35]] : [[380, 0.01, 1], [820, 0.007, 0.55], [1350, 0.005, 0.3]];
    const f = weight === "heavy" ? [34, 58] : [52, 88];
    let b;
    if (kind === "open") b = this._creak(0.78, f[0], f[1], modes, key);
    else if (kind === "close") b = this._creak(0.5, f[1], f[0], modes, key);
    else if (kind === "slide") b = this._slide(0.8, key);
    else b = this._thud(key, weight === "heavy" ? 70 : 105);
    this.cache.set(key, b);
    return b;
  }

  _slide(dur, seed) {
    const ctx = this.ctx, rate = ctx.sampleRate, N = Math.floor(dur * rate);
    const buf = ctx.createBuffer(1, N, rate);
    const out = buf.getChannelData(0);
    const R = rng(seed);
    let a = 0, b = 0;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      a += 0.12 * ((R() * 2 - 1) - a);
      b += 0.02 * (a - b);
      out[i] = (a - b) * Math.pow(Math.sin(Math.PI * u), 0.6) * (0.8 + 0.2 * Math.sin(i / rate * 40));
    }
    return buf;
  }

  // kind: "open" | "close"; door decides weight and style
  play(kind, d, { pan = 0, dist = 2 } = {}) {
    if (!this.on || !this.ctx || this.ctx.state !== "running") return;
    try {
      const ctx = this.ctx;
      const weight = d.pattern === "planks" ? "heavy" : "light";
      const slide = d.open === "slide";
      const level = (d.pattern === "panelled" ? 0.5 : 1) * clamp(1.6 / (dist + 0.6), 0.25, 1);
      const out = ctx.createGain();
      out.gain.value = 0.16 * level;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = weight === "heavy" ? 1800 : 2600;
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -0.8, 0.8);
      lp.connect(out).connect(p).connect(ctx.destination);
      const at = ctx.currentTime + 0.02;
      const src = (name, when, gain, rateVar = 0.05) => {
        const s = ctx.createBufferSource();
        s.buffer = this._buffer(name, weight);
        s.playbackRate.value = 1 + (Math.random() - 0.5) * rateVar;
        const g = ctx.createGain();
        g.gain.value = gain;
        s.connect(g).connect(lp);
        s.start(when);
      };
      if (slide) {
        src("slide", at, kind === "open" ? 0.5 : 0.45);
        if (kind === "close") src("thud", at + 0.78, 0.35);
      } else if (kind === "open") {
        src("thud", at, 0.28); // latch lifting
        src("open", at + 0.06, d.pattern === "panelled" ? 0.35 : 0.8);
      } else {
        src("close", at, d.pattern === "panelled" ? 0.3 : 0.65);
        src("thud", at + 0.82, 0.9);
      }
    } catch {}
  }
}

// ---------------------------------------------------------------- 3D doors
// Leaves as thin boxes in the doorway (group frame: -Z = the door's facing,
// +X = along the doorway). Opaque, so in the 3DGS view they are drawn before
// the splats and write depth: splats behind a closed door are hidden, splats
// in front (jambs, a wall the door swings against) stay in front.
export class DoorSet {
  // opts: { doors, fx, parent: THREE.Object3D, log(e, d), sound: DoorSound|null, sample: (door, side) => lum|{lum, rgb}|null,
  //         canOpen: (door) => bool (a door onto a room model still loading waits) }
  constructor({ doors, fx, parent, log = () => {}, sound = null, sample = null, canOpen = null }) {
    this.canOpen = canOpen;
    this.fx = fx;
    this.log = log;
    this.sound = sound;
    this.sample = sample;
    this.root = new THREE.Group();
    this.root.name = "doors";
    parent.add(this.root);
    this.items = doors.map((d) => this._build(d));
    this.time = 0;
  }

  get doors() { return this.items.map((it) => it.d); }
  item(id) { return this.items.find((it) => it.d.id === id || it === id || it.d === id); }

  _build(d) {
    const g = new THREE.Group();
    g.position.set(d.cx, d.cy, d.cz);
    g.rotation.y = d.yawRad;
    g.name = `door:${d.id}`;
    this.root.add(g);
    const thick = d.pattern === "ttisal" ? 0.035 : 0.045;
    const { canvas, edge } = doorCanvas(d);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // sliding leaves disappear into the wall pockets: cut at the jambs (world
    // planes, updated per frame), so they read the same over splats and over a panorama
    const clip = d.open === "slide" ? [new THREE.Plane(), new THREE.Plane()] : null;
    const faceMat = () => new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.FrontSide, clippingPlanes: clip });
    const edgeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(`rgb(${edge.map(Math.round).join(",")})`), clippingPlanes: clip });
    const it = { d, g, leaves: [], mats: [], p: 0, target: 0, lastReason: -1, light: d.light ?? 1, tint: new THREE.Color(1, 1, 1), sampled: 0, openedAt: 0, thick, clip, lastOpenSec: null };
    it.edgeBase = edgeMat.color.clone();
    it.mats.push(edgeMat);
    const loadPhoto = (url, onTex) => new THREE.TextureLoader().load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; onTex(t); }, undefined, () => console.warn(`[doors] ${d.id}: texture not found, drawing it instead: ${url}`));
    const W = d.width, H = d.height, n = d.leaves;
    const lw = W / n;
    for (let k = 0; k < n; k++) {
      // leaf k covers x in [-W/2 + k*lw, -W/2 + (k+1)*lw] when closed
      const x0 = -W / 2 + k * lw, x1 = x0 + lw;
      // hinge side: a single leaf on d.hinge ("left" default); a pair on the outer jambs
      const hingeLeft = n === 1 ? d.hinge !== "right" : k < n / 2;
      const e = hingeLeft ? 1 : -1; // the leaf extends +x (hinge on the left) or -x
      const hx = hingeLeft ? x0 : x1;
      const geo = new THREE.BoxGeometry(lw - 0.004, H - 0.01, thick);
      geo.translate((e * lw) / 2, H / 2 + 0.005, 0);
      // UVs of the two big faces = this leaf's share of the doorway picture
      const uv = geo.attributes.uv;
      const u0 = (x0 + W / 2) / W, u1 = (x1 + W / 2) / W;
      for (const f of [4, 5]) {
        for (let v = 0; v < 4; v++) {
          const i = f * 4 + v;
          const u = uv.getX(i);
          // +z face: u runs -x -> +x. -z face (seen from toRoom): u runs +x -> -x; mirror it so the
          // back shows the same leaf, not its neighbour
          const uu = f === 4 ? u0 + (u1 - u0) * u : u1 - (u1 - u0) * u;
          uv.setX(i, uu);
        }
      }
      uv.needsUpdate = true;
      const front = faceMat(), back = faceMat();
      const mesh = new THREE.Mesh(geo, [edgeMat, edgeMat, edgeMat, edgeMat, front, back]);
      const pivot = new THREE.Group();
      pivot.position.x = hx;
      pivot.add(mesh);
      // sliding pairs run in two tracks
      if (d.open === "slide") pivot.position.z = (k % 2 ? -1 : 1) * (thick / 2 + 0.003);
      g.add(pivot);
      it.leaves.push({ pivot, mesh, e, hx, front, back, lw, k, delay: n > 1 && k === n - 1 ? 0.07 : 0 });
      it.mats.push(front, back);
    }
    if (d.textureUrl) loadPhoto(d.textureUrl, (t) => { for (const L of it.leaves) { L.front.map = t; if (!d.textureBackUrl) L.back.map = t; L.front.needsUpdate = L.back.needsUpdate = true; } });
    // a photo of the back as seen from the room: mirror it onto the back faces' coordinates
    if (d.textureBackUrl) loadPhoto(d.textureBackUrl, (t) => { t.wrapS = THREE.RepeatWrapping; t.repeat.x = -1; t.offset.x = 1; for (const L of it.leaves) { L.back.map = t; L.back.needsUpdate = true; } });
    // a photo already carries the scene's own light: no brightness matching
    if (d.textureUrl && d.light == null) it.light = 1, (it.fixedLight = true);
    this._pose(it);
    return it;
  }

  // Leaf transforms for opening progress it.p (0 closed .. 1 open).
  _pose(it) {
    const d = it.d;
    const sign = d.open === "swing-out" ? -1 : 1;
    for (const L of it.leaves) {
      // a pair opens a touch out of step, as two hands would
      const q = easeInOut(clamp((it.p - L.delay) / (1 - L.delay), 0, 1));
      if (d.open === "slide") {
        L.pivot.position.x = L.hx - L.e * L.lw * 0.94 * q;
        L.pivot.rotation.y = 0;
      } else {
        L.pivot.position.x = L.hx;
        L.pivot.rotation.y = L.e * sign * d.openAngle * q;
      }
    }
  }

  _setTarget(it, open, reason) {
    const target = open ? 1 : 0;
    if (it.target === target) return;
    it.target = target;
    const dist = this.eye ? Math.hypot(this.eye.x - it.d.cx, this.eye.z - it.d.cz) : 2;
    const pan = this.eye && this.camYaw !== undefined ? Math.sin(Math.atan2(-(it.d.cx - this.eye.x), -(it.d.cz - this.eye.z)) - this.camYaw) * -1 : 0;
    this.sound?.play(open ? "open" : "close", it.d, { pan, dist });
    const side = this.eye ? doorLocal(it.d, this.eye.x, this.eye.z).nd : -1;
    if (open) {
      it.openedAt = this.time;
      // from = the room the viewer is in, to = the room behind the door
      this.log("door_open", { door: it.d.id, ...passRooms(it.d, side < 0 ? 1 : -1), trigger: reason });
    } else this.log("door_close", { door: it.d.id, at: side < 0 ? it.d.fromRoom : it.d.toRoom, trigger: reason });
  }

  // Open now and resolve when fully open (the 360° hop waits for this).
  openFor(id, reason = "hop") {
    const it = this.item(id);
    if (!it) return Promise.resolve();
    it.hold = reason;
    this._setTarget(it, true, reason);
    return new Promise((res) => { it.onOpen = res; if (it.p >= 1) { it.onOpen = null; res(); } });
  }
  release(id) {
    const it = this.item(id);
    if (it) it.hold = null;
  }

  // Per frame. ctx: { eye: Vector3, camYaw, vel: {x, z} (m/s) | null,
  //   ahead: Map(doorId -> metres until the route crosses it) }
  update(dt, { eye, camYaw, vel = null, ahead = null, camera = null } = {}) {
    this.time += dt;
    this.eye = eye;
    this.camYaw = camYaw;
    this.root.updateWorldMatrix(true, false);
    // a jump (task start, capture point) is not walking through a door
    this.jumped = !!this.lastEye && Math.hypot(eye.x - this.lastEye.x, eye.z - this.lastEye.z) > 0.5;
    this.lastEye = { x: eye.x, z: eye.z };
    const fx = this.fx;
    for (const it of this.items) {
      const d = it.d;
      const { nd, lat } = doorLocal(d, eye.x, eye.z);
      const inSpan = Math.abs(lat) < d.halfW + 0.25;
      let reason = null;
      if (it.hold) reason = it.hold;
      // standing in or right at the doorway: keep it open
      else if (inSpan && Math.abs(nd) < fx.nearDist && eye.y - d.cy < d.height + 0.6) reason = "near";
      // the walking route goes through it soon
      else if (ahead?.has(d.id) && ahead.get(d.id) < fx.pathDist && ahead.get(d.id) > -0.3) reason = "path";
      // walking at it (keyboard): moving toward the plane, crossing inside the doorway
      else if (vel) {
        const vn = vel.x * d.n[0] + vel.z * d.n[1], vl = vel.x * d.t[0] + vel.z * d.t[1];
        const toward = nd < 0 ? vn > 0.15 : vn < -0.15;
        if (toward && Math.abs(nd) < fx.approachDist) {
          const tc = Math.abs(nd / vn);
          if (Math.abs(lat + vl * tc) < d.halfW + 0.2) reason = "approach";
        }
      }
      if (reason && reason !== "near" && reason !== it.hold && this.canOpen && !this.canOpen(d)) reason = null;
      if (reason) {
        it.lastReason = this.time;
        if (it.target === 0) this._setTarget(it, true, reason);
      } else if (it.target === 1 && this.time - it.lastReason > fx.closeDelay && this.time - it.openedAt > fx.duration + 0.3) {
        this._setTarget(it, false, "passed");
      }
      // animate
      const was = it.p;
      const step = dt / Math.max(0.05, fx.duration);
      it.p = it.target > it.p ? Math.min(it.target, it.p + step) : Math.max(it.target, it.p - step);
      if (it.p !== was) this._pose(it);
      if (was === 0 && it.p > 0) it.tStart = this.time;
      if (was < 1 && it.p === 1 && it.tStart != null) it.lastOpenSec = +(this.time - it.tStart).toFixed(3);
      if (it.clip) this._clip(it);
      if (it.p >= 1 && it.onOpen) { const f = it.onOpen; it.onOpen = null; f(); }
      // side of the door, for the pass log
      const side = nd < 0 ? -1 : 1;
      if (it.side && side !== it.side && inSpan && !this.jumped) this.log("door_pass", { door: d.id, ...passRooms(d, side > 0 ? 1 : -1) });
      it.side = side;
      this._shade(it, eye, camera);
    }
  }

  _clip(it) {
    const d = it.d;
    const e = this.root.matrixWorld.elements; // the 360° viewer offsets the root by -eye
    const cx = d.cx + e[12], cy = d.cy + e[13], cz = d.cz + e[14];
    const t = new THREE.Vector3(d.t[0], 0, d.t[1]);
    const c = new THREE.Vector3(cx, cy, cz);
    it.clip[0].set(t, d.halfW + 0.002 - t.dot(c));
    it.clip[1].set(t.clone().negate(), d.halfW + 0.002 + t.dot(c));
  }

  // Brightness: matched to the imagery beside the doorway (sampled by the
  // viewer every half second while the door is near and closed), times a
  // gentle falloff when a leaf turns edge-on to the eye.
  _shade(it, eye, camera) {
    const d = it.d;
    if (d.light == null && !it.fixedLight && this.sample && this.time - it.sampled > 0.5 && it.p < 0.05) {
      const dist = Math.hypot(eye.x - d.cx, eye.z - d.cz);
      if (dist < 9) {
        it.sampled = this.time;
        const side = doorLocal(d, eye.x, eye.z).nd < 0 ? -1 : 1;
        const s = this.sample(d, side, camera);
        if (s && s.lum > 0.005) {
          // walls around a door are about as bright as its lightest material
          const want = clamp(s.lum / (d.pattern === "planks" ? 0.55 : 0.68), 0.12, 1.3);
          it.light = it.lightInit ? it.light + (want - it.light) * 0.35 : want;
          it.lightInit = true;
          if (s.rgb) {
            const m = (s.rgb[0] + s.rgb[1] + s.rgb[2]) / 3 || 1;
            it.tint.setRGB(...s.rgb.map((c) => 1 + ((c / m) - 1) * 0.35));
          }
        }
      }
    }
    const L = it.light;
    for (const leaf of it.leaves) {
      // facing: leaf normal vs direction to the eye
      leaf.mesh.updateWorldMatrix(true, false);
      const e = leaf.mesh.matrixWorld.elements;
      const nx = e[8], nz = e[10];
      // leaf centre in the doors' own frame (the 360° viewer moves the root by -eye)
      const r = this.root.matrixWorld.elements;
      const cx = e[12] - r[12], cz = e[14] - r[14];
      const vx = eye.x - cx, vz = eye.z - cz, vl = Math.hypot(vx, vz) || 1;
      const f = 0.8 + 0.2 * Math.abs((nx * vx + nz * vz) / (Math.hypot(nx, nz) * vl));
      for (const m of [leaf.front, leaf.back]) m.color.copy(it.tint).multiplyScalar(L * f);
    }
    it.mats[0].color.copy(it.edgeBase).multiply(it.tint).multiplyScalar(L * 0.9);
  }

  setVisible(id, v) {
    const it = this.item(id);
    if (it) it.g.visible = v;
  }

  // Test hook: jump a door to a state without animation.
  force(id, p) {
    const it = this.item(id);
    if (!it) return;
    it.p = it.target = p;
    this._pose(it);
  }

  dispose() {
    this.root.parent?.remove(this.root);
    for (const it of this.items) for (const L of it.leaves) { L.mesh.geometry.dispose(); L.front.map?.dispose(); }
  }
}

// Luminance of sRGB bytes (0..1) and the mean colour, from a list of samples.
export function summarizeSamples(list) {
  if (!list.length) return null;
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const ls = list.map(lum).sort((a, b) => a - b);
  const med = ls[Math.floor(ls.length / 2)];
  const mean = [0, 1, 2].map((i) => list.reduce((s, c) => s + c[i], 0) / list.length / 255);
  return { lum: med, rgb: mean };
}

// World points on the wall beside a doorway (both jambs, three heights),
// on the side the viewer is on, for brightness sampling.
export function jambPoints(d, side) {
  const pts = [];
  for (const s of [-1, 1])
    for (const h of [0.5, 1.1, 1.7]) {
      if (h > d.height + 0.3) continue;
      const l = s * (d.halfW + 0.28);
      pts.push(new THREE.Vector3(d.cx + d.t[0] * l + d.n[0] * side * 0.04, d.cy + h, d.cz + d.t[1] * l + d.n[1] * side * 0.04));
    }
  return pts;
}
