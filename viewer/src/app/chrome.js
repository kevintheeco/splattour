// Shared viewer chrome for the two study conditions (360° 시점 탐색 and
// 3DGS 자유 시점 탐색). Both viewers mount exactly this: back button, room
// name, condition caption, task pill, floor plan (mini card + full sheet,
// north-up, "내 위치"), full screen (landscape), look-by-tilting. So the only
// thing that differs between the conditions is how you explore.
import { icon } from "./icons.js";
import { PlanData, PlanCanvas } from "./plan.js";
import { Gyro } from "./gyro.js";

const TOUCH = matchMedia("(pointer: coarse)").matches;

// The same field of view and zoom range in both conditions (upright phones get a wider start).
export function matchLook(look) {
  look.minFov = 25;
  look.maxFov = 95;
  look.setFov(TOUCH && innerHeight > innerWidth ? 82 : 75);
}

export class ViewerChrome {
  // opts: { spaceTitle, condition: "pano"|"splat", backHref, nav, base (/spaces/<id>/), look, plan: bool, onBack }
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
          <button class="vc-btn vc-menu-btn" aria-label="메뉴" aria-expanded="false" hidden>${icon("menu")}</button>
          <button class="vc-btn vc-plan-btn" aria-label="평면도 보이기/숨기기" aria-pressed="true">${icon("map")}</button>
          <button class="vc-btn vc-fs-btn" aria-label="전체 화면">${icon("expand")}</button>
        </div>
      </header>
      <div class="vc-task-slot"></div>
      <button class="vc-plan" hidden aria-label="평면도 크게 보기"><canvas></canvas><span class="vc-plan-exp">${icon("expand")}</span></button>
      <div class="vc-sheet" hidden>
        <div class="vc-sheet-card" role="dialog" aria-label="평면도">
          <div class="vc-sheet-head"><div><b>평면도</b><span class="vc-sheet-room"></span></div><button class="vc-btn vc-sheet-close" aria-label="평면도 닫기">${icon("close")}</button></div>
          <canvas class="vc-sheet-canvas"></canvas>
          <div class="vc-sheet-foot"><span class="vc-me-key"></span>내 위치와 보는 방향 · 두 손가락으로 확대, 끌어서 이동</div>
        </div>
      </div>
      <button class="vc-btn vc-gyro" aria-label="휴대폰을 움직여 둘러보기" aria-pressed="false" hidden>${icon("compass")}</button>
      <div class="vc-rotate" hidden><div>${icon("rotate", "vc-rotate-ic")}<b>가로로 돌려 주세요</b><span>휴대폰을 옆으로 눕히면 더 넓게 보여요</span><button class="vc-rotate-ok">세로로 볼게요</button></div></div>
      <div class="vc-menu" hidden><div class="vc-menu-card" role="menu" aria-label="도구"></div></div>
      <div class="vc-toast"></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.$ = (s) => el.querySelector(s);
    this.st = { room: null, pose: null };

    const back = this.$(".vc-back");
    back.href = opts.backHref || "/";
    back.addEventListener("click", (e) => {
      if (opts.onBack && opts.onBack() === false) e.preventDefault();
    });

    this._setupPlan();
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

  // ---------- menu (≡) ----------
  // items: [{ id, icon, label, run(), on?() -> bool, hidden?() -> bool }]. The
  // viewer passes its own tools (they keep their own logic); tapping outside
  // or picking an item closes it. Not shown in study mode (see the viewers).
  setMenu(items) {
    const btn = this.$(".vc-menu-btn"), wrap = this.$(".vc-menu"), card = this.$(".vc-menu-card");
    this.menuItems = items || [];
    btn.hidden = !this.menuItems.length;
    const render = () => {
      card.innerHTML = "";
      for (const it of this.menuItems) {
        if (it.hidden?.()) continue;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "vc-menu-item";
        b.setAttribute("role", "menuitem");
        const on = it.on?.();
        if (on) b.classList.add("on");
        b.innerHTML = `<span class="vc-menu-ic">${icon(it.icon)}</span><span class="vc-menu-label"></span>${on !== undefined ? `<span class="vc-menu-state">${on ? "켜짐" : "꺼짐"}</span>` : ""}`;
        b.querySelector(".vc-menu-label").textContent = it.label;
        b.addEventListener("click", (e) => { e.stopPropagation(); close(); this.onEvent?.("menu", { item: it.id }); it.run(); });
        card.appendChild(b);
      }
    };
    const open = () => { render(); wrap.hidden = false; requestAnimationFrame(() => wrap.classList.add("open")); btn.setAttribute("aria-expanded", "true"); btn.classList.add("on"); };
    const close = () => { wrap.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); btn.classList.remove("on"); setTimeout(() => { if (!wrap.classList.contains("open")) wrap.hidden = true; }, 220); };
    this.menuOpen = open;
    this.menuClose = close;
    if (!this.menuBound) {
      this.menuBound = true;
      btn.addEventListener("click", (e) => { e.stopPropagation(); wrap.hidden ? open() : close(); });
      wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
      wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) { e.stopPropagation(); } });
    }
  }

  fullscreen() { this.$(".vc-fs-btn")?.click(); }

  // ---------- plan ----------
  _setupPlan() {
    const o = this.o, btn = this.$(".vc-plan-btn");
    if (o.plan === false || !o.nav) { btn.hidden = true; return; }
    this.miniOn = true;
    this.sheetOn = false;
    PlanData.load(o.nav, o.base).then((data) => {
      this.plan = data;
      this.mini = new PlanCanvas(this.$(".vc-plan canvas"), data, { compact: true });
      this.full = new PlanCanvas(this.$(".vc-sheet-canvas"), data, { interactive: true });
      // the mini card and the sheet take the plan's proportions
      const asp = data.W / data.H;
      this.el.style.setProperty("--plan-asp", String(Math.min(2.4, Math.max(0.8, asp))));
      const wk = asp > 1.6 ? 1.2 : 1;
      this.$(".vc-plan").style.width = `calc(var(--plan) * ${wk})`;
      this.$(".vc-plan").style.height = `calc(var(--plan) * ${wk} / ${Math.min(2.2, Math.max(0.9, asp)).toFixed(3)} + 18px)`;
      this.$(".vc-plan").hidden = !this.miniOn;
      this.mini.resize();
      addEventListener("resize", () => { this.mini.resize(); if (this.sheetOn) this.full.resize(); });
    });
    btn.addEventListener("click", () => {
      this.miniOn = !this.miniOn;
      btn.classList.toggle("off", !this.miniOn);
      btn.setAttribute("aria-pressed", String(this.miniOn));
      if (this.plan) { this.$(".vc-plan").hidden = !this.miniOn; if (this.miniOn) this.mini.resize(); }
      this.onEvent?.("plan", { mini: this.miniOn });
    });
    this.$(".vc-plan").addEventListener("click", () => this.openSheet(true));
    this.$(".vc-sheet-close").addEventListener("click", () => this.openSheet(false));
    this.$(".vc-sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) this.openSheet(false); });
    // a tap on the big plan (not a drag or pinch) folds it back
    this.$(".vc-sheet-canvas").addEventListener("click", () => { if (this.full.moved < 8) this.openSheet(false); });
  }

  openSheet(on) {
    if (!this.plan || on === this.sheetOn) return;
    this.sheetOn = on;
    const s = this.$(".vc-sheet");
    s.hidden = false;
    requestAnimationFrame(() => s.classList.toggle("open", on));
    if (on) {
      this.full.reset();
      const card = this.$(".vc-sheet-card"), land = matchMedia("(orientation: landscape) and (max-height: 520px)").matches;
      card.classList.toggle("fill", land);
      if (!land) { const w = Math.min(innerWidth, 720); card.style.setProperty("--sheet-h", `${Math.round(Math.min(innerHeight * 0.55, Math.max(260, (w - 44) / (this.plan.W / this.plan.H) + 90)))}px`); }
      requestAnimationFrame(() => this.full.resize());
    }
    else setTimeout(() => { if (!this.sheetOn) s.hidden = true; }, 380);
    this.$(".vc-plan").classList.toggle("away", on);
    this.onEvent?.("plan_sheet", { on });
  }

  setRoom(name, id) {
    this.st.room = id ?? null;
    this.$(".vc-sheet-room").textContent = name || "";
    const r = this.$(".vc-room");
    if (r.textContent === name) return;
    r.textContent = name || "";
    r.classList.remove("pop");
    void r.offsetWidth;
    r.classList.add("pop");
  }

  // x, z (metres, scene), yaw (radians); the cone takes the camera's horizontal field of view
  setPose(x, z, yaw) {
    const L = this.o.look;
    const v = (((L?.fov ?? 70) + (L?.fovKick ?? 0)) * Math.PI) / 180;
    this.st.pose = { x, z, yaw, hfov: 2 * Math.atan(Math.tan(v / 2) * (innerWidth / innerHeight)) };
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

  // every frame, from the viewer's render loop
  update() {
    this.gyro?.update();
    if (!this.plan) return;
    if (this.miniOn && !this.sheetOn) this.mini.draw(this.st);
    if (this.sheetOn) this.full.draw(this.st);
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
