// Floor plan shared by both conditions (360° 시점 탐색 / 3DGS 자유 시점 탐색):
// the same baked plan image (scripts/bake-plan.mjs → plan.json, plan.png,
// plan-rooms.png), the same room names and the same "내 위치" marker, so
// neither condition gets a richer map. North-up and fixed: the map never
// rotates, only the heading cone does (&planup=heading exists for debugging).
// Without a baked plan (scene not trained yet) the rooms are drawn as soft
// shapes around their capture points.

const BLUE = "#2F7CF6";
const INK = "#3D3A35";
const DEBUG_HEADING_UP = new URLSearchParams(location.search).get("planup") === "heading";

function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}

export class PlanData {
  // nav: prepared nav.json (data.js); base: /spaces/<id>/
  static async load(nav, base, { condition } = {}) {
    const p = new PlanData(nav);
    if (nav.spatialPlan && (condition === "splat" || condition === "pano")) {
      try {
        const r = await fetch(base + nav.spatialPlan, { cache: "no-cache" });
        if (!r.ok) throw new Error("no spatial plan");
        const j = await r.json();
        if (j.scene !== nav.scene) throw new Error("spatial plan coordinate frame mismatch");
        p._fromIllustration(j, await loadImage(base + j.image));
        p.marker = j.marker;
        return p;
      } catch (error) {
        console.warn("[plan] Spatial map unavailable; using the existing plan", error);
      }
    }
    try {
      const r = await fetch(base + "plan.json", { cache: "no-cache" });
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error("no plan");
      const j = await r.json();
      const [img, idx] = await Promise.all([loadImage(base + j.image), loadImage(base + j.roomImage)]);
      p._fromBaked(j, img, idx);
    } catch {
      p._schematic();
    }
    return p;
  }

  constructor(nav) { this.nav = nav; }

  _fromIllustration(j, img) {
    // Monotone, piecewise calibration preserves continuous walking across
    // room boundaries; it never snaps the marker to the nearest capture node.
    const axis = (knots) => {
      if (!Array.isArray(knots) || knots.length < 2 || knots.some((p, i) =>
        p.length !== 2 || !p.every(Number.isFinite) ||
        (i > 0 && (p[0] <= knots[i - 1][0] || p[1] <= knots[i - 1][1])))) {
        throw new Error("Invalid spatial map calibration");
      }
      return (v) => {
        let i = 0;
        while (i < knots.length - 2 && v > knots[i + 1][0]) i++;
        const [a, b] = knots[i], [c, d] = knots[i + 1];
        return b + (v - a) / (c - a) * (d - b);
      };
    };
    const u = axis(j.axes.u), w = axis(j.axes.w);
    if (!Number.isFinite(j.rotation)) throw new Error("Invalid spatial map rotation");
    const c = Math.cos(j.rotation), s = Math.sin(j.rotation);
    this.toImg = (x, z) => [u(x * c + z * s), w(-x * s + z * c)];
    this.illustrated = true;
    // Calibration uses a declared reference size, independent of the PNG's
    // native/export resolution (the uploaded original can be larger).
    this.W = j.referenceSize?.[0] || img.width;
    this.H = j.referenceSize?.[1] || img.height;
    this.image = img;
    this.rot = j.rotation;
    this.compactBounds = j.compactBounds;
    // The supplied artwork already contains room labels and colours.
    this.labels = new Map();
    this.highlight = new Map();
  }

  _fromBaked(j, img, idx) {
    this.baked = true;
    const c = Math.cos(j.rotation), s = Math.sin(j.rotation), [u0, w0, u1, w1] = j.bounds, k = j.pxPerM;
    this.W = img.width;
    this.H = img.height;
    this.toImg = (x, z) => [((x * c + z * s) - u0) * k, ((-x * s + z * c) - w0) * k];
    this.pxPerM = k;
    this.rot = j.rotation;
    this.image = img;
    this.labels = new Map(Object.entries(j.rooms).map(([id, r]) => [id, r.label]));
    // one tinted overlay per room, cut from the exact-colour room image
    const cv = document.createElement("canvas");
    cv.width = this.W; cv.height = this.H;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(idx, 0, 0);
    const src = g.getImageData(0, 0, this.W, this.H).data;
    this.highlight = new Map();
    for (const [id, r] of Object.entries(j.rooms)) {
      const o = document.createElement("canvas");
      o.width = this.W; o.height = this.H;
      const og = o.getContext("2d");
      const d = og.createImageData(this.W, this.H);
      for (let i = 0; i < src.length; i += 4) if (src[i + 3] > 200 && Math.abs(src[i] - r.color) <= 2 && src[i + 1] < 3) d.data.set([47, 124, 246, 46], i);
      og.putImageData(d, 0, 0);
      this.highlight.set(id, o);
    }
  }

  // Soft room shapes around the capture points (until a plan is baked).
  _schematic() {
    this.baked = false;
    const nav = this.nav, k = 60, pad = 2.6;
    const xs = nav.nodes.map((n) => n.position[0]), zs = nav.nodes.map((n) => n.position[2]);
    const x0 = Math.min(...xs) - pad, z0 = Math.min(...zs) - pad;
    this.W = Math.ceil((Math.max(...xs) + pad - x0) * k);
    this.H = Math.ceil((Math.max(...zs) + pad - z0) * k);
    this.toImg = (x, z) => [(x - x0) * k, (z - z0) * k];
    this.pxPerM = k;
    this.rot = 0;
    const PAL = ["#F4E9D8", "#E2ECDE", "#E0E8F3", "#F3E2E0", "#ECE4F2", "#F2EED6", "#DCEEEC", "#EEE6DE"];
    const mk = () => { const c = document.createElement("canvas"); c.width = this.W; c.height = this.H; return c; };
    const img = mk(), g = img.getContext("2d");
    const rooms = [...nav.rooms.values()].filter((r) => r.nodes.length);
    const blob = (ctx, r, rad) => {
      ctx.beginPath();
      for (const n of r.nodes) { const [x, y] = this.toImg(n.position[0], n.position[2]); ctx.moveTo(x + rad, y); ctx.arc(x, y, rad, 0, Math.PI * 2); }
      for (const n of r.nodes) for (const m of n.neighbors) {
        const o = nav.byId.get(m);
        if (o?.room !== r.id) continue;
        const [ax, ay] = this.toImg(n.position[0], n.position[2]), [bx, by] = this.toImg(o.position[0], o.position[2]);
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
    };
    rooms.forEach((r, i) => {
      g.fillStyle = PAL[i % PAL.length]; g.strokeStyle = PAL[i % PAL.length]; g.lineWidth = 2.2 * k; g.lineCap = "round";
      blob(g, r, 1.25 * k); g.fill(); g.stroke();
    });
    // outline around everything
    const out = mk(), og = out.getContext("2d");
    og.drawImage(img, 0, 0);
    og.globalCompositeOperation = "source-in";
    og.fillStyle = "#CFC7BA";
    og.fillRect(0, 0, this.W, this.H);
    const fin = mk(), fg = fin.getContext("2d");
    for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, 2], [-2, 2], [2, -2]]) fg.drawImage(out, dx, dy);
    fg.drawImage(img, 0, 0);
    this.image = fin;
    this.labels = new Map(rooms.map((r) => [r.id, [r.anchor[0], r.anchor[2]]]));
    this.highlight = new Map(rooms.map((r) => {
      const h = mk(), hg = h.getContext("2d");
      hg.fillStyle = "rgba(47,124,246,0.18)"; hg.strokeStyle = "rgba(47,124,246,0.18)"; hg.lineWidth = 2.2 * k; hg.lineCap = "round";
      blob(hg, r, 1.25 * k); hg.fill(); hg.stroke();
      return [r.id, h];
    }));
  }

  // Screen angle (canvas, y down) of a world yaw on the plan.
  screenAngle(yaw, pose) {
    if (this.illustrated && pose) {
      // Apply the same local warp to the heading as to the live position.
      const e = 0.01, dx = -Math.sin(yaw) * e, dz = -Math.cos(yaw) * e;
      const a = this.toImg(pose.x - dx, pose.z - dz);
      const b = this.toImg(pose.x + dx, pose.z + dz);
      return Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw), c = Math.cos(this.rot), s = Math.sin(this.rot);
    return Math.atan2(-dx * s + dz * c, dx * c + dz * s);
  }

  // Draw into ctx (device px). view: {scale (img px -> device px), ox, oy (device px of img origin)}
  draw(ctx, view, st, { dpr = 1, compact = false, t = performance.now() } = {}) {
    const { scale, ox, oy } = view;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    if (compact && this.compactBounds) {
      ctx.beginPath();
      ctx.rect(...this.compactBounds);
      ctx.clip();
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.image, 0, 0, this.W, this.H);
    const hl = st.room && this.highlight.get(st.room);
    if (hl) ctx.drawImage(hl, 0, 0);
    if (this.nav.showMapRoutes) {
      ctx.strokeStyle = "rgba(47,124,246,0.35)";
      ctx.lineWidth = 1.5 * dpr / scale;
      ctx.beginPath();
      for (const n of this.nav.nodes) for (const id of n.neighbors) {
        if (n.id > id) continue;
        const to = this.nav.byId.get(id);
        if (!to) continue;
        ctx.moveTo(...this.toImg(n.position[0], n.position[2]));
        ctx.lineTo(...this.toImg(to.position[0], to.position[2]));
      }
      ctx.stroke();
      ctx.fillStyle = "#fff";
      for (const n of this.nav.nodes) {
        const [x, y] = this.toImg(n.position[0], n.position[2]);
        ctx.beginPath(); ctx.arc(x, y, 2.5 * dpr / scale, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();

    // room names (constant size on screen)
    const fs = (compact ? 10.5 : 13) * dpr;
    ctx.font = `650 ${fs}px Pretendard, "Pretendard Variable", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const many = this.labels.size > 4;
    for (const [id, [x, z]] of this.labels) {
      const cur = id === st.room;
      if (compact && many && !cur) continue;
      const [ix, iy] = this.toImg(x, z);
      const px = ox + ix * scale, py = oy + iy * scale;
      const name = this.nav.roomName(id);
      ctx.lineWidth = 3.5 * dpr;
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineJoin = "round";
      ctx.strokeText(name, px, py);
      ctx.fillStyle = cur ? "#1F5FD0" : INK;
      ctx.fillText(name, px, py);
    }

    // 내 위치: heading cone (camera's horizontal field of view), pulse, blue dot
    if (st.pose) {
      const [ix, iy] = this.toImg(st.pose.x, st.pose.z);
      const px = ox + ix * scale, py = oy + iy * scale;
      const a = this.screenAngle(st.pose.yaw, st.pose), half = (st.pose.hfov || 1.2) / 2;
      if (this.marker) {
        // Reproduce the reference as canvas geometry without its opaque white
        // background. Its dot is the pivot; the reference cone points up.
        const { compactScale, fullScale } = this.marker;
        const k = (compact ? compactScale : fullScale) * dpr;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(a + Math.PI / 2);
        ctx.scale(k, k);
        ctx.fillStyle = "rgba(220,220,220,0.65)";
        ctx.beginPath();
        ctx.arc(0, 0, 48, 0, Math.PI * 2);
        ctx.fill();
        const cone = ctx.createLinearGradient(0, 0, 0, -138);
        cone.addColorStop(0, "rgba(29,105,255,0.8)");
        cone.addColorStop(1, "rgba(29,105,255,0)");
        ctx.fillStyle = cone;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-92, -138);
        ctx.lineTo(92, -138);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(0, 0, 27, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1d69ff";
        ctx.beginPath();
        ctx.arc(0, 0, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }
      const R = (compact ? 40 : 72) * dpr;
      const gr = ctx.createRadialGradient(px, py, 0, px, py, R);
      gr.addColorStop(0, "rgba(47,124,246,0.55)");
      gr.addColorStop(0.7, "rgba(47,124,246,0.2)");
      gr.addColorStop(1, "rgba(47,124,246,0.04)");
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.arc(px, py, R, a - half, a + half);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(47,124,246,0.45)";
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(a - half) * R * 0.85, py + Math.sin(a - half) * R * 0.85);
      ctx.lineTo(px, py);
      ctx.lineTo(px + Math.cos(a + half) * R * 0.85, py + Math.sin(a + half) * R * 0.85);
      ctx.stroke();
      const ph = (t % 1800) / 1800;
      ctx.fillStyle = `rgba(47,124,246,${(0.3 * (1 - ph)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, (8 + 14 * ph) * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = "rgba(0,0,0,0.28)";
      ctx.shadowBlur = 4 * dpr;
      ctx.shadowOffsetY = 1 * dpr;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(px, py, 8.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.fillStyle = BLUE;
      ctx.beginPath();
      ctx.arc(px, py, 5.8 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Canvas + interaction: "mini" (fits the whole plan) or "full" (zoom, pan).
export class PlanCanvas {
  constructor(canvas, data, { compact = false, interactive = false } = {}) {
    this.c = canvas;
    this.data = data;
    this.compact = compact;
    this.zoom = 1;
    this.pan = [0, 0];
    this.moved = 0;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    if (interactive) this._bindGestures();
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.c.width = Math.max(1, Math.round(r.width * this.dpr));
    this.c.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  reset() { this.zoom = 1; this.pan = [0, 0]; }

  _fit() {
    const d = this.data, W = this.c.width, H = this.c.height;
    const m = (this.compact ? 10 : 22) * this.dpr;
    const [x, y, width, height] = (this.compact && d.compactBounds) || [0, 0, d.W, d.H];
    const base = Math.min((W - 2 * m) / width, (H - 2 * m) / height);
    const scale = base * this.zoom;
    return { scale, ox: (W - width * scale) / 2 - x * scale + this.pan[0], oy: (H - height * scale) / 2 - y * scale + this.pan[1] };
  }

  draw(st) {
    const ctx = this.c.getContext("2d");
    ctx.clearRect(0, 0, this.c.width, this.c.height);
    if (!this.c.width) return;
    let view = this._fit();
    if (DEBUG_HEADING_UP && st.pose) {
      // debugging only: rotate the map so that the heading points up
      const [ix, iy] = this.data.toImg(st.pose.x, st.pose.z);
      const cx = this.c.width / 2, cy = this.c.height / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 2 - this.data.screenAngle(st.pose.yaw, st.pose));
      ctx.translate(-cx, -cy);
      view = { ...view, ox: cx - ix * view.scale, oy: cy - iy * view.scale };
      this.data.draw(ctx, view, st, { dpr: this.dpr, compact: this.compact });
      ctx.restore();
    } else this.data.draw(ctx, view, st, { dpr: this.dpr, compact: this.compact });
    if (!this.data.illustrated) this._north(ctx);
  }

  // small "N" badge: up on the plan
  _north(ctx) {
    const d = this.dpr, r = (this.compact ? 9 : 13) * d, x = this.c.width - r - (this.compact ? 7 : 14) * d, y = r + (this.compact ? 7 : 14) * d;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.shadowColor = "rgba(0,0,0,0.15)";
    ctx.shadowBlur = 3 * d;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#D9534F";
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.78);
    ctx.lineTo(x - r * 0.3, y - r * 0.38);
    ctx.lineTo(x + r * 0.3, y - r * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = `750 ${r * 0.85}px Pretendard, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", x, y + r * 0.16);
  }

  _bindGestures() {
    const c = this.c, pts = new Map();
    let last = null, pinch0 = 0, zoom0 = 1;
    const clampZoom = (z) => Math.min(5, Math.max(1, z));
    const zoomAt = (z, cx, cy) => {
      const nz = clampZoom(z), k = nz / this.zoom;
      const W = c.width / 2, H = c.height / 2;
      this.pan = [(this.pan[0] - (cx - W)) * k + (cx - W), (this.pan[1] - (cy - H)) * k + (cy - H)];
      this.zoom = nz;
      if (nz === 1) this.pan = [0, 0];
    };
    const dev = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr]; };
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, dev(e));
      if (pts.size === 1) { last = dev(e); this.moved = 0; }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); zoom0 = this.zoom; }
    });
    c.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = dev(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        zoomAt(zoom0 * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch0), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        this.moved += 10;
      } else if (last) {
        this.pan[0] += p[0] - last[0];
        this.pan[1] += p[1] - last[1];
        this.moved += Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]);
        last = p;
      }
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size === 0) last = null; else last = [...pts.values()][0]; };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("wheel", (e) => { e.preventDefault(); const [x, y] = dev(e); zoomAt(this.zoom * Math.exp(-e.deltaY * 0.002), x, y); this.moved += 10; }, { passive: false });
  }
}
