// Source photos ("원본 사진"): the pictures the 3D space was reconstructed
// from. A gallery (nearest first or capture order), a full view, and
// "이 자리에서 보기": fly to the exact pose the photo was taken from and lay
// the photo over the render with a slider, so photo and 3D can be compared.
import * as THREE from "three";

const $ = (s) => document.querySelector(s);

export class Photos {
  constructor({ tour, nav, look, rig, toast }) {
    Object.assign(this, { tour, nav, look, rig, toast });
    this.list = [];
    this.order = "near";
    this.index = -1;
    this.panel = $("#photos");
    this.grid = $("#photoGrid");
    this.box = $("#photoBox");
    this.overlay = $("#photoOverlay");
    this.compare = $("#photoCompare");
    this._bind();
  }

  async load() {
    if (!this.tour.data.photos) return false;
    const url = this.tour.resolve(this.tour.data.photos);
    const res = await fetch(url);
    if (!res.ok) return false;
    const data = await res.json();
    const base = new URL(".", url);
    this.list = data.photos.map((p, i) => ({
      ...p,
      i,
      thumb: new URL(`t/${p.file}`, base).href,
      full: new URL(`f/${p.file}`, base).href,
      pos: new THREE.Vector3().fromArray(p.position),
      quat: new THREE.Quaternion().fromArray(p.quaternion),
    }));
    $("#photoCount").textContent = `${this.list.length}장`;
    return this.list.length > 0;
  }

  get open() { return !this.panel.hidden; }

  toggle(show = this.panel.hidden) {
    this.panel.hidden = !show;
    if (show) this.render();
    return show;
  }

  sorted() {
    if (this.order === "capture") return this.list;
    const p = this.rig.position;
    const fwd = new THREE.Vector3(-Math.sin(this.look.yaw), 0, -Math.cos(this.look.yaw));
    // near first; among equally near photos, the ones facing the same way
    const score = (ph) => {
      const d = ph.pos.distanceTo(p);
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(ph.quat).setY(0).normalize();
      return d + (1 - f.dot(fwd)) * 0.6;
    };
    return [...this.list].sort((a, b) => score(a) - score(b));
  }

  render() {
    this.grid.textContent = "";
    this.view = this.sorted();
    const frag = document.createDocumentFragment();
    this.view.forEach((ph, k) => {
      const b = document.createElement("button");
      b.className = "pthumb";
      b.innerHTML = `<img loading="lazy" decoding="async" alt=""><span></span>`;
      b.querySelector("img").src = ph.thumb;
      b.querySelector("span").textContent = `${ph.i + 1}`;
      b.title = ph.name;
      b.addEventListener("click", () => this.show(k));
      frag.appendChild(b);
    });
    this.grid.appendChild(frag);
    this.grid.scrollTop = 0;
  }

  show(k) {
    this.index = (k + this.view.length) % this.view.length;
    const ph = this.view[this.index];
    const img = $("#photoImg");
    img.src = ph.thumb; // instant, then sharpen
    const full = new Image();
    full.onload = () => { if (this.view[this.index] === ph) img.src = ph.full; };
    full.src = ph.full;
    $("#photoName").textContent = ph.name;
    $("#photoIdx").textContent = `${ph.i + 1} / ${this.list.length}`;
    $("#photoDist").textContent = `지금 위치에서 ${ph.pos.distanceTo(this.rig.position).toFixed(1)} m`;
    this.box.hidden = false;
  }

  closeBox() { this.box.hidden = true; }

  // Fly to where the photo was taken, looking exactly the way the camera did.
  standAt(ph) {
    this.closeBox();
    this.toggle(false); // the comparison needs the whole view
    this.onClose?.();
    this.hideCompare();
    const e = new THREE.Euler().setFromQuaternion(ph.quat, "YXZ");
    this.look.roll = 0;
    const flew = this.nav.goToPoint(ph.pos, { yaw: e.y, pitch: e.x, duration: THREE.MathUtils.clamp(0.9 + ph.pos.distanceTo(this.rig.position) * 0.35, 1, 3.2) });
    this.look.zoomAt(ph.fovY);
    const done = () => {
      this.look.set(e.y, e.x);
      this.look.roll = e.z;
      this.look.setFov(ph.fovY);
      this.showCompare(ph);
    };
    if (!flew) { done(); return; }
    const onArrive = () => { this.nav.removeEventListener("arrive", onArrive); done(); };
    this.nav.addEventListener("arrive", onArrive);
  }

  showCompare(ph) {
    this.current = ph;
    this.overlay.src = ph.full;
    this.overlay.style.aspectRatio = `${ph.w} / ${ph.h}`;
    const s = $("#photoMix");
    s.value = 1;
    this.overlay.style.opacity = "1";
    this.overlay.hidden = false;
    this.compare.hidden = false;
    this.toast("사진과 같은 자리예요 · 막대를 밀어 3D와 비교해 보세요", 2600);
  }

  hideCompare() {
    this.overlay.hidden = true;
    this.compare.hidden = true;
    this.current = null;
  }

  _bind() {
    $("#photoClose").addEventListener("click", () => { this.toggle(false); this.onClose?.(); });
    $("#photoOrder").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.order = b.dataset.o;
      document.querySelectorAll("#photoOrder button").forEach((x) => x.classList.toggle("on", x === b));
      this.render();
    });
    $("#photoPrev").addEventListener("click", () => this.show(this.index - 1));
    $("#photoNext").addEventListener("click", () => this.show(this.index + 1));
    $("#photoBoxClose").addEventListener("click", () => this.closeBox());
    this.box.addEventListener("click", (e) => { if (e.target === this.box) this.closeBox(); });
    $("#photoGo").addEventListener("click", () => this.standAt(this.view[this.index]));
    $("#photoMix").addEventListener("input", (e) => { this.overlay.style.opacity = e.target.value; });
    $("#photoCompareClose").addEventListener("click", () => this.hideCompare());
    window.addEventListener("keydown", (e) => {
      if (this.box.hidden) return;
      if (e.key === "Escape") this.closeBox();
      if (e.key === "ArrowLeft") this.show(this.index - 1);
      if (e.key === "ArrowRight") this.show(this.index + 1);
      e.stopPropagation();
    }, true);
    // Moving away breaks the alignment, so the overlay goes with it.
    this.nav.addEventListener("depart", () => { if (this.current) this.hideCompare(); });
    this.look.addEventListener("interact", () => {
      if (this.current && this.overlay.style.opacity !== "0") { $("#photoMix").value = 0; this.overlay.style.opacity = "0"; }
    });
  }
}
