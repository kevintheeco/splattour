// Shared viewer chrome for the two study conditions (360° 시점 탐색 and
// 3DGS 자유 시점 탐색). Both viewers mount exactly this: back button, room
// name, condition caption, task card area, plan toggle, full screen
// (landscape), look-by-tilting. So the only thing that differs between the
// conditions is how you explore, never the frame around it.
import { icon } from "./icons.js";
import { esc } from "./data.js";
import { PlanView } from "./plan.js";
import { Gyro } from "./gyro.js";

const TOUCH = matchMedia("(pointer: coarse)").matches;

// The same field of view and zoom range in both conditions (upright phones get a wider start).
export function matchLook(look) {
  look.minFov = 25;
  look.maxFov = 95;
  look.setFov(TOUCH && innerHeight > innerWidth ? 82 : 75);
}

export class ViewerChrome {
  // opts: { root, spaceTitle, condition: "pano"|"splat", backHref, nav, look, plan: bool, onBack }
  constructor(opts) {
    this.o = opts;
    const cond = opts.condition === "pano" ? "360° 시점 탐색" : "3DGS 자유 시점 탐색";
    const el = document.createElement("div");
    el.className = "vc";
    el.innerHTML = `
      <header class="vc-top">
        <a class="vc-btn vc-back" aria-label="뒤로">${icon("back")}</a>
        <div class="vc-title"><div class="vc-room" aria-live="polite"></div><div class="vc-sub">${cond}</div><div class="vc-devtag" hidden></div></div>
        <div class="vc-actions">
          <button class="vc-btn vc-plan-btn" aria-label="평면도" aria-pressed="false">${icon("map")}</button>
          <button class="vc-btn vc-fs-btn" aria-label="전체 화면">${icon("expand")}</button>
        </div>
      </header>
      <div class="vc-task-slot"></div>
      <div class="vc-plan" hidden><canvas></canvas></div>
      <button class="vc-btn vc-gyro" aria-label="휴대폰을 움직여 둘러보기" aria-pressed="false" hidden>${icon("compass")}</button>
      <div class="vc-rotate" hidden><div>${icon("rotate", "vc-rotate-ic")}<b>가로로 돌려 주세요</b><span>휴대폰을 옆으로 눕히면 더 넓게 보여요</span><button class="vc-rotate-ok">세로로 볼게요</button></div></div>
      <div class="vc-toast"></div>`;
    (opts.root || document.body).appendChild(el);
    this.el = el;
    this.$ = (s) => el.querySelector(s);

    const back = this.$(".vc-back");
    back.href = opts.backHref || "/";
    back.addEventListener("click", (e) => {
      if (opts.onBack && opts.onBack() === false) e.preventDefault();
    });

    // plan (the same schematic in both conditions, from nav.json)
    this.planOn = false;
    if (opts.plan === false || !opts.nav) this.$(".vc-plan-btn").hidden = true;
    else {
      this.plan = new PlanView(this.$(".vc-plan canvas"), opts.nav);
      this.$(".vc-plan-btn").addEventListener("click", () => this.togglePlan());
    }

    this._setupFullscreen();

    // look by tilting the phone (both conditions)
    if (opts.look && Gyro.supported() && TOUCH) {
      this.gyro = new Gyro(opts.look);
      const b = this.$(".vc-gyro");
      b.hidden = false;
      b.addEventListener("click", async () => {
        const on = this.gyro.on ? (this.gyro.disable(), false) : await this.gyro.enable();
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
        this.toast(on ? "휴대폰을 움직여 둘러봐요" : "손가락으로 둘러봐요");
        this.onEvent?.("gyro", { on });
      });
    }
  }

  setRoom(name) {
    const r = this.$(".vc-room");
    if (r.textContent === name) return;
    r.textContent = name || "";
    r.classList.remove("pop");
    void r.offsetWidth;
    r.classList.add("pop");
  }

  // pose for the plan marker: x, z (metres), yaw (radians)
  setPose(x, z, yaw) {
    this.pose = { x, z, yaw };
    if (this.planOn) this.plan.draw(this.pose);
  }

  togglePlan(on = !this.planOn) {
    this.planOn = on;
    this.$(".vc-plan").hidden = !on;
    const b = this.$(".vc-plan-btn");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    if (on) { this.plan.resize(); this.plan.draw(this.pose); }
    this.onEvent?.("plan", { on });
  }

  get taskSlot() { return this.$(".vc-task-slot"); }

  // A small "개발용" tag under the title (tap: the full reason) for data that must not be used in the study.
  dev(text) {
    const d = this.$(".vc-devtag");
    d.hidden = !text;
    this.el.classList.toggle("has-dev", !!text);
    d.textContent = "개발용 · 실험에 쓰지 않음";
    d.title = text || "";
    d.onclick = () => this.toast(text, 4000);
  }

  toast(msg, ms = 1800) {
    const t = this.$(".vc-toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.remove("show"), ms);
  }

  update() {
    this.gyro?.update();
  }

  // ---------- full screen, landscape ----------
  // Android/desktop: Fullscreen API + orientation lock. iPhone Safari has no
  // Fullscreen API for pages: a CSS full-viewport mode instead, plus a
  // "가로로 돌려 주세요" hint while the phone is upright.
  _setupFullscreen() {
    const root = document.documentElement;
    const btn = this.$(".vc-fs-btn");
    const api = !!(root.requestFullscreen || root.webkitRequestFullscreen) && document.fullscreenEnabled !== false;
    const rotate = this.$(".vc-rotate");
    let dismissed = false;
    const portrait = matchMedia("(orientation: portrait)");
    const active = () => !!(document.fullscreenElement || document.webkitFullscreenElement) || root.classList.contains("pseudo-fs");
    const sync = () => {
      const on = active();
      btn.innerHTML = icon(on ? "shrink" : "expand");
      btn.setAttribute("aria-label", on ? "전체 화면 끝내기" : "전체 화면");
      btn.classList.toggle("on", on);
      rotate.hidden = !(on && TOUCH && portrait.matches && !dismissed);
      window.dispatchEvent(new Event("resize"));
    };
    portrait.addEventListener?.("change", sync);
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    this.$(".vc-rotate-ok").addEventListener("click", () => { dismissed = true; sync(); });
    btn.addEventListener("click", async () => {
      if (active()) {
        if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
        else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
        root.classList.remove("pseudo-fs");
        try { screen.orientation?.unlock?.(); } catch {}
        this.onEvent?.("fullscreen", { on: false });
        return sync();
      }
      dismissed = false;
      let ok = false;
      if (api) {
        try {
          await (root.requestFullscreen ? root.requestFullscreen({ navigationUI: "hide" }) : root.webkitRequestFullscreen());
          ok = true;
          // Android Chrome locks to landscape inside full screen; others reject quietly.
          await screen.orientation?.lock?.("landscape").catch(() => {});
        } catch {}
      }
      if (!ok) {
        root.classList.add("pseudo-fs");
        window.scrollTo(0, 1);
      }
      this.onEvent?.("fullscreen", { on: true, api: ok });
      sync();
    });
    sync();
  }
}
