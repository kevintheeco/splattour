// Top-down floor plan generated from the splat itself: splat centres in the
// wall-height band are binned on the floor plane, so walls and furniture
// show up as a drawn plan. Nodes, edges and the view cone are overlaid.
import * as THREE from "three";

export class Minimap {
  constructor({ canvas, tour, splat, rig, look }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tour = tour;
    this.rig = rig;
    this.look = look;
    this.plan = null;
    this.hoverNode = null;
    this._build(splat);
    canvas.addEventListener("pointermove", (e) => {
      this.hoverNode = this._nodeAt(e);
      canvas.style.cursor = this.hoverNode ? "pointer" : "default";
    });
    canvas.addEventListener("pointerleave", () => (this.hoverNode = null));
    canvas.addEventListener("click", (e) => {
      const n = this._nodeAt(e);
      if (n) this.onPick?.(n);
    });
  }

  _build(splat) {
    const nodes = this.tour.nodes;
    const floor = nodes.reduce((s, n) => s + n.floorY, 0) / nodes.length;
    const lo = floor + 0.25;
    const hi = floor + this.tour.eyeHeight + 0.6;

    // Bounds from nodes, padded; plan resolution ~4cm.
    const box = new THREE.Box2();
    for (const n of nodes) box.expandByPoint(new THREE.Vector2(n.position.x, n.position.z));
    box.expandByScalar(4);
    const size = box.getSize(new THREE.Vector2());
    const res = 0.04;
    const W = Math.min(1024, Math.ceil(size.x / res));
    const H = Math.min(1024, Math.ceil(size.y / res));
    const grid = new Float32Array(W * H);
    const m = splat.matrixWorld;
    const p = new THREE.Vector3();
    let count = 0;
    const total = splat.packedSplats?.numSplats ?? 0;
    const stride = Math.max(1, Math.floor(total / 1_500_000));
    let i = 0;
    splat.forEachSplat((_idx, center, _scales, _q, opacity) => {
      if (i++ % stride !== 0 || opacity < 0.35) return;
      p.copy(center).applyMatrix4(m);
      if (p.y < lo || p.y > hi) return;
      const gx = Math.floor(((p.x - box.min.x) / size.x) * W);
      const gy = Math.floor(((p.z - box.min.y) / size.y) * H);
      if (gx < 0 || gy < 0 || gx >= W || gy >= H) return;
      grid[gy * W + gx] += opacity;
      count++;
    });

    // Tone-map the density into a clean ink drawing.
    let max = 0;
    for (const v of grid) max = Math.max(max, v);
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const octx = off.getContext("2d");
    const img = octx.createImageData(W, H);
    const k = max > 0 ? 1 / Math.log1p(max * 0.35) : 0;
    for (let j = 0; j < W * H; j++) {
      const a = Math.min(1, Math.log1p(grid[j]) * k * 1.6);
      img.data[j * 4 + 0] = 255;
      img.data[j * 4 + 1] = 255;
      img.data[j * 4 + 2] = 255;
      img.data[j * 4 + 3] = Math.round(a * 220);
    }
    octx.putImageData(img, 0, 0);
    this.plan = { canvas: off, box, size, count };
  }

  _toCanvas(x, z) {
    const { box, size } = this.plan;
    const c = this.canvas;
    const scale = Math.min(c.width / size.x, c.height / size.y);
    const ox = (c.width - size.x * scale) / 2;
    const oy = (c.height - size.y * scale) / 2;
    return [ox + (x - box.min.x) * scale, oy + (z - box.min.y) * scale, scale];
  }

  _nodeAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const y = ((e.clientY - r.top) / r.height) * this.canvas.height;
    let best = null;
    let bd = 14 * (this.canvas.width / r.width);
    for (const n of this.tour.nodes) {
      const [cx, cy] = this._toCanvas(n.position.x, n.position.z);
      const d = Math.hypot(cx - x, cy - y);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  draw(current) {
    const { ctx, canvas } = this;
    if (!this.plan) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const [x0, y0, scale] = this._toCanvas(this.plan.box.min.x, this.plan.box.min.y);
    ctx.globalAlpha = 0.9;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.plan.canvas, x0, y0, this.plan.size.x * scale, this.plan.size.y * scale);
    ctx.globalAlpha = 1;

    // edges
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of this.tour.data.edges || []) {
      const na = this.tour.byId.get(a);
      const nb = this.tour.byId.get(b);
      if (!na || !nb) continue;
      const [ax, ay] = this._toCanvas(na.position.x, na.position.z);
      const [bx, by] = this._toCanvas(nb.position.x, nb.position.z);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();

    // nodes
    for (const n of this.tour.nodes) {
      const [cx, cy] = this._toCanvas(n.position.x, n.position.z);
      const active = n === current;
      const hover = n === this.hoverNode;
      ctx.beginPath();
      ctx.arc(cx, cy, active ? 7 : hover ? 6.5 : 5, 0, Math.PI * 2);
      ctx.fillStyle = active ? "#ffb547" : hover ? "#ffffff" : "rgba(255,255,255,0.75)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.stroke();
    }

    // view cone at the live camera position
    const [px, py] = this._toCanvas(this.rig.position.x, this.rig.position.z);
    const yaw = this.look.yaw;
    const half = ((this.look.fov + this.look.fovKick) * Math.PI) / 360;
    const hfov = Math.atan(Math.tan(half) * (window.innerWidth / window.innerHeight));
    const dirAngle = Math.atan2(-Math.cos(yaw), -Math.sin(yaw)); // canvas angle of view dir
    const R = 46;
    const g = ctx.createRadialGradient(px, py, 0, px, py, R);
    g.addColorStop(0, "rgba(255,181,71,0.55)");
    g.addColorStop(1, "rgba(255,181,71,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, R, dirAngle - hfov, dirAngle + hfov);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffb547";
    ctx.fill();
  }
}
