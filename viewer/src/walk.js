// Walkable floor map for "걷기" navigation: a 2D grid over the occupancy
// voxels at one floor level. A cell is walkable when there is floor under it,
// nothing in the body band above it (knee to head height, inflated by the
// body radius), and it is connected to the capture viewpoints. A* on it gives
// routes that go around furniture the way a person walks, and the same grid
// is the collision test for keyboard walking.

// Binary min-heap keyed by f-score (A* open set).
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export class WalkMap {
  constructor(occ, tour, { radius = 0.22, bodyLow = 0.3, bodyHigh = 1.8 } = {}) {
    this.occ = occ;
    this.tour = tour;
    this.radius = radius;
    this.bodyLow = bodyLow;
    this.bodyHigh = bodyHigh;
    this.levels = new Map(); // floor height (25 cm bins) -> grid
  }

  level(floorY) {
    const key = Math.round(floorY * 4);
    let g = this.levels.get(key);
    if (!g) {
      const t0 = performance.now();
      g = this._build(floorY);
      this.levels.set(key, g);
      console.info(`[walk] floor ${floorY.toFixed(2)}: ${g.count} walkable cells in ${Math.round(performance.now() - t0)}ms${g.noFloor ? " (no floor evidence, obstacles only)" : ""}`);
    }
    return g;
  }

  _build(fy) {
    const o = this.occ, nx = o.nx, nz = o.nz, v = o.voxel;
    const yi = (y) => Math.floor((y - o.box.min.y) / v);
    const col = (x, z, y0, y1) => {
      for (let y = Math.max(0, y0); y <= Math.min(o.ny - 1, y1); y++) if (o.solid[(y * nz + z) * nx + x]) return true;
      return false;
    };
    const b0 = yi(fy + this.bodyLow), b1 = yi(fy + this.bodyHigh);
    const f0 = yi(fy - 0.3), f1 = yi(fy + 0.15);
    const obstacle = new Uint8Array(nx * nz);
    const floor = new Uint8Array(nx * nz);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        obstacle[i] = col(x, z, b0, b1) ? 1 : 0;
        floor[i] = col(x, z, f0, f1) ? 1 : 0;
      }
    // Keep the body radius away from anything in the body band.
    const blocked = stamp(obstacle, nx, nz, Math.ceil(this.radius / v));
    // Floors reconstruct with small holes (dark or plain patches): close them.
    const floorD = stamp(floor, nx, nz, 3);

    const seeds = this.tour.nodes.filter((n) => Math.abs(n.floorY - fy) < 0.35);
    const grid = { fy, nx, nz, v, minX: o.box.min.x, minZ: o.box.min.z, walk: null, count: 0, noFloor: false };
    const flood = (useFloor) => {
      const free = new Uint8Array(nx * nz);
      for (let i = 0; i < free.length; i++) free[i] = !blocked[i] && (!useFloor || floorD[i]) ? 1 : 0;
      const walk = new Uint8Array(nx * nz);
      const stack = [];
      grid.walk = free; // for nearest() while seeding
      for (const n of seeds) {
        const c = this.nearest(grid, n.position.x, n.position.z, 0.8);
        if (c >= 0 && !walk[c]) { walk[c] = 1; stack.push(c); }
      }
      let count = stack.length;
      while (stack.length) {
        const i = stack.pop();
        const x = i % nx, z = (i - x) / nx;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx, Z = z + dz;
          if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
          const j = Z * nx + X;
          if (free[j] && !walk[j]) { walk[j] = 1; count++; stack.push(j); }
        }
      }
      grid.walk = walk;
      grid.count = count;
    };
    flood(true);
    // A floor band that found nothing near the viewpoints means the floor
    // height is off for this capture; fall back to obstacles alone.
    if (grid.count < 50 && seeds.length) { flood(false); grid.noFloor = true; }
    return grid;
  }

  cell(g, x, z) {
    const cx = Math.floor((x - g.minX) / g.v), cz = Math.floor((z - g.minZ) / g.v);
    if (cx < 0 || cz < 0 || cx >= g.nx || cz >= g.nz) return -1;
    return cz * g.nx + cx;
  }

  canStand(g, x, z) {
    const c = this.cell(g, x, z);
    return c >= 0 && g.walk[c] === 1;
  }

  // Nearest walkable cell within maxDist metres (ring search), or -1.
  nearest(g, x, z, maxDist) {
    const cx = Math.floor((x - g.minX) / g.v), cz = Math.floor((z - g.minZ) / g.v);
    const R = Math.ceil(maxDist / g.v);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= R; r++) {
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const X = cx + dx, Z = cz + dz;
          if (X < 0 || Z < 0 || X >= g.nx || Z >= g.nz) continue;
          const j = Z * g.nx + X;
          if (!g.walk[j]) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = j; }
        }
      if (best >= 0) return best; // later rings are all farther than √2·r
    }
    return -1;
  }

  _xz(g, c) {
    const x = c % g.nx, z = (c - x) / g.nx;
    return [g.minX + (x + 0.5) * g.v, g.minZ + (z + 0.5) * g.v];
  }

  // Straight segment stays on walkable cells.
  lineClear(g, ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(d / (g.v * 0.5)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (!this.canStand(g, ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  // Walking route from `from` to `to` (world points) as waypoints on the floor
  // plane (x, z); null when there is no way there. The goal snaps to the
  // nearest standable spot within `snap` metres (e.g. clicked on a table).
  route(g, from, to, { snap = 1.6 } = {}) {
    const s = this.canStand(g, from.x, from.z) ? this.cell(g, from.x, from.z) : this.nearest(g, from.x, from.z, 0.8);
    const t = this.canStand(g, to.x, to.z) ? this.cell(g, to.x, to.z) : this.nearest(g, to.x, to.z, snap);
    if (s < 0 || t < 0) return null;
    const goal = t === this.cell(g, to.x, to.z) ? [to.x, to.z] : this._xz(g, t);
    const start = [from.x, from.z];
    if (this.lineClear(g, start[0], start[1], goal[0], goal[1])) return [start, goal];

    const { nx, nz } = g;
    const tx = t % nx, tz = (t - tx) / nx;
    const gScore = new Float32Array(nx * nz).fill(Infinity);
    const came = new Int32Array(nx * nz).fill(-1);
    const closed = new Uint8Array(nx * nz);
    const h = (c) => {
      const x = c % nx, z = (c - x) / nx;
      const dx = Math.abs(x - tx), dz = Math.abs(z - tz);
      return Math.max(dx, dz) + 0.41421356 * Math.min(dx, dz);
    };
    const open = new Heap();
    gScore[s] = 0;
    open.push(h(s), s);
    const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let found = false, expanded = 0;
    while (open.size) {
      const c = open.pop();
      if (closed[c]) continue;
      if (c === t) { found = true; break; }
      closed[c] = 1;
      if (++expanded > 600000) break;
      const x = c % nx, z = (c - x) / nx;
      for (const [dx, dz, w] of steps) {
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
        const j = Z * nx + X;
        if (!g.walk[j] || closed[j]) continue;
        // no corner cutting through blocked cells
        if (dx && dz && (!g.walk[z * nx + X] || !g.walk[Z * nx + x])) continue;
        const ng = gScore[c] + w;
        if (ng < gScore[j]) { gScore[j] = ng; came[j] = c; open.push(ng + h(j), j); }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let c = t; c !== -1; c = came[c]) cells.push(c);
    cells.reverse();
    const pts = cells.map((c) => this._xz(g, c));
    pts[0] = start;
    pts[pts.length - 1] = goal;
    // String pulling: keep only the corners a straight walk can't skip.
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.lineClear(g, pts[i][0], pts[i][1], pts[j][0], pts[j][1])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}

// Dilate a mask by a disc of radius r cells.
function stamp(mask, nx, nz, r) {
  if (r <= 0) return mask.slice();
  const offs = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) offs.push([dx, dz]);
  const out = new Uint8Array(nx * nz);
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      if (!mask[z * nx + x]) continue;
      for (const [dx, dz] of offs) {
        const X = x + dx, Z = z + dz;
        if (X >= 0 && Z >= 0 && X < nx && Z < nz) out[Z * nx + X] = 1;
      }
    }
  return out;
}
