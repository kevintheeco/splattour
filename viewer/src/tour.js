// Tour data model: loads tour.json, validates it, and answers graph queries
// (neighbors, shortest path) for the navigator.
import * as THREE from "three";

export async function loadTour(baseUrl) {
  const res = await fetch(new URL("tour.json", baseUrl));
  if (!res.ok) throw new Error(`tour.json을 불러오지 못했습니다 (${res.status})`);
  return new Tour(await res.json(), baseUrl);
}

export class Tour {
  constructor(data, baseUrl) {
    if (!data.splat) throw new Error("tour.json에 splat 경로가 없습니다");
    if (!Array.isArray(data.nodes) || data.nodes.length === 0) throw new Error("tour.json에 시점(nodes)이 없습니다");
    this.data = data;
    this.baseUrl = baseUrl;
    this.title = data.title || "Untitled";
    this.subtitle = data.subtitle || "";
    this.eyeHeight = data.eyeHeight ?? 1.55;
    // Phones get the lighter SH-1 variant when there is one (?quality=full|mobile overrides).
    const q = new URLSearchParams(location.search).get("quality");
    const phone = q ? q === "mobile" : matchMedia("(pointer: coarse)").matches;
    this.splatUrl = this.resolve(phone && data.splatMobile ? data.splatMobile : data.splat);
    this.splatTransform = data.splatTransform || null;

    this.nodes = data.nodes.map((n, i) => ({
      id: String(n.id ?? `n${i}`),
      index: i,
      name: n.name || `시점 ${i + 1}`,
      position: new THREE.Vector3().fromArray(n.position),
      yaw: n.yaw ?? 0,
      pitch: n.pitch ?? -0.2,
      floorY: n.floorY ?? n.position[1] - (data.eyeHeight ?? 1.55),
      thumb: n.thumb ? this.resolve(n.thumb) : null,
      pano: n.pano ? this.resolve(n.pano) : null,
      group: n.group ?? null,
    }));
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));

    this.adj = new Map(this.nodes.map((n) => [n.id, new Set()]));
    for (const [a, b] of data.edges || []) {
      if (!this.byId.has(a) || !this.byId.has(b) || a === b) continue;
      this.adj.get(a).add(b);
      this.adj.get(b).add(a);
    }
    this.start = this.byId.get(data.start) || this.nodes[0];
  }

  resolve(p) {
    return new URL(p, this.baseUrl).href;
  }

  neighbors(node) {
    return [...this.adj.get(node.id)].map((id) => this.byId.get(id));
  }

  dist(a, b) {
    return a.position.distanceTo(b.position);
  }

  // Dijkstra over edge lengths. Returns [from, ..., to] or null if unreachable.
  path(from, to) {
    if (from === to) return [from];
    const dist = new Map([[from.id, 0]]);
    const prev = new Map();
    const open = new Set([from.id]);
    while (open.size) {
      let cur = null;
      let best = Infinity;
      for (const id of open) {
        const d = dist.get(id);
        if (d < best) { best = d; cur = id; }
      }
      open.delete(cur);
      if (cur === to.id) break;
      const cn = this.byId.get(cur);
      for (const nid of this.adj.get(cur)) {
        const nd = best + this.dist(cn, this.byId.get(nid));
        if (nd < (dist.get(nid) ?? Infinity)) {
          dist.set(nid, nd);
          prev.set(nid, cur);
          open.add(nid);
        }
      }
    }
    if (!prev.has(to.id)) return null;
    const out = [to];
    let id = to.id;
    while (prev.has(id)) {
      id = prev.get(id);
      out.unshift(this.byId.get(id));
    }
    return out;
  }

  nearestNode(point, { maxDist = Infinity, horizontal = true } = {}) {
    let best = null;
    let bd = maxDist;
    for (const n of this.nodes) {
      const dx = n.position.x - point.x;
      const dz = n.position.z - point.z;
      const d = horizontal ? Math.hypot(dx, dz) : n.position.distanceTo(point);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
}
