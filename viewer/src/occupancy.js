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
    splat.forEachSplat((_i, center, scales, _q, opacity) => {
      if (opacity < minOpacity) return;
      p.copy(center).applyMatrix4(m);
      const x = Math.floor((p.x - box.min.x) * inv);
      const y = Math.floor((p.y - box.min.y) * inv);
      const z = Math.floor((p.z - box.min.z) * inv);
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
      acc[(y * nz + z) * nx + x] += opacity;
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
