// Cinematic auto-camera (like WithVision's timeline playback, but along the
// path the photographer actually walked, so it never passes through walls).
// Tour page only: ?cinema=1 starts it, the C key toggles it; any drag, click
// or key stops it. Never used in the study (?study=) or the listing app.
//
// Path: capture_path.json (camera centres in the viewer world; x/z only),
// smoothed and resampled by arc length; scenes without it use the capture
// points (tour.nodes) in capture order. The camera looks ~2 m ahead along
// the path, turned partly toward the middle of the walked area, with a slow,
// damped heading so turns read as a steady gimbal move.
import * as THREE from "three";

const STEP = 0.05; // resample spacing (m)

function smooth(pts, sigma) {
  // Gaussian smoothing over samples; ends are clamped
  const r = Math.ceil(sigma * 3);
  const w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  return pts.map((_, i) => {
    const acc = new THREE.Vector3();
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = Math.min(pts.length - 1, Math.max(0, i + k));
      acc.addScaledVector(pts[j], w[k + r]);
      ws += w[k + r];
    }
    return acc.divideScalar(ws);
  });
}

function resample(pts) {
  const out = [pts[0].clone()];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = a.distanceTo(b);
    let t = STEP - carry;
    while (t <= len) {
      out.push(a.clone().lerp(b, t / len));
      t += STEP;
    }
    carry = len - (t - STEP);
  }
  return out;
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Cinema {
  constructor({ tour, rig, look, baseUrl }) {
    Object.assign(this, { tour, rig, look, baseUrl });
    this.active = false;
    this.speed = 0.55; // m/s, a slow walk
    this.lookAhead = 2.0; // m
    this.pitch = -0.06; // rad, slightly down like a hand-held gimbal
    this.path = null;
  }

  async load() {
    if (this.path) return this.path;
    let raw = null;
    try {
      const r = await fetch(new URL("capture_path.json", this.baseUrl));
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.cameras) && /viewer world/.test(d.frame || "")) raw = d.cameras.map((c) => new THREE.Vector3().fromArray(c.position));
      }
    } catch { /* no capture path: fall back to the capture points */ }
    if (!raw || raw.length < 4) {
      raw = [...this.tour.nodes].sort((a, b) => (a.camera ?? a.index) - (b.camera ?? b.index)).map((n) => n.position.clone());
      raw = resample(raw); // corners get rounded by the smoothing below
      this.path = resample(smooth(raw, 40));
    } else {
      // camera centres are ~0.2 m apart; sigma 8 frames ≈ 1.7 m irons out the hand-held sway
      this.path = resample(smooth(raw, 8));
    }
    this.center = this.path.reduce((a, q) => a.add(q), new THREE.Vector3()).divideScalar(this.path.length);
    return this.path;
  }

  at(s) {
    const p = this.path;
    const f = (((s / STEP) % p.length) + p.length) % p.length;
    const i = Math.floor(f);
    return p[i].clone().lerp(p[(i + 1) % p.length], f - i);
  }

  async start() {
    await this.load();
    if (this.path.length < 2) return false;
    // begin where the path passes closest to the viewer, blending in from the current pose
    let best = 0, bd = Infinity;
    this.path.forEach((q, i) => { const d = q.distanceToSquared(this.rig.position); if (d < bd) { bd = d; best = i; } });
    this.s = best * STEP;
    this.from = { pos: this.rig.position.clone(), yaw: this.look.yaw, pitch: this.look.pitch };
    this.blend = 0;
    this.yaw = this.look.yaw;
    this.v = 0;
    this.active = true;
    return true;
  }

  stop() {
    this.active = false;
  }

  update(dt) {
    if (!this.active) return;
    this.v = Math.min(this.speed, this.v + this.speed * dt * 0.5); // ease in over ~2 s
    this.s += this.v * dt;
    const pos = this.at(this.s);
    // heading: along the path, turned partly toward the middle of the walked
    // area, so walls slide past at an angle and the courtyard stays in view
    const ahead = this.at(this.s + this.lookAhead).sub(pos).setY(0).normalize();
    const inward = this.center.clone().sub(pos).setY(0);
    if (inward.lengthSq() > 0.25) ahead.addScaledVector(inward.normalize(), 0.8);
    const want = Math.atan2(-ahead.x, -ahead.z);
    this.yaw += wrap(want - this.yaw) * (1 - Math.exp(-dt * 1.2));
    this.blend = Math.min(1, this.blend + dt / 1.5);
    const k = 0.5 - 0.5 * Math.cos(Math.PI * this.blend);
    // capture heights follow the camera stick (0.7-2.1 m), not the eyes: keep
    // eye height over the floor; steps up and down are left to followFloor
    const y = this.rig.position.y;
    this.rig.position.copy(this.from.pos).lerp(pos, k);
    this.rig.position.y = this.blend < 1 ? this.from.pos.y + (this.tour.nearestNode(pos).floorY + this.tour.eyeHeight - this.from.pos.y) * k : y;
    this.look.set(this.from.yaw + wrap(this.yaw - this.from.yaw) * k, this.from.pitch + (this.pitch - this.from.pitch) * k);
  }
}
