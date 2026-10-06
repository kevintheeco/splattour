// 숙소 상세 (Airbnb-style listing): photo carousel, facts, highlights, the
// two ways to explore, description, 사진 투어 (room-grouped photos), rooms,
// amenities, location, rules, and a sticky bar with the two entry buttons:
// 360° 시점 탐색 · 3DGS 자유 시점 탐색. Everything comes from listing.json.
import { loadListing, loadPanoNav, findScene, esc, HOME } from "./data.js";
import { icon } from "./icons.js";
import { reveal, favs, toast, pager } from "./ui.js";

const params = new URLSearchParams(location.search);
const id = params.get("id") || "wolhajeong";
const DEV = params.get("dev") === "1";
const $ = (s, r = document) => r.querySelector(s);

async function main() {
  const l = await loadListing(id);
  window.__listing = l;
  document.title = `${l.title} · SplatTour`;
  const P = (p, s) => l.photoUrl(p, s);
  const allPhotos = (l.photoTour || []).flatMap((g) => g.photos.map((p) => ({ p, room: g.room })));
  const hero = l.hero?.length ? l.hero : allPhotos.map((x) => x.p);
  const root = $("#detail");

  root.innerHTML = `
    <header class="hd-bar" id="bar">
      <a class="circ" href="${HOME}" aria-label="숙소 목록">${icon("back")}</a>
      <div class="hd-bar-title">${esc(l.title)}</div>
      <div class="hd-actions">
        <button class="circ" id="share" aria-label="공유">${icon("share")}</button>
        <button class="circ hd-heart" id="heart" aria-label="저장">${icon("heart")}</button>
      </div>
    </header>
    <section class="hd-hero">
      <div class="hd-track" id="heroTrack">${hero.map((p, i) => `<img src="${P(p)}" alt="" ${i > 1 ? 'loading="lazy"' : ""} data-i="${i}" />`).join("")}</div>
      <div class="hd-count" id="heroCount">1 / ${hero.length}</div>
    </section>
    <div class="hd-sheet"><div class="hd-wrap">
      <h1 class="hd-title">${esc(l.title)}</h1>
      <div class="hd-tag">${esc(l.type)} · ${esc(l.area)}</div>
      <div class="hd-facts">${(l.facts || []).map((f) => `<span>${esc(f)}</span>`).join("")}</div>
      ${l.badges?.length ? `<div class="hd-badges"><div class="laurel">${icon("key")}${esc(l.badges[0])}</div><p>${esc(l.badges.slice(1).join(" · ") || l.tagline)}${l.badges.length > 1 ? ` · ${esc(l.tagline)}` : ""}</p></div>` : ""}

      <section class="sec rv"><div class="hl">${(l.highlights || []).map((h) => `<div class="hl-item">${icon(h.icon)}<div><b>${esc(h.title)}</b><span>${esc(h.text)}</span></div></div>`).join("")}</div></section>

      <section class="sec rv" id="explore">
        <h2>공간 둘러보기<small>같은 공간을 두 가지 방식으로 둘러볼 수 있어요.</small></h2>
        <div class="ex">
          <div class="ex-card pano"><div class="ex-in"><div class="ex-ic">${icon("pano")}</div><div>
            <div class="ex-name">360° 시점 탐색</div>
            <div class="ex-text">촬영한 지점에 서서 고개를 돌려 둘러보고, 바닥의 원을 눌러 다음 지점으로 옮겨 가요.</div>
            <div class="ex-state wait" id="panoState">확인 중</div></div></div></div>
          <div class="ex-card splat"><div class="ex-in"><div class="ex-ic">${icon("cube")}</div><div>
            <div class="ex-name">3DGS 자유 시점 탐색</div>
            <div class="ex-text">사진으로 복원한 공간 안을 눈높이로 걸어 다녀요. 걸음에 따라 가구 뒤가 드러나고 빛의 반사가 바뀌며, 방과 방이 끊김 없이 이어져요.</div>
            <div class="ex-state wait" id="splatState">확인 중</div></div></div></div>
        </div>
      </section>

      <section class="sec rv desc">
        <h2>숙소 소개</h2>
        ${(l.description || []).map((p, i) => `<p ${i > 0 ? 'class="more" hidden' : ""}>${esc(p)}</p>`).join("")}
        ${(l.description || []).length > 1 ? `<button class="linkbtn" id="moreDesc">더 보기${icon("chevron")}</button>` : ""}
      </section>

      ${l.photoTour?.length ? `<section class="sec rv">
        <h2>사진 투어<small>사진 ${allPhotos.length}장 · 공간별로 모아 봤어요</small></h2>
        <div class="tiles">${l.photoTour.map((g, k) => `<button class="tile" data-room="${k}"><div class="tile-img"><img src="${P(g.photos[0], true)}" alt="" loading="lazy" /></div><b>${esc(g.room)}</b><span>사진 ${g.photos.length}장</span></button>`).join("")}</div>
      </section>` : ""}

      ${l.rooms?.length ? `<section class="sec rv">
        <h2>방 구성</h2>
        <div class="rooms">${l.rooms.map((r) => r.photo ? `<div class="room"><div class="room-img"><img src="${P(r.photo, true)}" alt="" loading="lazy" /></div><b>${esc(r.name)}</b><span>${esc(r.detail || "")}</span>${r.note ? `<em>${esc(r.note)}</em>` : ""}</div>` : `<div class="room card">${icon(r.icon || "bed")}<b>${esc(r.name)}</b><span>${esc(r.detail || "")}</span>${r.note ? `<em>${esc(r.note)}</em>` : ""}</div>`).join("")}</div>
      </section>` : ""}

      ${l.amenities?.length ? `<section class="sec rv">
        <h2>숙소 편의시설</h2>
        <div class="am ${l.amenities.length > 6 ? "clip" : ""}" id="am">${l.amenities.map((a) => `<div>${icon(a.icon)}<span>${esc(a.label)}</span></div>`).join("")}</div>
        ${l.amenities.length > 6 ? `<button class="outline-btn" id="amAll">편의시설 ${l.amenities.length}개 모두 보기</button>` : ""}
      </section>` : ""}

      <section class="sec rv">
        <h2>위치</h2>
        <div class="loc"><div class="loc-map"><svg class="loc-svg" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="400" height="200" fill="#f2eee6"/><path d="M-10 150 C 80 120 120 170 210 140 S 330 90 420 110" stroke="#e3ddd1" stroke-width="16" fill="none"/><path d="M-10 150 C 80 120 120 170 210 140 S 330 90 420 110" stroke="#fff" stroke-width="10" fill="none"/><path d="M120 -10 C 140 60 180 90 170 210" stroke="#fff" stroke-width="7" fill="none"/><path d="M300 -10 L 260 210" stroke="#fff" stroke-width="5" fill="none"/><path d="M-10 60 L 420 40" stroke="#fff" stroke-width="4" fill="none"/><ellipse cx="330" cy="170" rx="70" ry="34" fill="#dfe8d6"/><ellipse cx="50" cy="30" rx="60" ry="28" fill="#dfe8d6"/><path d="M0 95 C 60 85 90 100 150 92" stroke="#d6e4ea" stroke-width="6" fill="none"/></svg><div class="pinw">${icon("pin")}</div></div><b>${esc(l.area)}</b><span>${esc(l.address || "")}</span><span>${esc(l.transit || "")}</span></div>
      </section>

      ${l.rules?.length ? `<section class="sec rv">
        <h2>알아두어야 할 사항</h2>
        <div class="rules">${l.rules.map((r) => `<div>${icon(r.icon)}<span>${esc(r.label)}</span></div>`).join("")}</div>
        ${l.credit ? `<div class="credit">${esc(l.credit)}</div>` : ""}
        ${DEV && l.review?.note ? `<div class="memo"><b>연구자 확인 필요</b>${esc(l.review.note)}</div>` : ""}
      </section>` : ""}
    </div></div>

    <nav class="bb"><div class="bb-in">
      <a class="go off" id="goPano" aria-disabled="true">${icon("pano")}<div><small>360°</small><b>시점 탐색</b><span>확인 중</span></div></a>
      <a class="go off" id="goSplat" aria-disabled="true">${icon("cube")}<div><small>3DGS</small><b>자유 시점 탐색</b><span>확인 중</span></div></a>
    </div></nav>`;

  // hero carousel counter + solid header after the photos
  const track = $("#heroTrack");
  track.addEventListener("scroll", () => {
    $("#heroCount").textContent = `${Math.round(track.scrollLeft / track.clientWidth) + 1} / ${hero.length}`;
  }, { passive: true });
  track.addEventListener("click", (e) => { const i = e.target.dataset?.i; if (i != null) lightbox(hero.map((p) => ({ p })), +i); });
  pager(track.parentElement, track, icon("chevron"));
  const bar = $("#bar");
  const onScroll = () => bar.classList.toggle("solid", scrollY > track.clientHeight - 70);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // share / save
  $("#share").addEventListener("click", async () => {
    try {
      if (navigator.share) await navigator.share({ title: l.title, url: location.href });
      else { await navigator.clipboard.writeText(location.href); toast("링크를 복사했어요"); }
    } catch {}
  });
  const heart = $("#heart");
  heart.classList.toggle("on", favs.has(l.id));
  heart.addEventListener("click", () => { const on = favs.toggle(l.id); heart.classList.toggle("on", on); toast(on ? "저장했어요" : "저장을 취소했어요"); });

  $("#moreDesc")?.addEventListener("click", (e) => {
    root.querySelectorAll(".desc .more").forEach((p) => (p.hidden = false));
    e.currentTarget.remove();
  });
  $("#amAll")?.addEventListener("click", (e) => { $("#am").classList.remove("clip"); e.currentTarget.remove(); });
  root.querySelectorAll(".tile").forEach((t) => t.addEventListener("click", () => photoTour(l, +t.dataset.room)));

  reveal();
  entries(l);
}

// The two entry buttons (and the explore section states)
async function entries(l) {
  const [nav, scene] = await Promise.all([loadPanoNav(l.id, l).catch(() => null), findScene(l.explore?.scene)]);
  const goPano = $("#goPano"), goSplat = $("#goSplat");
  const set = (a, st, href, sub, stateText, cls) => {
    a.classList.toggle("off", !href);
    a.classList.toggle("dev", cls === "dev");
    if (href) { a.href = href; a.removeAttribute("aria-disabled"); }
    a.querySelector("span").textContent = sub;
    st.textContent = stateText;
    st.className = `ex-state ${cls || ""}`;
  };
  // 360°: real captures, a flagged dev-only set, or pending (with the arrival note)
  const panoHref = `/pano.html?space=${encodeURIComponent(l.id)}`;
  if (!nav) set(goPano, $("#panoState"), null, "촬영 지점 없음", "촬영 지점 정보가 없어요", "wait");
  else if (nav.panoReady) set(goPano, $("#panoState"), panoHref, `촬영 지점 ${nav.nodes.length}곳`, `촬영 지점 ${nav.nodes.length}곳에서 둘러볼 수 있어요`);
  else if (nav.panoViewable) set(goPano, $("#panoState"), panoHref, `개발용 · 지점 ${nav.nodes.length}곳`, "개발용 임시 파노라마 (실험에 쓰지 않음)", "dev");
  else set(goPano, $("#panoState"), DEV ? panoHref + "&dev=1" : null, (nav.pendingLabel.match(/\((.+)\)/)?.[1] || "준비 중"), nav.pendingLabel, "wait");
  // 3DGS: the scene once it is trained and published ("3D 준비 중" until then)
  const splatHref = scene ? `${scene.href}&app=1&space=${encodeURIComponent(l.id)}` : null;
  if (scene) set(goSplat, $("#splatState"), splatHref, "눈높이로 걸어서 둘러보기", "지금 둘러볼 수 있어요");
  else set(goSplat, $("#splatState"), null, "3D 준비 중", "3D 준비 중 · 학습이 끝나면 열려요", "wait");
}

// 사진 투어: every room with its photos (Airbnb's photo tour), opens at a room
function photoTour(l, room = 0) {
  let sheet = $(".sheet");
  if (!sheet) {
    sheet = document.createElement("div");
    sheet.className = "sheet";
    const flat = l.photoTour.flatMap((g) => g.photos.map((p) => ({ p, room: g.room })));
    let k = 0;
    sheet.innerHTML = `
      <div class="sheet-bar"><button class="circ" data-close aria-label="닫기">${icon("back")}</button><h3>사진 투어</h3></div>
      <div class="sheet-body">
        <div class="tiles">${l.photoTour.map((g, i) => `<button class="tile" data-jump="${i}"><div class="tile-img"><img src="${l.photoUrl(g.photos[0], true)}" alt="" /></div><b>${esc(g.room)}</b><span>사진 ${g.photos.length}장</span></button>`).join("")}</div>
        ${l.photoTour.map((g, i) => `<section class="pt-room" id="pt${i}"><h4>${esc(g.room)}</h4><p>사진 ${g.photos.length}장</p><div class="pt-grid">${g.photos.map((p) => `<button data-k="${k++}"><img src="${l.photoUrl(p)}" alt="${esc(g.room)}" loading="lazy" /></button>`).join("")}</div></section>`).join("")}
      </div>`;
    document.body.appendChild(sheet);
    sheet.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.hasAttribute("data-close")) { sheet.classList.remove("open"); document.body.style.overflow = ""; }
      if (b.dataset.jump != null) $(`#pt${b.dataset.jump}`, sheet).scrollIntoView({ behavior: "smooth" });
      if (b.dataset.k != null) lightbox(flat, +b.dataset.k);
    });
  }
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => {
    sheet.classList.add("open");
    const target = $(`#pt${room}`, sheet);
    if (room > 0 && target) sheet.scrollTop = target.offsetTop - 60;
    else sheet.scrollTop = 0;
  });
}

function lightbox(items, start) {
  const l = window.__listing;
  const lb = document.createElement("div");
  lb.className = "lb";
  lb.innerHTML = `
    <div class="lb-bar"><button class="circ" aria-label="닫기">${icon("close")}</button><div class="lb-count"></div><span style="width:38px"></span></div>
    <div class="lb-track">${items.map((x) => `<figure><img src="${l.photoUrl(x.p)}" alt="" />${x.room ? `<figcaption>${esc(x.room)}</figcaption>` : ""}</figure>`).join("")}</div>`;
  document.body.appendChild(lb);
  const track = $(".lb-track", lb), count = $(".lb-count", lb);
  const upd = () => { count.textContent = `${Math.round(track.scrollLeft / track.clientWidth) + 1} / ${items.length}`; };
  track.addEventListener("scroll", upd, { passive: true });
  const pgUpd = pager(lb, track, icon("chevron"));
  requestAnimationFrame(() => { track.scrollLeft = start * track.clientWidth; upd(); pgUpd(); lb.classList.add("open"); });
  const close = () => { lb.classList.remove("open"); setTimeout(() => lb.remove(), 350); removeEventListener("keydown", key); };
  const key = (e) => { if (e.key === "Escape") close(); if (e.key === "ArrowRight") track.scrollBy({ left: track.clientWidth, behavior: "smooth" }); if (e.key === "ArrowLeft") track.scrollBy({ left: -track.clientWidth, behavior: "smooth" }); };
  addEventListener("keydown", key);
  $(".circ", lb).addEventListener("click", close);
}

main().catch((e) => { $("#detail").innerHTML = `<p style="padding:24px">${esc(e.message)}</p>`; });
