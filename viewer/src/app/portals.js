// Rooms captured as separate 3DGS models ("portal" doors), 3DGS condition.
// nav.json can give a room its own scene (rooms[].scene) and the box it fills
// in the space frame (rooms[].region: {center, size, yaw}). Every model is
// aligned to the same space frame (its tour.json splatTransform), so going
// through a door needs no teleport: near a door the next room's model is
// loaded, and from then on both are drawn, each only where it belongs. The
// room model shows inside its region, every other model is hidden there
// (Spark SplatEdit boxes, soft 10 cm seam). Without a region the two models
// cross-fade by which side of the door the eye is on.
//
// At most two models are held (current + next); walls from a newly loaded
// model are merged into the walking map so the walker can go through.
import * as THREE from "three";
import { SplatEdit, SplatEditSdf } from "@sparkjsdev/spark";
import { doorLocal } from "../doors.js";

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Portals {
  // o: { nav (prepared), doors (prepared), primary: {name, splat, occ, tour}, loadScene(name) -> {splat, occ, tour},
  //      walkMap, log, preloadDist }
  constructor(o) {
    this.o = o;
    const primary = o.primary.name;
    this.sceneOf = (room) => o.nav.rooms.get(room)?.scene || primary;
    this.regionOf = new Map(); // scene -> region
    for (const r of o.nav.rooms.values()) if (r.scene && r.region && !this.regionOf.has(r.scene)) this.regionOf.set(r.scene, r.region);
    this.doors = o.doors.filter((d) => this.sceneOf(d.fromRoom) !== this.sceneOf(d.toRoom));
    this.models = new Map([[primary, { name: primary, ...o.primary, ready: true, alpha: 1, fade: 1, used: 0 }]]);
    this.preloadDist = o.preloadDist ?? 6;
    this.time = 0;
    this.active = this.doors.length > 0;
    if (this.active) console.info(`[portals] ${this.doors.length} door(s) to other models: ${this.doors.map((d) => `${d.id} -> ${this.sceneOf(d.fromRoom)} | ${this.sceneOf(d.toRoom)}`).join(", ")}`);
  }

  // Both sides of this door are loaded (true for ordinary doors).
  ready(d) {
    if (!this.doors.includes(d)) return true;
    return [this.sceneOf(d.fromRoom), this.sceneOf(d.toRoom)].every((s) => this.models.get(s)?.ready);
  }

  ensure(name) {
    let m = this.models.get(name);
    if (m) return m.promise || Promise.resolve(m);
    m = { name, ready: false, alpha: 0, fade: 0, used: this.time };
    this.models.set(name, m);
    const t0 = performance.now();
    this._evict(name);
    const room = [...this.o.nav.rooms.values()].find((r) => r.scene === name) || null;
    m.promise = this.o.loadScene(name, room).then((r) => {
      Object.assign(m, r, { ready: true, promise: null });
      m.splat.opacity = 0;
      this._mergeWalls(m);
      this._mergeNodes(m);
      this._applyEdits();
      const ms = Math.round(performance.now() - t0);
      console.info(`[portals] ${name} ready in ${ms} ms`);
      this.o.log?.("portal_load", { scene: name, ms });
      return m;
    }).catch((e) => {
      console.warn(`[portals] ${name} failed:`, e);
      this.models.delete(name);
      throw e;
    });
    m.promise.catch(() => {});
    return m.promise;
  }

  // A model's mesh was replaced (the streamed tree by the full file, see main.js):
  // same opacity and room edits on the new one.
  replaceSplat(name, mesh) {
    const m = this.models.get(name);
    if (!m || !m.splat) return;
    mesh.opacity = m.splat.opacity;
    m.splat = mesh;
    if (name === this.o.primary.name) this.o.primary.splat = mesh;
    this._applyEdits();
  }

  // Keep at most two models: drop the least recently needed one (never the primary's walls, which stay merged).
  _evict(keep) {
    const loaded = [...this.models.values()].filter((m) => m.name !== keep);
    while (loaded.length > 1) {
      loaded.sort((a, b) => a.used - b.used);
      const m = loaded.shift();
      if (m.name === this.inside) { loaded.push(m); if (loaded.every((x) => x.name === this.inside)) break; continue; }
      if (m.splat) { m.splat.parent?.remove(m.splat); m.splat.dispose?.(); }
      this.models.delete(m.name);
      console.info(`[portals] released ${m.name}`);
    }
  }

  // The newly loaded model's walls go into the walking map (the union of both grids).
  _mergeWalls(m) {
    const a = this.o.primary.occ, b = m.occ;
    if (!a || !b || a === b) return;
    const region = this.regionOf.get(m.name);
    const v = a.voxel;
    const box = a.box.clone().union(b.box);
    const size = box.getSize(new THREE.Vector3());
    const nx = Math.ceil(size.x / v), ny = Math.ceil(size.y / v), nz = Math.ceil(size.z / v);
    const solid = new Uint8Array(nx * ny * nz);
    const p = new THREE.Vector3();
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          p.set(box.min.x + (x + 0.5) * v, box.min.y + (y + 0.5) * v, box.min.z + (z + 0.5) * v);
          // with a region, each model's walls count only on its own side (a room model
          // also holds blurry bits of what it saw through its windows)
          if (region ? (this.inRegion(m.name, p) ? b.occupied(p) : a.occupied(p)) : a.occupied(p) || b.occupied(p)) solid[(y * nz + z) * nx + x] = 1;
        }
    // the doorways of portal doors are open (each model captured its door closed)
    for (const d of this.doors) {
      const W = d.halfW - 0.03, y0 = d.cy + 0.03, y1 = d.cy + d.height;
      for (let y = 0; y < ny; y++) {
        const wy = box.min.y + (y + 0.5) * v;
        if (wy < y0 || wy > y1) continue;
        for (let z = 0; z < nz; z++)
          for (let x = 0; x < nx; x++) {
            const wx = box.min.x + (x + 0.5) * v, wz = box.min.z + (z + 0.5) * v;
            const { nd, lat } = doorLocal(d, wx, wz);
            if (Math.abs(lat) <= W && Math.abs(nd) <= 0.35) solid[(y * nz + z) * nx + x] = 0;
          }
      }
    }
    // in place: every user of the grid (walking, clicks, lamps) keeps its reference
    Object.assign(a, { box, nx, ny, nz, solid });
    this.o.walkMap?.levels.clear();
  }

  // Capture points of the new model (floor heights, walk seeds), unless the same point is already known.
  _mergeNodes(m) {
    const tour = this.o.primary.tour, t2 = m.tour;
    if (!tour || !t2 || tour === t2) return;
    const idMap = new Map();
    for (const n of t2.nodes) {
      const same = tour.nodes.find((k) => k.position.distanceTo(n.position) < 0.1);
      if (same) { idMap.set(n.id, same.id); continue; }
      const id = tour.byId.has(n.id) ? `${m.name}:${n.id}` : n.id;
      const nn = { ...n, id, index: tour.nodes.length };
      tour.nodes.push(nn);
      tour.byId.set(id, nn);
      tour.adj.set(id, new Set());
      idMap.set(n.id, id);
    }
    for (const [a, set] of t2.adj) for (const b of set) {
      const A = idMap.get(a), B = idMap.get(b);
      if (A && B && A !== B) { tour.adj.get(A)?.add(B); tour.adj.get(B)?.add(A); }
    }
    // through each door to this model: its capture point nearest the door <-> the nearest one outside
    const mine = new Set(idMap.values());
    for (const d of this.doors) {
      const near = (ids) => [...ids].map((id) => tour.byId.get(id)).filter(Boolean).sort((p, q) => Math.hypot(p.position.x - d.cx, p.position.z - d.cz) - Math.hypot(q.position.x - d.cx, q.position.z - d.cz))[0];
      const inside = near(mine), outside = near(tour.nodes.filter((n) => !mine.has(n.id)).map((n) => n.id));
      if (inside && outside) { tour.adj.get(inside.id).add(outside.id); tour.adj.get(outside.id).add(inside.id); }
    }
  }

  // Region boxes: the room's model only inside its box, the others only outside.
  _applyEdits() {
    const regions = [...this.models.values()].filter((m) => m.ready && this.regionOf.has(m.name));
    for (const m of this.models.values()) {
      if (!m.ready || !m.splat) continue;
      const own = this.regionOf.get(m.name);
      const edits = [];
      m.hides = [];
      if (own) edits.push(this._box(own, true).edit);
      for (const r of regions) if (r !== m) {
        // hidden where the room model is, as that one fades in
        const b = this._box(this.regionOf.get(r.name), false);
        edits.push(b.edit);
        m.hides.push({ sdf: b.sdf, owner: r });
      }
      m.splat.edits = edits.length ? edits : null;
    }
  }

  _box(region, keepInside) {
    const edit = new SplatEdit({ rgbaBlendMode: "multiply", softEdge: 0.1, invert: keepInside });
    const sdf = new SplatEditSdf({ type: "box", opacity: 0 });
    sdf.position.fromArray(region.center);
    sdf.rotation.y = ((region.yaw || 0) * Math.PI) / 180;
    sdf.scale.set(region.size[0] / 2, region.size[1] / 2, region.size[2] / 2);
    sdf.updateMatrixWorld(true);
    edit.add(sdf);
    edit.updateMatrixWorld(true);
    return { edit, sdf };
  }

  inRegion(name, p) {
    const r = this.regionOf.get(name);
    if (!r) return false;
    const yaw = ((r.yaw || 0) * Math.PI) / 180;
    const dx = p.x - r.center[0], dz = p.z - r.center[2];
    const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw), lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    return Math.abs(lx) <= r.size[0] / 2 && Math.abs(lz) <= r.size[2] / 2 && Math.abs(p.y - r.center[1]) <= r.size[1] / 2;
  }

  // Per frame: preload near a door, fade models in, cross-fade where no region is given.
  update(dt, eye) {
    if (!this.active) return;
    this.time += dt;
    for (const d of this.doors) {
      const dist = Math.hypot(eye.x - d.cx, eye.z - d.cz);
      if (dist < this.preloadDist) for (const s of [this.sceneOf(d.fromRoom), this.sceneOf(d.toRoom)]) {
        this.ensure(s);
        const m = this.models.get(s);
        if (m) m.used = this.time;
      }
    }
    // the model the eye is in
    let inside = null;
    for (const m of this.models.values()) if (m.ready && this.inRegion(m.name, eye)) inside = m.name;
    this.inside = inside || this.o.primary.name;
    // region-less pairs: fade by the side of the nearest portal door
    let fadeTo = null;
    let best = Infinity;
    for (const d of this.doors) {
      const a = this.sceneOf(d.fromRoom), b = this.sceneOf(d.toRoom);
      if (this.regionOf.has(a) || this.regionOf.has(b)) continue;
      const { nd, lat } = doorLocal(d, eye.x, eye.z);
      const dist = Math.hypot(nd, Math.max(0, Math.abs(lat) - d.halfW));
      if (dist < best && this.models.get(a)?.ready && this.models.get(b)?.ready) { best = dist; fadeTo = { a, b, s: smooth(-0.35, 0.35, nd) }; }
    }
    for (const m of this.models.values()) {
      if (!m.ready || !m.splat) continue;
      m.fade = Math.min(1, m.fade + dt / 0.6); // newly loaded: fade in over 0.6 s
      let w = m.fade;
      if (fadeTo && (m.name === fadeTo.a || m.name === fadeTo.b)) w *= m.name === fadeTo.b ? fadeTo.s : 1 - fadeTo.s;
      if (Math.abs(m.splat.opacity - w) > 1e-3) m.splat.opacity = w;
      for (const h of m.hides || []) { const o = 1 - h.owner.fade; if (Math.abs(h.sdf.opacity - o) > 1e-3) h.sdf.opacity = o; }
    }
  }
}
