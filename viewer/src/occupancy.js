// Voxel occupancy grid built once from splat centres. Gives microsecond
// ray queries (occlusion, free-space distance, collision) where exact splat
// raycasting costs tens of milliseconds on multi-million splat scenes.
import * as THREE from "three";

export class Occupancy {
  constructor(splat, tour, { voxel = 0.08, margin = 3, minOpacity = 0.3, threshold = 0.6 } = {}) {
    this.voxel = voxel;
    const box = new THREE.Box3();
    for (const n of tour.nodes) box.expandByPoint(n.position);
    box.min.y = Math.min(...tour.nodes.map((n) => n.floorY)) - 0.5;
    box.max.y = Math.max(...tour.nodes.map((n) => n.position.y)) + 1.8;
    box.min.x -= margin; box.min.z -= margin;
    box.max.x += margin; box.max.z += margin;
    this.box = box;
    const size = box.getSize(new THREE.Vector3());
    const nx = (this.nx = Math.max(1, Math.ceil(size.x / voxel)));
    const ny = (this.ny = Math.max(1, Math.ceil(size.y / voxel)));
    const nz = (this.nz = Math.max(1, Math.ceil(size.z / voxel)));
    const acc = new Float32Array(nx * ny * nz);
    const m = splat.matrixWorld;
    const p = new THREE.Vector3();
    const inv = 1 / voxel;
    const add = (q, w) => {
      p.copy(q).applyMatrix4(m);
      const x = Math.floor((p.x - box.min.x) * inv);
      const y = Math.floor((p.y - box.min.y) * inv);
      const z = Math.floor((p.z - box.min.z) * inv);
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
      acc[(y * nz + z) * nx + x] += w;
    };
    // Plain walls are often a few large Gaussians; counting centres alone
    // leaves them full of holes, so big splats also stamp their disc (the two
    // largest axes, out to 1 sigma). Voxel size in splat-local units:
    const worldScale = new THREE.Vector3().setFromMatrixScale(m).x || 1;
    const lv = voxel / worldScale;
    const ax = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const s = new THREE.Vector3();
    splat.forEachSplat((_i, center, scales, quat, opacity) => {
      if (opacity < minOpacity) return;
      add(center, opacity);
      const sv = [scales.x, scales.y, scales.z];
      const o = [0, 1, 2].sort((a, b) => sv[b] - sv[a]);
      if (!(sv[o[0]] > 0.75 * lv)) return;
      ax[0].set(1, 0, 0).applyQuaternion(quat).multiplyScalar(sv[0]);
      ax[1].set(0, 1, 0).applyQuaternion(quat).multiplyScalar(sv[1]);
      ax[2].set(0, 0, 1).applyQuaternion(quat).multiplyScalar(sv[2]);
      const a0 = ax[o[0]], a1 = ax[o[1]];
      const k = Math.min(6, Math.ceil(sv[o[0]] / lv));
      for (let i = -k; i <= k; i++)
        for (let j = -k; j <= k; j++) {
          const u = i / k, v = j / k;
          if ((i === 0 && j === 0) || u * u + v * v > 1) continue;
          s.copy(center).addScaledVector(a0, u).addScaledVector(a1, v);
          add(s, opacity);
        }
    });
    // Threshold, then dilate by one voxel so sparse walls become watertight.
    const solid = new Uint8Array(nx * ny * nz);
    for (let i = 0; i < acc.length; i++) solid[i] = acc[i] >= threshold ? 1 : 0;
    const dil = new Uint8Array(solid);
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          if (!solid[(y * nz + z) * nx + x]) continue;
          for (let d = -1; d <= 1; d += 2) {
            if (x + d >= 0 && x + d < nx) dil[(y * nz + z) * nx + x + d] = 1;
            if (z + d >= 0 && z + d < nz) dil[(y * nz + z + d) * nx + x] = 1;
            if (y + d >= 0 && y + d < ny) dil[((y + d) * nz + z) * nx + x] = 1;
          }
        }
    this.solid = dil;
  }

  // Baked copy (scripts/bake-lod-aux.mjs): the streamed phone path never holds
  // every splat, so it loads the grid the full scene produced. Layout: "OCC1",
  // u32 header length, JSON header {voxel, min, nx, ny, nz}, then one bit per
  // voxel (x fastest, then z, then y), LSB first.
  toBuffer() {
    const head = new TextEncoder().encode(JSON.stringify({ voxel: this.voxel, min: this.box.min.toArray(), max: this.box.max.toArray(), nx: this.nx, ny: this.ny, nz: this.nz }));
    const n = this.solid.length;
    const out = new Uint8Array(8 + head.length + Math.ceil(n / 8));
    out.set([79, 67, 67, 49]);
    new DataView(out.buffer).setUint32(4, head.length, true);
    out.set(head, 8);
    const bits = out.subarray(8 + head.length);
    for (let i = 0; i < n; i++) if (this.solid[i]) bits[i >> 3] |= 1 << (i & 7);
    return out;
  }

  static fromBuffer(buf) {
    const u8 = new Uint8Array(buf);
    if (String.fromCharCode(...u8.subarray(0, 4)) !== "OCC1") throw new Error("occupancy: bad file");
    const hl = new DataView(u8.buffer, u8.byteOffset).getUint32(4, true);
    const h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
    const o = Object.create(Occupancy.prototype);
    o.voxel = h.voxel;
    o.box = new THREE.Box3(new THREE.Vector3().fromArray(h.min), new THREE.Vector3().fromArray(h.max));
    o.nx = h.nx; o.ny = h.ny; o.nz = h.nz;
    const n = h.nx * h.ny * h.nz;
    const bits = u8.subarray(8 + hl);
    if (bits.length < Math.ceil(n / 8)) throw new Error("occupancy: truncated file");
    o.solid = new Uint8Array(n);
    for (let i = 0; i < n; i++) o.solid[i] = (bits[i >> 3] >> (i & 7)) & 1;
    return o;
  }

  occupied(p) {
    const inv = 1 / this.voxel;
    const x = Math.floor((p.x - this.box.min.x) * inv);
    const y = Math.floor((p.y - this.box.min.y) * inv);
    const z = Math.floor((p.z - this.box.min.z) * inv);
    if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return false;
    return this.solid[(y * this.nz + z) * this.nx + x] === 1;
  }

  // Distance along the ray to the first occupied voxel (or maxDist).
  // Starts `skip` metres out so the viewer's own voxel never counts.
  march(origin, dir, maxDist = 12, skip = 0.15) {
    const step = this.voxel * 0.5;
    const p = new THREE.Vector3();
    for (let t = skip; t < maxDist; t += step) {
      p.copy(dir).multiplyScalar(t).add(origin);
      if (this.occupied(p)) return t;
    }
    return maxDist;
  }

  // Is the straight segment a→b free of geometry (ignoring the ends)?
  clear(a, b, endSkip = 0.3) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 2 * endSkip) return true;
    d.divideScalar(len);
    return this.march(a, d, len - endSkip, endSkip) >= len - endSkip;
  }

  // Pick a heading near `yaw` that looks into open space: stays on the
  // preferred direction when it is open, otherwise turns the least needed.
  openHeading(pos, yaw) {
    const dir = new THREE.Vector3();
    const free = (a) => {
      // average of three rays across a narrow cone at eye level, slightly down
      let s = 0;
      for (const o of [-0.18, 0, 0.18]) {
        dir.set(-Math.sin(a + o), -0.08, -Math.cos(a + o)).normalize();
        s += this.march(pos, dir, 6);
      }
      return s / 3;
    };
    if (free(yaw) >= 2.2) return yaw;
    let best = yaw;
    let bestScore = -Infinity;
    for (let k = -12; k <= 12; k++) {
      const a = yaw + (k * Math.PI) / 12;
      const score = Math.min(free(a), 4) - Math.abs(k) * 0.12;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }
}
