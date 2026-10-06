import "./joystick.css";

// Virtual joystick for touch phones, 3DGS 자유 시점 탐색 only (the 360°
// condition moves by hotspots). A translucent ring bottom-left with a knob:
// push up = walk forward, sideways = step sideways, speed grows with how far
// the knob is pushed. It only sets a direction; walking itself is the same
// code as W A S D (main.js keyWalk: walk map, walls, steps, the 1.6 m/s²
// comfort limit). Dragging anywhere else still looks around; double-tap still
// walks to a spot.
const DEAD = 0.14; // centre dead zone (share of the radius)

export class Joystick {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.vec = { x: 0, y: 0 }; // x right, y forward, length 0..1
    const el = document.createElement("div");
    el.className = "vc-joy";
    el.setAttribute("aria-label", "걷기 조이스틱: 밀면 그 방향으로 걸어요");
    el.innerHTML = `<div class="vc-joy-knob"></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.knob = el.firstElementChild;
    this.id = null;
    requestAnimationFrame(() => el.classList.add("on")); // fade in
    const move = (e) => {
      const r = el.getBoundingClientRect();
      const R = r.width / 2;
      let dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R);
      const d = Math.hypot(dx, dy), maxD = R * 0.62;
      if (d > maxD) { dx *= maxD / d; dy *= maxD / d; }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const m = Math.min(1, d / maxD);
      const k = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD);
      this.vec = d > 0 ? { x: (dx / Math.hypot(dx, dy)) * k, y: (-dy / Math.hypot(dx, dy)) * k } : { x: 0, y: 0 };
      if (this.use) this.use.maxK = Math.max(this.use.maxK, k);
    };
    el.addEventListener("pointerdown", (e) => {
      if (this.id !== null) return;
      e.preventDefault();
      e.stopPropagation();
      this.id = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add("held");
      this.use = { t0: performance.now(), maxK: 0 };
      this.log("joystick", { phase: "start" });
      move(e);
    });
    el.addEventListener("pointermove", (e) => { if (e.pointerId === this.id) { e.preventDefault(); move(e); } });
    const end = (e) => {
      if (e.pointerId !== this.id) return;
      this.reset();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
    window.addEventListener("blur", () => this.reset());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.reset(); });
    // no page scroll / zoom / look from touches on the stick
    for (const ev of ["touchstart", "touchmove", "contextmenu"]) el.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }

  reset() {
    const id = this.id;
    this.id = null;
    if (id !== null && this.el.hasPointerCapture(id)) this.el.releasePointerCapture(id);
    this.vec = { x: 0, y: 0 };
    this.knob.style.transform = "";
    this.el.classList.remove("held");
    if (this.use) this.log("joystick", { phase: "end", ms: Math.round(performance.now() - this.use.t0), maxPush: +this.use.maxK.toFixed(2), meters: +(this.use.dist || 0).toFixed(2) });
    this.use = null;
  }

  setVisible(visible) {
    if (!visible) this.reset();
    this.el.hidden = !visible;
  }

  // walked distance while held (reported with the end event)
  addDistance(m) { if (this.use) this.use.dist = (this.use.dist || 0) + m; }

  value() { return this.vec; }
  get active() { return this.id !== null; }
}
