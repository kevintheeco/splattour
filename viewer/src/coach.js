// First-visit coaching: one small tip at a time, each unlocked by doing the
// previous thing (look → move → get close). No modal, nothing to dismiss.
// A returning visitor sees nothing; ?onboarding=0 turns it off for studies,
// ?onboarding=1 forces it on.

const TOUCH = matchMedia("(pointer: coarse)").matches;
const KEY = "splattour.coached.v1";

const ICONS = {
  look: `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><path d="M8 24h7M40 24h-7M11 21l-3 3 3 3M37 21l3 3-3 3" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="17" y="12" width="14" height="24" rx="7" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M24 16v5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  move: `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><ellipse cx="24" cy="34" rx="12" ry="4.5" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M24 10v17M18 21l6 6 6-6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  close: `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><circle cx="21" cy="21" r="10" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M28.5 28.5 38 38M17 21h8M21 17v8" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>`,
};

const STEPS = [
  { id: "look", icon: "look", text: TOUCH ? "손가락으로 밀어서<br />주변을 둘러보세요" : "드래그해서<br />주변을 둘러보세요" },
  { id: "move", icon: "move", text: TOUCH ? "바닥의 흰 원을 누르면<br />그곳으로 걸어가요" : "바닥의 흰 원을 누르면<br />그곳으로 걸어가요" },
  { id: "close", icon: "close", text: TOUCH ? "궁금한 곳을 두 번 탭하면 가까이 다가가요<br />두 손가락으로 벌리면 확대" : "궁금한 곳을 더블클릭하면 가까이 다가가요<br />휠을 굴리면 확대" },
];

export class Coach {
  constructor(el, params) {
    this.el = el;
    const p = params.get("onboarding");
    let seen = false;
    try { seen = localStorage.getItem(KEY) === "1"; } catch {}
    this.on = p === "1" || (p !== "0" && !seen);
    this.i = -1;
    if (!this.on) { el.classList.add("gone"); return; }
    this._show(0);
  }

  _show(i) {
    this.i = i;
    const s = STEPS[i];
    this.el.classList.add("gone");
    clearTimeout(this.t);
    // fade out, swap, fade in
    this.t = setTimeout(() => {
      this.el.dataset.step = s.id;
      this.el.innerHTML = `${ICONS[s.icon]}<span>${s.text}</span><i class="dots">${STEPS.map((_, k) => `<b class="${k === i ? "on" : ""}"></b>`).join("")}</i>`;
      this.el.classList.remove("gone");
    }, this.i === 0 ? 0 : 450);
  }

  // Report what the visitor just did; the tip advances only on the matching action.
  did(action) {
    if (!this.on || this.i < 0) return;
    const cur = STEPS[this.i].id;
    const done = (cur === "look" && action === "look") || (cur === "move" && action === "move") || (cur === "close" && (action === "close" || action === "zoom"));
    if (!done) return;
    if (this.i + 1 < STEPS.length) {
      clearTimeout(this.adv);
      // give the visitor a moment to enjoy what they just did
      this.adv = setTimeout(() => this._show(this.i + 1), cur === "look" ? 700 : 1200);
    } else this.finish();
  }

  finish() {
    if (!this.on) return;
    this.on = false;
    clearTimeout(this.t);
    clearTimeout(this.adv);
    this.el.classList.add("gone");
    try { localStorage.setItem(KEY, "1"); } catch {}
  }
}
