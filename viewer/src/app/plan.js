// Schematic floor plan shared by both conditions: the capture points of
// nav.json (links between them, room names) and where you are, facing where.
// Drawn from the same data in both viewers, so neither condition gets a
// richer map than the other.
const COLORS = ["#f2b36b", "#8fc3a6", "#9bb7e8", "#e79aa6", "#c8a8e8", "#e8d27a", "#7fd0d6", "#d9a27f"];

export class PlanView {
  constructor(canvas, nav) {
    this.c = canvas;
    this.nav = nav;
    const xs = nav.nodes.map((n) => n.position[0]), zs = nav.nodes.map((n) => n.position[2]);
    const pad = 1.4;
    this.box = { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, z0: Math.min(...zs) - pad, z1: Math.max(...zs) + pad };
    this.roomColor = new Map([...nav.rooms.keys()].map((id, i) => [id, COLORS[i % COLORS.length]]));
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const d = Math.min(devicePixelRatio || 1, 2);
    this.c.width = Math.max(1, Math.round(r.width * d));
    this.c.height = Math.max(1, Math.round(r.height * d));
    this.dpr = d;
  }

  draw(pose) {
    const ctx = this.c.getContext("2d");
    const W = this.c.width, H = this.c.height, d = this.dpr || 1;
    if (!W) return;
    const b = this.box;
    const s = Math.min(W / (b.x1 - b.x0), H / (b.z1 - b.z0));
    const ox = (W - (b.x1 - b.x0) * s) / 2, oz = (H - (b.z1 - b.z0) * s) / 2;
    const P = (x, z) => [ox + (x - b.x0) * s, oz + (z - b.z0) * s];
    ctx.clearRect(0, 0, W, H);

    // links
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,.22)";
    ctx.lineWidth = 2 * d;
    ctx.beginPath();
    for (const n of this.nav.nodes)
      for (const m of n.neighbors) {
        if (m < n.id) continue;
        const o = this.nav.byId.get(m);
        if (!o) continue;
        ctx.moveTo(...P(n.position[0], n.position[2]));
        ctx.lineTo(...P(o.position[0], o.position[2]));
      }
    ctx.stroke();

    // capture points, coloured by room
    for (const n of this.nav.nodes) {
      const [x, y] = P(n.position[0], n.position[2]);
      ctx.fillStyle = this.roomColor.get(n.room) || "#fff";
      ctx.beginPath();
      ctx.arc(x, y, 3.2 * d, 0, Math.PI * 2);
      ctx.fill();
    }

    // room names at their anchors
    ctx.font = `600 ${11 * d}px Pretendard, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const r of this.nav.rooms.values()) {
      if (!r.nodes.length) continue;
      const [x, y] = P(r.anchor[0], r.anchor[2]);
      const w = ctx.measureText(r.name).width + 12 * d;
      ctx.fillStyle = "rgba(10,10,12,.62)";
      roundRect(ctx, x - w / 2, y - 18 * d, w, 16 * d, 8 * d);
      ctx.fill();
      ctx.fillStyle = this.roomColor.get(r.id) || "#fff";
      ctx.fillText(r.name, x, y - 10 * d);
    }

    // you: dot + view cone
    if (pose) {
      const [x, y] = P(pose.x, pose.z);
      // screen: +x right, +y down (= +z). Facing (-sin yaw, -cos yaw) in (x, z).
      const a = Math.atan2(-Math.cos(pose.yaw), -Math.sin(pose.yaw));
      const g = ctx.createRadialGradient(x, y, 0, x, y, 30 * d);
      g.addColorStop(0, "rgba(255,255,255,.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, 30 * d, a - 0.55, a + 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#e0565b";
      ctx.lineWidth = 3 * d;
      ctx.beginPath();
      ctx.arc(x, y, 6 * d, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
