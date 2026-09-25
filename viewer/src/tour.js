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
    // Which splat file to load (?quality=full|mobile|lod overrides the choice):
    //  - desktop: the full scene (data.splat), unchanged.
    //  - phone, scene with a streamed level-of-detail tree (data.lod): a ladder,
    //    best first: streamed tree (full SH3 colour, first view in seconds) ->
    //    the desktop file -> the lighter SH-1 file. If iOS kills the tab while a
    //    rung is loading (it reloads the page after running out of memory), the
    //    next load in that tab starts one rung lower; see markLoaded().
    //  - phone, no tree: the SH-1 file (data.splatMobile), as before.
    const q = new URLSearchParams(location.search).get("quality");
    const phone = matchMedia("(pointer: coarse)").matches;
    this.phone = phone;
    const lod = data.lod?.splat ? data.lod : null;
    let mode = "full";
    if (q === "lod" && lod) mode = "lod";
    else if (q === "mobile" && data.splatMobile) mode = "mobile";
    else if (!q && phone) {
      const ladder = lod ? ["lod", "full", ...(data.splatMobile ? ["mobile"] : [])] : [data.splatMobile ? "mobile" : "full"];
      let step = 0;
      this.loadKey = `splattour-loading:${baseUrl}`;
      try {
        const prev = JSON.parse(sessionStorage.getItem(this.loadKey) || "null");
        if (prev && Number.isInteger(prev.step)) step = Math.min(prev.step + 1, ladder.length - 1);
        sessionStorage.setItem(this.loadKey, JSON.stringify({ step }));
      } catch {
        // storage blocked: always start at the top
      }
      this.stepDown = step > 0;
      mode = ladder[step];
    }
    this.splatMode = mode;
    const file = { full: data.splat, mobile: data.splatMobile, lod: lod?.splat }[mode];
    this.splatUrl = this.resolve(file);
    // A streamed load that errors (not a crash) drops to the desktop file.
    this.fallbackUrl = mode === "lod" ? this.resolve(data.splat) : null;
    // Byte sizes of the files, for a real percentage when the server compresses
    // on the fly and sends no Content-Length (Vercel serves .spz as brotli).
    this.bytes = data.bytes || {};
    const base = (u) => u.split("?")[0].split("/").pop();
    this.bytesOf = (url) => this.bytes[Object.keys(this.bytes).find((k) => base(k) === base(url)) ?? ""] || 0;
    this.lod = lod && {
      occupancy: lod.occupancy ? this.resolve(lod.occupancy) : null,
      plan: lod.plan ? this.resolve(lod.plan) : null,
      thumbs: lod.thumbs || null,
    };
    this.splatTransform = data.splatTransform || null;

    // Baked thumbnails (rendered from the full scene on desktop) replace the
    // start-up renders on phones: the streamed tree never holds the whole scene,
    // and the single-file rungs save 18 renders on a slow phone.
    const bakedThumb = (id) => (phone && lod?.thumbs ? this.resolve(lod.thumbs.replace("{id}", id)) : null);
    this.nodes = data.nodes.map((n, i) => ({
      id: String(n.id ?? `n${i}`),
      index: i,
      name: n.name || `시점 ${i + 1}`,
      position: new THREE.Vector3().fromArray(n.position),
      yaw: n.yaw ?? 0,
      pitch: n.pitch ?? -0.2,
      floorY: n.floorY ?? n.position[1] - (data.eyeHeight ?? 1.55),
      thumb: n.thumb ? this.resolve(n.thumb) : bakedThumb(String(n.id ?? `n${i}`)),
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

  // The page survived loading: forget the in-progress mark so the next load in
  // this tab starts from the best rung again.
  markLoaded() {
    try { if (this.loadKey) sessionStorage.removeItem(this.loadKey); } catch {}
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
