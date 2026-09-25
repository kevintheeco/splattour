// 숙소 목록: one card per space in /spaces/index.json (photos swipe inside the card).
import { listSpaces, loadNav, findScene, esc, TOUR, HOME } from "./data.js";
import { icon } from "./icons.js";
import { reveal, favs } from "./ui.js";

// old "/?scene=" links on the published site go to the viewer
if (new URLSearchParams(location.search).has("scene")) location.replace(TOUR + location.search);

const $ = (s) => document.querySelector(s);
$("#wordmark").href = HOME;
$("#markIc").innerHTML = icon("cube");
$("#uploadLink").innerHTML = `${icon("upload")}<span>공간 올리기</span>`;

async function main() {
  const spaces = await listSpaces();
  const box = $("#cards");
  box.textContent = "";
  for (const l of spaces) {
    const a = document.createElement("a");
    a.className = "lcard rv";
    a.href = `/listing.html?id=${encodeURIComponent(l.id)}`;
    const photos = (l.hero || []).slice(0, 5);
    a.innerHTML = `
      <div class="lcard-media">
        <div class="lcard-track">${photos.map((p, i) => `<img src="${l.photoUrl(p)}" alt="" ${i ? 'loading="lazy"' : ""} />`).join("")}</div>
        ${l.badges?.[0] ? `<span class="lcard-badge">${esc(l.badges[0])}</span>` : ""}
        <button class="lcard-heart" aria-label="저장">${icon("heart")}</button>
        <div class="lcard-dots">${photos.map((_, i) => `<b class="${i ? "" : "on"}"></b>`).join("")}</div>
      </div>
      <div class="lcard-body">
        <div class="lcard-row"><span class="lcard-title">${esc(l.title)}</span><span class="lcard-type">${esc(l.type)}</span></div>
        <div class="lcard-sub">${esc(l.area)} · ${esc(l.tagline)}</div>
        <div class="lcard-sub">${esc((l.facts || []).slice(0, 3).join(" · "))}</div>
        <div class="lcard-modes"><span class="mode-chip wait">${icon("pano")}360° 확인 중</span><span class="mode-chip wait">${icon("cube")}3DGS 확인 중</span></div>
      </div>`;
    const track = a.querySelector(".lcard-track");
    const dots = a.querySelectorAll(".lcard-dots b");
    track.addEventListener("scroll", () => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      dots.forEach((d, k) => d.classList.toggle("on", k === i));
    }, { passive: true });
    const heart = a.querySelector(".lcard-heart");
    heart.classList.toggle("on", favs.has(l.id));
    heart.addEventListener("click", (e) => { e.preventDefault(); heart.classList.toggle("on", favs.toggle(l.id)); });
    box.appendChild(a);
    modes(l, a.querySelector(".lcard-modes"));
  }
  reveal();
}

// What can be explored right now (both conditions)
async function modes(l, el) {
  const [nav, scene] = await Promise.all([loadNav(l.id, l).catch(() => null), findScene(l.explore?.scene)]);
  const pano = !nav ? "없음" : nav.panoReady ? "360° 시점 탐색" : nav.panoViewable ? "360° 개발용" : "360° 준비 중";
  el.innerHTML =
    `<span class="mode-chip ${nav?.panoReady ? "ok" : "wait"}">${icon("pano")}${pano}</span>` +
    `<span class="mode-chip ${scene ? "ok" : "wait"}">${icon("cube")}${scene ? "3DGS 자유 시점 탐색" : "3D 준비 중"}</span>`;
}

main().catch((e) => { $("#cards").innerHTML = `<p>${esc(e.message)}</p>`; });
