// Listing app data: spaces live in /spaces/<id>/ (viewer/public/spaces):
//   listing.json  texts, photos, rooms, amenities (edited by the researcher)
//   nav.json      capture points: the 360° hotspot graph, and for both
//                 conditions the room names, exploration range and plan
//   tasks.json    study tasks, identical in both conditions
export const PROD = import.meta.env.PROD;
// Published site: home "/", 3DGS viewer "/tour.html". Dev server: home.html, viewer "/".
export const HOME = PROD ? "/" : "/home.html";
export const TOUR = PROD ? "/tour.html" : "/";
export const spaceBase = (id) => `/spaces/${encodeURIComponent(id)}/`;

async function json(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} (${r.status})`);
  // the dev server answers unknown paths with index.html
  if (!(r.headers.get("content-type") || "").includes("json")) throw new Error(`${url}: not JSON`);
  return r.json();
}
const maybe = (url) => json(url).catch(() => null);

export async function listSpaces() {
  const idx = await json("/spaces/index.json");
  const all = await Promise.all(idx.spaces.map((id) => loadListing(id).catch(() => null)));
  return all.filter(Boolean);
}

export async function loadListing(id) {
  const base = spaceBase(id);
  const l = await json(base + "listing.json");
  l.base = base;
  // "f0466" -> photos/f0466.webp (small: -s.webp); a path with / or . is used as is
  l.photoUrl = (p, small = false) => (/[/.]/.test(p) ? base + p : `${base}photos/${p}${small ? "-s" : ""}.webp`);
  return l;
}

// `file`: another nav file in the same space folder (test variants, e.g. &navfile=nav.split-test.json).
export async function loadNav(id, listing, file = null) {
  const base = spaceBase(id);
  const alt = file && /^[\w.-]+\.json$/.test(file) ? file : null;
  const nav = await json(base + (alt || listing?.explore?.nav || "nav.json"));
  return prepareNav(nav, base);
}

export async function loadTasks(id, listing) {
  const t = await maybe(spaceBase(id) + (listing?.explore?.tasks || "tasks.json"));
  return t?.tasks || [];
}

// Index the capture graph: rooms by id, nodes by id, symmetric neighbours,
// one anchor point per room (mean of its capture points).
export function prepareNav(nav, base = "") {
  const rooms = new Map((nav.rooms || []).map((r) => [r.id, { ...r, nodes: [] }]));
  const abs = new URL(base, location.href);
  const nodes = nav.nodes.map((n) => ({ ...n, neighbors: [...(n.neighbors || [])], panoUrl: n.pano ? new URL(n.pano, abs).href : null }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    for (const m of n.neighbors) {
      const o = byId.get(m);
      if (o && !o.neighbors.includes(n.id)) o.neighbors.push(n.id);
    }
    if (!rooms.has(n.room)) rooms.set(n.room, { id: n.room, name: n.room, nodes: [] });
    rooms.get(n.room).nodes.push(n);
  }
  for (const r of rooms.values()) {
    const k = r.nodes.length || 1;
    r.anchor = r.anchor || [0, 1, 2].map((i) => r.nodes.reduce((s, n) => s + n.position[i], 0) / k);
  }
  const status = nav.status || {};
  const hasAll = nodes.every((n) => n.panoUrl);
  return {
    ...nav,
    nodes,
    byId,
    rooms,
    start: byId.get(nav.start) || nodes[0],
    // Ready for participants: every point has a real 360 image and nothing is flagged dev-only.
    panoReady: status.ready !== false && hasAll && !status.devPlaceholder,
    // Something to show at all (possibly a flagged dev placeholder).
    panoViewable: status.ready !== false,
    devOnly: !!status.devPlaceholder || !hasAll,
    pendingLabel: status.pendingLabel || "360 촬영본 준비 중",
    roomName(id) { return rooms.get(id)?.name ?? id ?? ""; },
    // Room at a world position: that of the nearest capture point (horizontal distance).
    nearest(x, z) {
      let best = null, bd = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.position[0] - x, n.position[2] - z);
        if (d < bd) { bd = d; best = n; }
      }
      return { node: best, dist: bd };
    },
  };
}

// Where the 3DGS scene of a space is published: bundled with the site
// (/scenes/<name>/), or in cloud storage (&from=cloud). null while it doesn't exist yet.
export async function findScene(name) {
  if (!name) return null;
  const local = await maybe(`/scenes/${encodeURIComponent(name)}/tour.json`);
  if (local?.splat) return { name, href: `${TOUR}?scene=${encodeURIComponent(name)}` };
  let storage = import.meta.env.VITE_STORAGE_URL || "";
  if (!storage) storage = (await maybe("/api/web/config"))?.storage || "";
  if (storage) {
    const cloud = await maybe(`${storage}/scenes/${encodeURIComponent(name)}/tour.json`);
    if (cloud?.splat) return { name, href: `${TOUR}?scene=${encodeURIComponent(name)}&from=cloud`, cloud: true };
  }
  return null;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Yaw (radians, 0 = toward -Z, + = turning left) from a to b on the floor plane.
export const bearing = (from, to) => Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
export const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
