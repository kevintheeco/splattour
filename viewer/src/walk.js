// Walkable floor map for "걷기" navigation: a 2D grid over the occupancy
// voxels with a floor HEIGHT per cell, so the walker can step up and down
// (a 마루 40-60 cm above the courtyard, 댓돌, thresholds) the way a person
// does, with the eyes at floor + eye height.
//
// Per column of voxels the floor is the highest solid surface in the band the
// capture points can reach (lowest capture floor - 0.3 m .. highest + stepMax):
//  - a surface at a capture floor level (a "level": the floors the photographer
//    stood on, from tour.json floorY) is that level;
//  - a surface in between is a step if it is solid below (not a chair seat on
//    legs) and small (a 댓돌, a stair tread; not a bed or a table top);
//  - otherwise the column is furniture: an obstacle.
// A cell is walkable when its own body band (0.3..1.8 m above its floor) is
// clear, nothing within the body radius sticks into that band (a neighbour's
// floor counts only when it is a ledge higher than stepMax), and it is
// connected to the capture points through steps of at most stepMax. A* on it
// (with a cost for climbing, so real stairs and 댓돌 are preferred over one
// big step) gives routes around furniture and up steps; the same grid is the
// collision test for keyboard walking. On a single flat floor this is exactly
// the earlier one-level map (same cells, same routes).

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

// Extra A* cost (in cells) for a height change: grows with the square, so two
// half steps cost half of one full step and a route over 댓돌/stairs wins.
const stepCost = (dh) => (dh > 0.02 ? 3 * (dh / 0.15) ** 2 : 0);

export class WalkMap {
  constructor(occ, tour, { radius = 0.22, bodyLow = 0.3, bodyHigh = 1.8, stepMax = 0.65, maxStepArea = 1.5, minStepArea = 0.05, minSupport = 0.6 } = {}) {
    this.occ = occ;
    this.tour = tour;
    this.radius = radius;
    this.bodyLow = bodyLow;
    this.bodyHigh = bodyHigh;
    this.stepMax = stepMax;
    this.maxStepArea = maxStepArea;
    this.minStepArea = minStepArea;
    this.minSupport = minSupport;
    this.levels = new Map(); // one grid for the whole space (cleared when walls change, see app/portals.js)
  }

  // The walking grid. (It used to be one grid per floor height; now one grid
  // holds every level, the argument is kept for callers.)
  level(_floorY) {
    let g = this.levels.get("all");
    if (!g) {
      const t0 = performance.now();
      g = this._build();
      this.levels.set("all", g);
      console.info(`[walk] floor ${g.levels.map((f) => f.toFixed(2)).join(", ")}: ${g.count} walkable cells${g.steps ? `, ${g.steps} step cells` : ""} in ${Math.round(performance.now() - t0)}ms${g.noFloor ? " (no floor evidence, obstacles only)" : ""}`);
    }
    return g;
  }

  // Capture floor levels: tour floorY values, merged within 20 cm.
  _levels() {
    const ys = [...new Set(this.tour.nodes.map((n) => +n.floorY.toFixed(3)))].sort((a, b) => a - b);
    const out = [];
    for (const y of ys) if (!out.length || y - out[out.length - 1] > 0.2) out.push(y);
    return out.length ? out : [0];
  }

  _build() {
    const o = this.occ, nx = o.nx, nz = o.nz, ny = o.ny, v = o.voxel, S = o.solid, N = nx * nz;
    const minY = o.box.min.y;
    const yi = (y) => Math.floor((y - minY) / v);
    const L = this._levels();
    const sAt = (x, z, y) => y >= 0 && y < ny && S[(y * nz + z) * nx + x] === 1;

    // ---- floor surface per column
    const scanBot = Math.max(0, yi(L[0] - 0.3)), scanTop = Math.min(ny - 1, yi(L[L.length - 1] + this.stepMax));
    const top = new Int16Array(N).fill(-1); // highest solid voxel in the scan band
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++)
        for (let y = scanTop; y >= scanBot; y--) if (sAt(x, z, y)) { top[z * nx + x] = y; break; }
    // floor evidence per level (the band the one-level map used), dilated to close small holes
    // (upper floors: only surfaces within 15 cm of the floor height; the lowest
    // keeps the old band, so a single-floor space is unchanged)
    const evid = L.map((F, li) => {
      const f0 = yi(F - (li ? 0.15 : 0.3)), f1 = yi(F + 0.15);
      const e = new Uint8Array(N);
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++)
          for (let y = Math.max(0, f0); y <= Math.min(ny - 1, f1); y++) if (sAt(x, z, y)) { e[z * nx + x] = 1; break; }
      return { F, f0, f1, e, d: stamp(e, nx, nz, 3) };
    });
    // the level whose floor band holds this surface (the nearest one when bands overlap)
    const levelOf = (yTop) => {
      let best = null;
      for (const l of evid) if (yTop >= l.f0 && yTop <= l.f1 && (!best || Math.abs(minY + yTop * v - l.F) < Math.abs(minY + yTop * v - best.F))) best = l;
      return best;
    };
    const below = (h) => { let b = evid[0]; for (const l of evid) if (l.F <= h + 1e-6) b = l; return b; };

    // kind: 0 none (hole), 1 level floor, 2 step candidate, 3 furniture/obstacle column
    const kind = new Uint8Array(N), h = new Float64Array(N).fill(NaN), floorTop = new Int16Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      const t = top[i];
      if (t < 0) continue;
      const l = levelOf(t);
      if (l) { kind[i] = 1; h[i] = l.F; floorTop[i] = t; continue; }
      kind[i] = 2;
      h[i] = minY + (t + 0.5) * v;
      floorTop[i] = t;
    }
    const nb4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    // An upper floor counts only where it is joined, at that height, to a
    // capture point standing on it (a 마루 with its room); a table top at the
    // same height elsewhere is not a floor.
    for (const l of evid.slice(1)) {
      const mark = new Uint8Array(N), st = [];
      for (const n of this.tour.nodes) {
        if (Math.abs(n.floorY - l.F) > 0.2) continue;
        const cx = Math.floor((n.position.x - o.box.min.x) / v), cz = Math.floor((n.position.z - o.box.min.z) / v);
        for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
          const X = cx + dx, Z = cz + dz;
          if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
          const j = Z * nx + X;
          if (kind[j] === 1 && h[j] === l.F && !mark[j]) { mark[j] = 1; st.push(j); }
        }
      }
      while (st.length) {
        const c = st.pop(), x = c % nx, z = (c - x) / nx;
        for (const [dx, dz] of nb4) {
          const X = x + dx, Z = z + dz;
          if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
          const j = Z * nx + X;
          if (kind[j] === 1 && h[j] === l.F && !mark[j] && Math.abs(floorTop[j] - floorTop[c]) <= 1) { mark[j] = 1; st.push(j); }
        }
      }
      for (let i = 0; i < N; i++) if (kind[i] === 1 && h[i] === l.F && !mark[i]) { kind[i] = 2; h[i] = minY + (floorTop[i] + 0.5) * v; }
    }

    // step candidates: connected patches (|dh| <= 10 cm). A step is solid
    // below, at least a foot deep, not bigger than a landing, and leads up:
    // next to a higher floor or a higher step (댓돌 before a 마루, stairs).
    // Everything else at that height is furniture (a chest, a radiator).
    const seen = new Uint8Array(N);
    const regionOf = new Int32Array(N).fill(-1);
    const regions = [];
    for (let i = 0; i < N; i++) {
      if (kind[i] !== 2 || seen[i]) continue;
      const comp = [i], st = [i];
      seen[i] = 1;
      while (st.length) {
        const c = st.pop();
        const x = c % nx, z = (c - x) / nx;
        for (const [dx, dz] of nb4) {
          const X = x + dx, Z = z + dz;
          if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
          const j = Z * nx + X;
          if (kind[j] === 2 && !seen[j] && Math.abs(h[j] - h[c]) <= 0.1) { seen[j] = 1; comp.push(j); st.push(j); }
        }
      }
      const inR = new Set(comp);
      const deep = comp.some((c) => nb4.every(([dx, dz]) => inR.has(c + dz * nx + dx)));
      let sup = 0;
      for (const c of comp) {
        const x = c % nx, z = (c - x) / nx, b = below(h[c]);
        const y0 = yi(b.F + 0.1), y1 = floorTop[c];
        let n = 0, k = 0;
        for (let y = y0; y <= y1; y++) { n++; k += sAt(x, z, y) ? 1 : 0; }
        sup += n ? k / n : 1;
      }
      sup /= comp.length;
      const area = comp.length * v * v;
      const hm = comp.reduce((a2, c) => a2 + h[c], 0) / comp.length;
      const id = regions.length;
      regions.push({ comp, hm, shape: deep && area >= this.minStepArea && area <= this.maxStepArea && sup >= this.minSupport, ok: false });
      for (const c of comp) regionOf[c] = id;
    }
    // leads up: grow from the higher floors downward
    for (let changed = true; changed; ) {
      changed = false;
      for (const R of regions) {
        if (R.ok || !R.shape) continue;
        let up = false;
        for (const c of R.comp) {
          const x = c % nx, z = (c - x) / nx;
          for (let dz = -2; dz <= 2 && !up; dz++)
            for (let dx = -2; dx <= 2 && !up; dx++) {
              const X = x + dx, Z = z + dz;
              if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
              const j = Z * nx + X;
              const hj = kind[j] === 1 ? h[j] : regionOf[j] >= 0 && regions[regionOf[j]].ok ? h[j] : NaN;
              if (hj > R.hm + 0.05 && hj <= R.hm + this.stepMax && (kind[j] !== 1 || hj > L[0] + 0.05)) up = true;
            }
          if (up) break;
        }
        if (up) { R.ok = true; changed = true; }
      }
    }
    let steps = 0;
    for (const R of regions) {
      const comp = R.comp, ok = R.ok;
      for (const c of comp) {
        if (ok) { steps++; continue; }
        // not a step: something low on the floor that the body clears stays floor (as before), else furniture
        const b = below(h[c]);
        if (b === evid[0] && floorTop[c] < yi(b.F + this.bodyLow) && b.d[c]) { kind[c] = 1; h[c] = b.F; }
        else { kind[c] = 3; h[c] = NaN; floorTop[c] = -1; }
      }
    }

    // ---- per column solid masks (bit y), for the body-band tests
    const W = Math.ceil(ny / 32);
    const mask = new Uint32Array(N * W);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        for (let y = 0; y < ny; y++) if (sAt(x, z, y)) mask[i * W + (y >> 5)] |= 1 << (y & 31);
      }
    const band = (y0, y1) => {
      const m = new Uint32Array(W);
      for (let y = Math.max(0, y0); y <= Math.min(ny - 1, y1); y++) m[y >> 5] |= 1 << (y & 31);
      return m;
    };
    const below1 = (y) => band(0, y); // voxels 0..y
    const r = Math.ceil(this.radius / v);
    const offs = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) offs.push([dx, dz]);
    const bandCache = new Map();
    const floorCache = new Map();

    const seeds = this.tour.nodes;
    const grid = { fy: L[0], levels: L, nx, nz, v, minX: o.box.min.x, minZ: o.box.min.z, walk: null, h: null, count: 0, steps, noFloor: false, stepMax: this.stepMax };
    const flood = (useFloor) => {
      // floor height of each cell that could be stood on
      const hh = new Float64Array(N).fill(NaN), ft = new Int16Array(N).fill(-1);
      for (let i = 0; i < N; i++) {
        if (kind[i] === 1 || kind[i] === 2) {
          if (kind[i] === 1 && useFloor && !evid.find((l) => l.F === h[i]).d[i]) continue;
          hh[i] = h[i]; ft[i] = floorTop[i];
        } else if (kind[i] === 0) {
          // a hole in a reconstructed floor: the level whose floor is right around it
          const l = useFloor ? evid.find((e) => e.d[i]) : evid[0];
          if (l) hh[i] = l.F;
        }
      }
      // free: own body band clear, and no neighbour sticking into it
      const free = new Uint8Array(N);
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          const j = z * nx + x;
          if (!Number.isFinite(hh[j])) continue;
          const b0 = yi(hh[j] + this.bodyLow), b1 = yi(hh[j] + this.bodyHigh);
          const key = b0 * 1000 + b1;
          let B = bandCache.get(key);
          if (!B) bandCache.set(key, (B = band(b0, b1)));
          let ok = true;
          for (const [dx, dz] of offs) {
            const X = x + dx, Z = z + dz;
            if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
            const k = Z * nx + X;
            // a neighbour's own floor is no obstacle unless it is a ledge too high to step onto
            const floorOk = ft[k] >= 0 && hh[k] - hh[j] <= this.stepMax;
            let F = null;
            if (floorOk) { F = floorCache.get(ft[k]); if (!F) floorCache.set(ft[k], (F = below1(ft[k]))); }
            for (let w = 0; w < W; w++) {
              let m = mask[k * W + w] & B[w];
              if (F) m &= ~F[w];
              if (m) { ok = false; break; }
            }
            if (!ok) break;
          }
          free[j] = ok ? 1 : 0;
        }
      const walk = new Uint8Array(N);
      const stack = [];
      grid.walk = free; // for nearest() while seeding
      grid.h = hh;
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
          if (free[j] && !walk[j] && Math.abs(hh[j] - hh[i]) <= this.stepMax) { walk[j] = 1; count++; stack.push(j); }
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

  // Floor height under (x, z), NaN where you can't stand.
  heightAt(g, x, z) {
    const c = this.cell(g, x, z);
    return c >= 0 && g.walk[c] === 1 ? g.h[c] : NaN;
  }

  // One small move a -> b: b standable and no higher/lower than a step.
  canStep(g, ax, az, bx, bz) {
    const b = this.cell(g, bx, bz);
    if (b < 0 || g.walk[b] !== 1) return false;
    const a = this.cell(g, ax, az);
    return !(a >= 0 && g.walk[a] === 1) || Math.abs(g.h[b] - g.h[a]) <= g.stepMax;
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

  // Straight segment stays on walkable cells, with no single height change
  // bigger than maxDh along it (default: a step).
  lineClear(g, ax, az, bx, bz, maxDh = g.stepMax) {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(d / (g.v * 0.5)));
    let prev = NaN;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const c = this.cell(g, ax + (bx - ax) * t, az + (bz - az) * t);
      if (c < 0 || g.walk[c] !== 1) return false;
      if (Math.abs(g.h[c] - prev) > maxDh + 1e-4) return false;
      prev = g.h[c];
    }
    return true;
  }

  // Walking route from `from` to `to` (world points) as waypoints [x, z, floor
  // height]; null when there is no way there. The goal snaps to the nearest
  // standable spot within `snap` metres (e.g. clicked on a table).
  route(g, from, to, { snap = 1.6 } = {}) {
    const s = this.canStand(g, from.x, from.z) ? this.cell(g, from.x, from.z) : this.nearest(g, from.x, from.z, 0.8);
    const t = this.canStand(g, to.x, to.z) ? this.cell(g, to.x, to.z) : this.nearest(g, to.x, to.z, snap);
    if (s < 0 || t < 0) return null;
    const goal = t === this.cell(g, to.x, to.z) ? [to.x, to.z] : this._xz(g, t);
    const start = [from.x, from.z];
    // straight on when it is level (or only threshold-high bumps)
    if (this.lineClear(g, start[0], start[1], goal[0], goal[1], 0.1)) return [[...start, g.h[s]], [...goal, g.h[t]]];

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
        const dh = Math.abs(g.h[j] - g.h[c]);
        if (dh > g.stepMax) continue;
        // no corner cutting through blocked cells (or past a ledge)
        if (dx && dz) {
          const a = z * nx + X, b = Z * nx + x;
          if (!g.walk[a] || !g.walk[b] || Math.abs(g.h[a] - g.h[c]) > g.stepMax || Math.abs(g.h[b] - g.h[c]) > g.stepMax) continue;
        }
        const ng = gScore[c] + w + stepCost(dh);
        if (ng < gScore[j]) { gScore[j] = ng; came[j] = c; open.push(ng + h(j), j); }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let c = t; c !== -1; c = came[c]) cells.push(c);
    cells.reverse();
    const hs = cells.map((c) => g.h[c]);
    const pts = cells.map((c) => this._xz(g, c));
    pts[0] = start;
    pts[pts.length - 1] = goal;
    // String pulling: keep only the corners a straight walk can't skip. A
    // shortcut may not climb more at once than the route it replaces does
    // (so it keeps the 댓돌 instead of jumping the whole step).
    const out = [[...pts[0], hs[0]]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      for (; j > i + 1; j--) {
        let m = 0;
        for (let k = i; k < j; k++) m = Math.max(m, Math.abs(hs[k + 1] - hs[k]));
        if (this.lineClear(g, pts[i][0], pts[i][1], pts[j][0], pts[j][1], Math.max(m, 0.1))) break;
      }
      out.push([...pts[j], hs[j]]);
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
