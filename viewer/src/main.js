import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkXr } from "@sparkjsdev/spark";
import { loadTour } from "./tour.js";
import { LookControls, yawOf } from "./look.js";
import { Navigator } from "./navigator.js";
import { Hotspots } from "./hotspots.js";
import { Minimap } from "./minimap.js";
import { PanoMode } from "./panomode.js";
import { Occupancy } from "./occupancy.js";
import { WalkMap } from "./walk.js";
import { Lighting } from "./lighting.js";
import { TourAudio } from "./audio.js";
import { Coach } from "./coach.js";
import { Photos } from "./photos.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const sceneName = params.get("scene") || import.meta.env.VITE_DEFAULT_SCENE || "demo"; // web deploy sets its showcase scene
// ?from=cloud: scenes published to cloud storage (see home.js); otherwise bundled / local ones
const cloudBase = params.get("from") === "cloud" && import.meta.env.VITE_STORAGE_URL;
const baseUrl = new URL(`${cloudBase || ""}/scenes/${encodeURIComponent(sceneName)}/`, location.href);

// ---------- renderer / scene ----------
const canvas = $("#view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c0c0d);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.03, 500);
const rig = new THREE.Group(); // moved by the navigator; camera rotates inside it
rig.add(camera);
scene.add(rig);

// Created once the tour says which splat file this device loads (see main()).
let spark;

const look = new LookControls(camera, canvas);

function toast(msg, ms = 1800) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

function setProgress(frac, label) {
  $("#bar").style.width = `${Math.round(frac * 100)}%`;
  $("#loaderSub").textContent = label ?? `${Math.round(frac * 100)}%`;
}

const mb = (b) => (b / 1048576).toFixed(0);

// Streaming state of a paged (LoD) splat: `root` once the coarse top of the
// tree is resident (something is on screen), `frac` = share of the chunks the
// current view asks for that are resident, `done` when none are missing.
function streamState(splat) {
  const pager = spark?.pager;
  if (!pager || !splat?.paged) return { root: false, frac: 0, done: false, have: 0, want: 0 };
  const want = pager.fetchPriority.filter((f) => f.splats === splat.paged);
  const have = want.filter((f) => pager.getSplatsChunk(f.splats, f.chunk)).length;
  const root = !!pager.getSplatsChunk(splat.paged, 0);
  return { root, frac: want.length ? have / want.length : 0, done: root && have === want.length, have, want: want.length };
}

function applyTransform(obj, t) {
  if (!t) return;
  if (t.position) obj.position.fromArray(t.position);
  if (t.quaternion) obj.quaternion.fromArray(t.quaternion); // [x, y, z, w]
  if (t.scale != null) obj.scale.setScalar(t.scale);
}

async function main() {
  const tour = await loadTour(baseUrl);
  // Inside the listing app (&app=1&space=<id>): the chrome shared with the 360° viewer, see app/appmode.js
  const app = params.get("app") === "1" ? await import("./app/appmode.js").then((m) => m.prepare({ params, tour })) : null;
  document.title = `${tour.title} · SplatTour`;
  $("#title").textContent = tour.title;
  $("#subtitle").textContent = tour.subtitle;
  $("#loaderTitle").textContent = tour.title;
  // Published site: a way back to the list/upload home.
  if (import.meta.env.PROD && !app) {
    const back = document.createElement("a");
    back.className = "brand-back";
    back.href = "/";
    back.textContent = "← 공간 목록";
    const help = document.createElement("a");
    help.className = "brand-back";
    help.href = "/manual.html";
    help.target = "_blank";
    help.textContent = "사용 설명서";
    help.style.marginLeft = "6px";
    $("#brand").prepend(back, help);
  }

  // Phones stream a level-of-detail tree (tour.splatMode "lod", full SH3
  // colour): a pool of 64K-splat pages holds what the view needs, finest near
  // the viewer, arriving in ~3 MB pieces instead of one 35 MB download + decode.
  // The pool is sized to the tree once its header is in (capped at 40 pages =
  // 2.6M splats), so a house-sized scene is never evicted and refetched while
  // walking. Per-frame budget 2.0M splats: measured against the held-out
  // photos this matches the desktop file (31.0 dB / 0.908 vs 30.4 / 0.909),
  // where Spark's iOS default 1.5M gives 30.8 / 0.905. ?pages=, ?lodcount=,
  // ?lodscale= tune it on a real phone.
  const lodMode = tour.splatMode === "lod";
  // desktop streams the whole tree at full density (pool up to 128 pages ≈ 8.4M
  // splats, budget 6M) so the end result matches the full file
  const maxPages = Math.max(4, Math.round(+params.get("pages") || (tour.phone ? 40 : 128)));
  spark = new SparkRenderer(
    lodMode
      ? {
          renderer,
          maxPagedSplats: maxPages * 65536,
          lodSplatCount: +params.get("lodcount") || (tour.phone ? 2_000_000 : 6_000_000),
          lodSplatScale: +params.get("lodscale") || 1,
        }
      : { renderer },
  );
  scene.add(spark);

  const tLoad = performance.now();
  let splat = null;
  let occ = null;
  let streaming = null; // { splat } while a streamed view is still sharpening
  if (lodMode) {
    try {
      ({ splat, occ } = await loadStreamed());
      streaming = { splat };
    } catch (e) {
      console.warn("[splattour] streamed scene failed, loading the single file instead:", e);
      if (splat) { scene.remove(splat); splat.dispose(); }
      splat = null;
      tour.splatMode = "fallback";
      setProgress(0, "다른 방식으로 불러오는 중");
    }
  }
  if (!splat) {
    const occP = tour.phone && tour.lod?.occupancy ? loadBakedOccupancy() : null;
    occP?.catch(() => {});
    splat = await loadWhole(lodMode ? tour.fallbackUrl : tour.splatUrl);
    const tOcc = performance.now();
    // Phones take the grid baked from the same scene (seconds of CPU saved);
    // desktop builds it as before.
    occ = occP ? await occP.catch(() => null) : null;
    if (!occ) occ = new Occupancy(splat, tour);
    console.info(`[splattour] occupancy ${occ.nx}x${occ.ny}x${occ.nz} in ${Math.round(performance.now() - tOcc)}ms${occP ? " (baked)" : ""}`);
  }
  window.__loadTimes = { ...window.__loadTimes, mode: tour.splatMode, ready: Math.round(performance.now() - tLoad) };

  // The single-file path: download, decode, then everything is resident.
  async function loadWhole(url) {
    const known = tour.bytesOf(url);
    const s = new SplatMesh({
      url,
      raycastable: true,
      minRaycastOpacity: 0.2,
      onProgress: (e) => {
        // Vercel compresses on the fly and sends no Content-Length; fall back to
        // the size recorded in tour.json so the bar still moves.
        const total = e.lengthComputable ? e.total : known;
        if (total) setProgress(Math.min(1, e.loaded / total), `${mb(e.loaded)} / ${mb(total)} MB`);
        else setProgress(0, `${mb(e.loaded)} MB`);
      },
    });
    applyTransform(s, tour.splatTransform);
    scene.add(s);
    await s.initialized;
    console.info(`[splattour] splat loaded ${s.packedSplats?.numSplats} in ${Math.round(performance.now() - tLoad)}ms`);
    s.updateMatrixWorld(true);
    setProgress(1, "공간 준비 중");
    return s;
  }

  // The streamed path: header + baked occupancy grid, then render from the
  // start viewpoint while chunks arrive. The loader lifts once the view is
  // sharp, or 4 s after the first coarse picture, whichever comes first; the
  // rest keeps sharpening behind a small progress pill.
  async function loadBakedOccupancy() {
    const r = await fetch(tour.lod.occupancy);
    if (!r.ok) throw new Error(`occupancy ${r.status}`);
    return Occupancy.fromBuffer(await r.arrayBuffer());
  }

  async function loadStreamed() {
    if (!tour.lod?.occupancy) throw new Error("no baked occupancy grid");
    const occP = loadBakedOccupancy();
    occP.catch(() => {});
    const s = new SplatMesh({ url: tour.splatUrl, paged: true });
    splat = s; // so a failure below can remove it
    applyTransform(s, tour.splatTransform);
    scene.add(s);
    const { meta } = await s.paged.getRadMeta(); // fails fast on 404 / CORS
    // The pager is allocated on the first render, from this value.
    if (!spark.pager && meta.chunks?.length) spark.maxPagedSplats = Math.min(maxPages, meta.chunks.length) * 65536;
    const o = await occP;
    console.info(`[splattour] streamed tree: ${meta.chunks?.length} chunks; occupancy ${o.nx}x${o.ny}x${o.nz} (baked)`);
    const start = tour.byId.get(params.get("node")) || tour.start;
    rig.position.copy(start.position);
    look.set(start.yaw, start.pitch);
    await new Promise((resolve, reject) => {
      const t0 = performance.now();
      let firstAt = 0;
      let shown = 0;
      let doneFrames = 0; // the wanted set grows as chunks arrive; "done" must hold
      const tick = () => {
        look.update(0);
        renderer.render(scene, camera);
        const st = streamState(s);
        const now = performance.now();
        if (st.root && !firstAt) {
          firstAt = now;
          window.__loadTimes = { ...window.__loadTimes, firstFrame: Math.round(now - tLoad) };
          console.info(`[splattour] first streamed frame in ${Math.round(now - tLoad)}ms`);
        }
        shown = Math.max(shown, st.frac);
        setProgress(shown, `${Math.round(shown * 100)}%`);
        doneFrames = st.done ? doneFrames + 1 : 0;
        if (st.root && (doneFrames >= 20 || now - firstAt > 4000)) return resolve();
        if (!st.root && now - t0 > 45000) return reject(new Error("no data from the streamed scene in 45 s"));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return { splat: s, occ: o };
  }

  const nav = new Navigator({ tour, rig, look });
  nav.headingFn = (p, yaw) => occ.openHeading(p, yaw);
  // Walking (default): eye height, walking pace, around furniture.
  // ?move=fly restores the earlier flight between viewpoints (study condition).
  const walkMode = params.get("move") !== "fly";
  const walkMap = walkMode ? new WalkMap(occ, tour) : null;
  if (+params.get("walk") > 0) nav.walkSpeed = +params.get("walk");
  const floorAt = (p) => tour.nearestNode(p).floorY;
  // Waypoints from `from` to `to`: start and end keep their heights (viewpoints
  // are the photographer's eye), the corners in between sit at eye height.
  function planWalk(from, to) {
    const g = walkMap.level(floorAt(to));
    const r = walkMap.route(g, from, to);
    if (!r) return null;
    const eyeY = g.fy + tour.eyeHeight;
    const pts = r.map(([x, z]) => new THREE.Vector3(x, eyeY, z));
    pts[0] = from.clone();
    const last = pts[pts.length - 1];
    if (Math.hypot(last.x - to.x, last.z - to.z) < 0.02) last.y = to.y;
    return pts;
  }
  if (walkMode) nav.planner = planWalk;
  app?.limitWalk(walkMap);
  // Study parameters: ?speed=<m/s> flight speed, ?vignette=0 turns the comfort vignette off.
  if (+params.get("speed") > 0) nav.speed = +params.get("speed");
  const vignetteOn = params.get("vignette") !== "0";
  const vignette = $("#vignette");
  const hotspots = new Hotspots({ scene, camera, rig, tour, labelLayer: $("#labels") });
  // Source photos: the button appears only when the scene ships them.
  const photosBtn = document.querySelector('[data-act="photos"]');
  const photos = new Photos({ tour, nav, look, rig, toast });
  photos.onClose = () => photosBtn.classList.remove("on");
  photos.load().then((ok) => {
    photosBtn.hidden = !ok;
    // ?photos=1 (the home page's "원본 사진 보기"): open straight on the photo list
    if (ok && params.get("photos") === "1") { photos.toggle(true); photosBtn.classList.add("on"); }
  }).catch((e) => console.warn("[photos]", e));
  // Baked floor plan for the minimap on the streamed path (null elsewhere).
  const planImage = splat.paged && tour.lod?.plan
    ? new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = tour.lod.plan; })
    : Promise.resolve(null);
  const pano = new PanoMode({ renderer, spark, scene, splat, hideObjects: [hotspots.group, hotspots.cursor] });

  // ---------- lighting & sound ----------
  const lighting = new Lighting(splat, tour.data.lights || []);
  const audio = new TourAudio({ tour, camera });
  setupMood();

  function setupMood() {
    const bind = (id, key) => {
      const el = $(id);
      el.value = lighting.params[key];
      el.addEventListener("input", () => {
        lighting.set(key, Number(el.value));
        document.querySelectorAll("#presets button").forEach((b) => b.classList.remove("on"));
      });
    };
    bind("#sExposure", "exposure");
    bind("#sKelvin", "kelvin");
    bind("#sAmbient", "ambient");
    bind("#sSaturation", "saturation");
    const syncSliders = () => {
      for (const [id, key] of [["#sExposure", "exposure"], ["#sKelvin", "kelvin"], ["#sAmbient", "ambient"], ["#sSaturation", "saturation"]]) $(id).value = lighting.params[key];
    };
    $("#presets").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      lighting.preset(b.dataset.p);
      syncSliders();
      document.querySelectorAll("#presets button").forEach((x) => x.classList.toggle("on", x === b));
    });
    const list = $("#lightList");
    $("#lightsHead").hidden = lighting.lights.length === 0;
    for (const l of lighting.lights) {
      const row = document.createElement("div");
      row.className = "light-row";
      row.innerHTML = `<span></span><button class="switch" aria-label="켜기/끄기"></button>`;
      row.querySelector("span").textContent = l.name;
      const sw = row.querySelector(".switch");
      sw.classList.toggle("on", l.on);
      sw.addEventListener("click", () => setLamp(l, !l.on));
      l.switchEl = sw;
      list.appendChild(row);

      const lamp = document.createElement("button");
      lamp.className = "lamp";
      lamp.title = l.name;
      lamp.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 21h6v-1.5H9V21zm3-19a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2z"/></svg>`;
      lamp.classList.toggle("on", l.on);
      lamp.addEventListener("click", (e) => { e.stopPropagation(); setLamp(l, !l.on); });
      $("#lamps").appendChild(lamp);
      l.lampEl = lamp;
    }
    $("#musicPlay").addEventListener("click", toggleMusic);
    $("#sVolume").addEventListener("input", (e) => audio.setVolume(Number(e.target.value)));
  }

  function setLamp(l, on) {
    lighting.toggle(l.id, on);
    l.switchEl.classList.toggle("on", on);
    l.lampEl.classList.toggle("on", on);
    toast(`${l.name} ${on ? "켜짐" : "꺼짐"}`, 1000);
  }

  async function toggleMusic() {
    const on = audio.toggle();
    $("#musicPlay").textContent = on ? "정지" : "재생";
    $("#musicPlay").classList.toggle("on", on);
    document.querySelector('[data-act="music"]').classList.toggle("on", on);
    $("#musicNow").textContent = on ? (audio.tracks.length ? `♪ ${audio.tracks[audio.trackIndex ?? 0].title}` : "♪ 공간 음악 (실시간 생성)") : "";
  }

  // Lamp markers: projected into the view, hidden when behind walls.
  const _lv = new THREE.Vector3();
  function updateLamps() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const eye = camera.getWorldPosition(new THREE.Vector3());
    for (const l of lighting.lights) {
      _lv.copy(l.position).project(camera);
      const d = l.position.distanceTo(eye);
      let show = _lv.z < 1 && Math.abs(_lv.x) < 1.05 && Math.abs(_lv.y) < 1.05 && d < 12 && lampsVisible;
      if (show) {
        const dir = l.position.clone().sub(eye).normalize();
        show = occ.march(eye, dir, d, 0.15) >= d - Math.max(0.45, l.emitter * 1.2);
      }
      l.lampEl.style.display = show ? "" : "none";
      if (show) l.lampEl.style.transform = `translate(${((_lv.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-_lv.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
    }
  }
  let lampsVisible = true;

  // ---------- thumbnails (rendered from the splat when not supplied) ----------
  const thumbs = new Map();
  async function renderThumbs() {
    const tw = 312;
    const th = 184;
    const off = document.createElement("canvas");
    off.width = tw;
    off.height = th;
    const ctx = off.getContext("2d");
    const saved = { pos: rig.position.clone(), yaw: look.yaw, pitch: look.pitch, fov: look.fov };
    const tcam = new THREE.PerspectiveCamera(80, tw / th, 0.03, 500);
    rig.add(tcam);
    const size = renderer.getSize(new THREE.Vector2());
    for (const n of tour.nodes) {
      if (n.thumb) { thumbs.set(n.id, n.thumb); continue; }
      rig.position.copy(n.position);
      tcam.quaternion.setFromEuler(new THREE.Euler(-0.05, n.yaw, 0, "YXZ"));
      rig.updateMatrixWorld(true);
      renderer.setSize(tw * 2, th * 2, false);
      await spark.update({ scene, camera: tcam });
      renderer.render(scene, tcam);
      ctx.drawImage(renderer.domElement, 0, 0, tw, th);
      const blob = await new Promise((r) => off.toBlob(r, "image/jpeg", 0.85));
      thumbs.set(n.id, URL.createObjectURL(blob));
    }
    rig.remove(tcam);
    renderer.setSize(size.x, size.y, false);
    rig.position.copy(saved.pos);
    look.set(saved.yaw, saved.pitch);
  }
  const tThumbs = performance.now();
  await renderThumbs();
  hotspots.thumbs = thumbs;
  if (nav.current) hotspots.show(nav.current);
  console.info(`[splattour] thumbnails in ${Math.round(performance.now() - tThumbs)}ms`);

  // ---------- thumbnail strip ----------
  const track = $("#track");
  const thumbEls = new Map();
  for (const n of tour.nodes) {
    const b = document.createElement("button");
    b.className = "thumb";
    b.style.backgroundImage = `url("${thumbs.get(n.id)}")`;
    b.innerHTML = `<span></span>`;
    b.querySelector("span").textContent = n.name;
    b.addEventListener("click", () => go(n));
    track.appendChild(b);
    thumbEls.set(n.id, b);
  }
  document.querySelectorAll(".strip-nav").forEach((b) =>
    b.addEventListener("click", () => {
      const i = nav.current ? nav.current.index : 0;
      const n = tour.nodes[(i + Number(b.dataset.dir) + tour.nodes.length) % tour.nodes.length];
      go(n);
    }),
  );
  $("#stripToggle").addEventListener("click", () => {
    $("#strip").classList.toggle("collapsed");
    $("#stripToggle").classList.toggle("collapsed");
  });

  // ---------- modes ----------
  let mode = params.get("mode") === "pano" && !app ? "pano" : "splat";
  let freeRoam = false;
  const modeBtn = document.querySelector('[data-act="mode"]');
  async function setMode(m) {
    mode = m;
    modeBtn.querySelector(".ico").textContent = m === "splat" ? "3D" : "360";
    modeBtn.classList.toggle("on", m === "pano");
    if (m === "pano") {
      if (!nav.current) nav.jumpTo(tour.nearestNode(rig.position), { yaw: look.yaw, pitch: look.pitch });
      await pano.enter(nav.current);
      pano.prefetch(tour.neighbors(nav.current));
      toast("파노라마 모드 (기존 360 투어 방식)");
    } else {
      pano.exit();
      toast("3D 모드 (공간을 날아서 이동)");
    }
  }

  async function go(node) {
    if (!node || node === nav.current) return;
    hideHint();
    if (mode === "pano") {
      if (pano.fade) return;
      const from = nav.current;
      // Arrive facing open space, with the same rule as the 3D flight (navigator.headingFn),
      // so the two study conditions differ only in how you move, not in what you face.
      // The view turns toward it during the cross-fade (no snap afterwards).
      const travel = from ? yawOf(new THREE.Vector3().subVectors(node.position, from.position)) : node.yaw;
      const arriveYaw = nav.headingFn ? nav.headingFn(node.position, travel) : travel;
      await pano.transition(node, look, 0.9, arriveYaw);
      nav.jumpTo(node, { yaw: look.yaw, pitch: look.pitch });
      pano.prefetch(tour.neighbors(node));
      return;
    }
    if (!nav.current) {
      nav.goTo(node);
      return;
    }
    const route = tour.path(nav.current, node);
    if (!route) {
      // Disconnected part of the space: fade through black like a door.
      await fadeJump(node);
      return;
    }
    nav.goTo(node);
  }

  async function fadeJump(node) {
    const f = $("#loader");
    f.classList.remove("done");
    f.style.transition = "opacity .35s";
    f.firstElementChild.style.visibility = "hidden";
    await new Promise((r) => setTimeout(r, 360));
    nav.jumpTo(node);
    f.classList.add("done");
    setTimeout(() => { f.style.transition = ""; f.firstElementChild.style.visibility = ""; }, 400);
  }

  nav.addEventListener("depart", () => {
    hotspots.clear();
    hotspots.setCursor(null);
  });
  nav.addEventListener("arrive", (e) => {
    const node = e.detail.node;
    $("#nodeName").textContent = node ? node.name : "";
    for (const [id, el] of thumbEls) el.classList.toggle("active", node && id === node.id);
    if (node) {
      const el = thumbEls.get(node.id);
      el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      hotspots.show(node);
      const u = new URL(location.href);
      u.searchParams.set("node", node.id);
      history.replaceState(null, "", u);
    }
  });
  hotspots.onPick = go;

  // ---------- pointer: hover cursor + click to move ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let lastHover = 0;
  let hoverMarker = null;
  let pendingHover = null;
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  function floorY() {
    const n = nav.current || tour.nearestNode(rig.position);
    return n.floorY;
  }

  // Resolve what a click at `ndc` would do: a marker, a node near the floor
  // point, or (in free-roam) the floor point itself. Floor points hidden
  // behind walls are rejected using the occupancy grid.
  function resolveTarget() {
    raycaster.setFromCamera(ndc, camera);
    const m = hotspots.pickMarker(ndc);
    if (m) return { node: m.node, point: m.group.position.clone(), marker: m };
    floorPlane.constant = -floorY();
    const hit = raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3());
    if (!hit) return null;
    const dist = hit.distanceTo(raycaster.ray.origin);
    if (dist > 14) return null;
    const free = occ.march(raycaster.ray.origin, raycaster.ray.direction, dist, 0.15);
    if (free < dist - 0.25) return null;
    const node = tour.nearestNode(hit, { maxDist: 1.4 });
    if (node && node !== nav.current) {
      return { node, point: new THREE.Vector3(node.position.x, node.floorY, node.position.z), snapped: true };
    }
    if (freeRoam) {
      const eye = new THREE.Vector3(hit.x, hit.y + tour.eyeHeight, hit.z);
      if (!occ.occupied(eye) && occ.clear(rig.position, eye, 0.2)) return { node: null, point: hit, free: true };
    }
    // Fall back to the nearest viewpoint in that area.
    const near = tour.nearestNode(hit, { maxDist: 3.5 });
    if (near && near !== nav.current) return { node: near, point: hit, loose: true };
    return { node: null, point: hit, none: true };
  }

  canvas.addEventListener("pointermove", (e) => {
    ndc.set((e.clientX / canvas.clientWidth) * 2 - 1, -(e.clientY / canvas.clientHeight) * 2 + 1);
    pendingHover = true;
  });
  canvas.addEventListener("pointerleave", () => {
    pendingHover = null;
    hotspots.setCursor(null);
    hoverMarker = null;
  });
  canvas.addEventListener("pointerdown", () => canvas.classList.add("dragging"));
  canvas.addEventListener("pointerup", (e) => {
    canvas.classList.remove("dragging");
    if (look.moved > 6 || e.button !== 0) return;
    ndc.set((e.clientX / canvas.clientWidth) * 2 - 1, -(e.clientY / canvas.clientHeight) * 2 + 1);
    if (mode === "pano") {
      const m = hotspots.pickMarker(ndc);
      if (m) go(m.node);
      return;
    }
    const t = resolveTarget();
    if (!t) return;
    // Wait a moment: a second click turns this into "다가가 보기" instead of a move.
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (t.node) go(t.node);
      else if (t.none) toast("이 방향에는 이동할 시점이 없어요");
      else {
        hideHint();
        nav.goToPoint(new THREE.Vector3(t.point.x, t.point.y + tour.eyeHeight, t.point.z));
      }
    }, 230);
  });
  let clickTimer = 0;

  // Double-click anywhere → walk there. On the floor: to that spot. On a wall
  // or an object: to standing distance in front of it, then look at it.
  function walkToClick(e) {
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin.clone(), dir = raycaster.ray.direction.clone();
    const dist = occ.march(o, dir, 25, 0.15);
    const fy = floorY();
    floorPlane.constant = -fy;
    const fh = raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3());
    const fd = fh ? fh.distanceTo(o) : Infinity;
    let goal, lookAt = null;
    const hitY = o.y + dir.y * dist;
    // the floor itself is voxels too: a hit near floor height is a floor click
    if (fd < 25 && (fd <= dist + 0.15 || hitY < fy + 0.3)) goal = fd <= dist + 0.15 ? fh : o.clone().addScaledVector(dir, dist);
    else if (dist < 25) {
      lookAt = o.clone().addScaledVector(dir, dist);
      const h = new THREE.Vector3(dir.x, 0, dir.z);
      const hl = h.length();
      if (hl < 0.2) { look.zoomAt(look.targetFov * 0.6, e.clientX, e.clientY); return; } // straight up/down
      goal = lookAt.clone().addScaledVector(h.divideScalar(hl), -0.75);
    } else { toast("너무 멀어서 갈 수 없어요"); return; }
    const eye = new THREE.Vector3(goal.x, fy + tour.eyeHeight, goal.z);
    if (!lookAt) {
      // A floor spot at the foot of a wall: stop a comfortable step short
      // instead of ending nose to the wall.
      const h = new THREE.Vector3(eye.x - o.x, 0, eye.z - o.z);
      const hl = h.length();
      if (hl > 0.01) {
        h.divideScalar(hl);
        const ahead = occ.march(eye, h, 0.6, 0.02);
        if (ahead < 0.6) eye.addScaledVector(h, -Math.min(hl, 0.6 - ahead));
      }
    }
    if (Math.hypot(eye.x - o.x, eye.z - o.z) < 0.35) {
      if (lookAt) look.zoomAt(look.targetFov * 0.6, e.clientX, e.clientY); // already there: just zoom
      return;
    }
    hideHint();
    if (!nav.goToPoint(eye, { lookAt })) toast("거기까지 걸어갈 길이 없어요");
  }

  // Double-click an object → fly up to it and look at it ("다가가 보기", ?move=fly).
  // The surface is found with the occupancy grid (microseconds, no splat raycast).
  canvas.addEventListener("dblclick", (e) => {
    e.preventDefault();
    clearTimeout(clickTimer);
    if (mode !== "splat") return;
    ndc.set((e.clientX / canvas.clientWidth) * 2 - 1, -(e.clientY / canvas.clientHeight) * 2 + 1);
    if (walkMode) { walkToClick(e); return; }
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin.clone(), dir = raycaster.ray.direction.clone();
    const dist = occ.march(o, dir, 12, 0.15);
    if (dist >= 12) { toast("너무 멀어서 다가갈 수 없어요"); return; }
    const surface = o.clone().addScaledVector(dir, dist);
    const standoff = THREE.MathUtils.clamp(dist * 0.35, 0.7, 1.1);
    const go2 = Math.max(0, dist - standoff);
    if (go2 < 0.35) { look.zoomAt(look.targetFov * 0.6, e.clientX, e.clientY); return; } // already close: just zoom
    const eye = o.clone().addScaledVector(dir, go2);
    const fy = floorY();
    eye.y = THREE.MathUtils.clamp(eye.y, fy + 0.6, fy + 2.2);
    if (!occ.clear(o, eye, 0.2)) { look.zoomAt(look.targetFov * 0.6, e.clientX, e.clientY); return; }
    hideHint();
    look.zoomAt(62);
    nav.goToPoint(eye, { lookAt: surface, duration: THREE.MathUtils.clamp(0.8 + go2 * 0.35, 0.9, 2.2) });
    toast("가까이 다가갔어요 · 바닥이나 시점을 누르면 다시 이동해요");
  });

  function updateHover(now) {
    if (!pendingHover || nav.busy || look.dragging || now - lastHover < 50) return;
    lastHover = now;
    pendingHover = false;
    const t = mode === "pano" ? (hotspots.pickMarker(ndc) ? { marker: hotspots.pickMarker(ndc) } : null) : resolveTarget();
    hoverMarker = t?.marker || null;
    if (mode === "splat" && t && !t.marker) hotspots.setCursor(t);
    else hotspots.setCursor(null);
    canvas.classList.toggle("pointing", !!t && !t.none);
  }

  // Keyboard: W / ↑ moves to the neighbour best aligned with the view.
  // (Walking mode walks freely with W A S D instead, see keyWalk; the
  // panorama condition keeps the hop.)
  window.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "w" && e.key !== "ArrowDown" && e.key !== "s") return;
    if (walkMode && mode === "splat") return;
    if (!nav.current || nav.busy) return;
    const back = e.key === "ArrowDown" || e.key === "s";
    const fwd = new THREE.Vector3(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
    if (back) fwd.negate();
    let best = null;
    let bestScore = Math.cos((50 * Math.PI) / 180);
    for (const n of tour.neighbors(nav.current)) {
      const d = new THREE.Vector3().subVectors(n.position, nav.current.position).setY(0).normalize();
      const s = d.dot(fwd);
      if (s > bestScore) { bestScore = s; best = n; }
    }
    if (best) go(best);
  });

  // ---------- tool buttons ----------
  let minimap = null;
  let autoTour = null;
  document.querySelector("#tools").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "mode") setMode(mode === "splat" ? "pano" : "splat");
    if (act === "help") coach.restart();
    if (act === "light") {
      const m = $("#mood");
      m.hidden = !m.hidden;
      b.classList.toggle("on", !m.hidden);
      if (!m.hidden) { $("#minimap").hidden = true; document.querySelector('[data-act="map"]').classList.remove("on"); }
      if (!m.hidden && photos.open) { photos.toggle(false); photos.onClose(); }
    }
    if (act === "music") toggleMusic();
    if (act === "photos") {
      const on = photos.toggle();
      b.classList.toggle("on", on);
      if (on) {
        $("#mood").hidden = $("#minimap").hidden = true;
        document.querySelectorAll('[data-act="light"], [data-act="map"]').forEach((x) => x.classList.remove("on"));
      }
    }
    if (act === "fullscreen") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    }
    if (act === "map") {
      const mm = $("#minimap");
      mm.hidden = !mm.hidden;
      b.classList.toggle("on", !mm.hidden);
      if (!mm.hidden) { $("#mood").hidden = true; document.querySelector('[data-act="light"]').classList.remove("on"); }
      if (!mm.hidden && photos.open) { photos.toggle(false); photos.onClose(); }
      if (!mm.hidden && !minimap) {
        toast("평면도를 만드는 중…");
        await new Promise((r) => setTimeout(r, 30));
        minimap = new Minimap({ canvas: mm, tour, splat, rig, look, planImage: splat.paged ? await planImage : null });
        minimap.onPick = go;
      }
    }
    if (act === "free") {
      freeRoam = !freeRoam;
      b.classList.toggle("on", freeRoam);
      toast(freeRoam ? "자유 이동: 바닥 어디든 눌러 이동" : "시점 이동만 허용");
    }
    if (act === "auto") {
      if (autoTour) { stopAuto(); return; }
      b.classList.add("on");
      autoTour = { i: nav.current ? nav.current.index : 0, wait: 0 };
      toast("자동 투어 시작");
    }
  });
  function stopAuto() {
    autoTour = null;
    look.autoRotate = false;
    document.querySelector('[data-act="auto"]').classList.remove("on");
  }
  look.addEventListener("interact", () => autoTour && stopAuto());

  // ---------- VR ----------
  const xr = new SparkXr({
    renderer,
    button: false,
    mode: "vr",
    referenceSpaceType: "local-floor",
    onReady: (ok) => { if (ok) document.querySelector('[data-act="vr"]').hidden = false; },
    onEnterXr: () => {
      // In XR the headset owns the camera; lower the rig by eye height so
      // local-floor coordinates put the user's head at the node.
      rig.position.y -= tour.eyeHeight;
      look.enabled = false;
    },
    onExitXr: () => {
      look.enabled = true;
      if (nav.current) nav.jumpTo(nav.current, { yaw: look.yaw });
    },
  });
  document.querySelector('[data-act="vr"]').addEventListener("click", () => xr.toggleXr());

  // ---------- start ----------
  const startNode = tour.byId.get(params.get("node")) || tour.start;
  nav.jumpTo(startNode);
  if (mode === "pano") await setMode("pano");
  $("#loader").classList.add("done");
  // Survived loading (see Tour.markLoaded): the streamed tree when it is sharp
  // (above), or after a minute of use; a single file a few seconds after showing.
  setTimeout(() => tour.markLoaded(), streaming ? 60000 : 5000);
  if (tour.stepDown) toast("이 휴대폰에 맞춰 더 가벼운 방식으로 열었어요", 3500);

  // First-visit coaching (look → move → get close), see coach.js
  const coach = new Coach($("#hint"), params);
  // User-study logging, loaded only with ?study=<participant> (see study.js)
  if (params.has("study")) {
    import("./study.js").then((s) => { window.__study = s.start({ nav, look, rig, params, canvas, tour, getMode: () => mode }); }).catch((e) => console.warn("[study]", e));
  }
  function hideHint() {} // moves report to the coach via the arrive/depart events instead
  look.addEventListener("interact", () => { const m0 = look.yaw; setTimeout(() => { if (Math.abs(look.yaw - m0) > 0.15 || look.moved > 40) coach.did("look"); }, 700); });
  nav.addEventListener("depart", () => coach.did("move"));
  canvas.addEventListener("dblclick", () => coach.did("close"));
  canvas.addEventListener("wheel", () => coach.did("zoom"), { passive: true });
  app?.start({ nav, look, rig, canvas, tour, scene, renderer, camera, occ, walkMap, splat, sceneName, loadScene: loadExtraScene }).catch((e) => console.warn("[app]", e));

  // Another room's model in the same space frame (app/portals.js): loaded
  // near a door to it, the same way as the first one (streamed tree + baked
  // walls when the scene has them, else the file and walls built from it).
  async function loadExtraScene(name) {
    const base = new URL(`${cloudBase || ""}/scenes/${encodeURIComponent(name)}/`, location.href);
    const t2 = await loadTour(base);
    let s, o = null;
    if (t2.splatMode === "lod" && t2.lod?.occupancy) {
      s = new SplatMesh({ url: t2.splatUrl, paged: true });
      applyTransform(s, t2.splatTransform);
      s.opacity = 0;
      scene.add(s);
      const r = await fetch(t2.lod.occupancy);
      if (!r.ok) throw new Error(`occupancy ${r.status}`);
      o = Occupancy.fromBuffer(await r.arrayBuffer());
    } else {
      s = new SplatMesh({ url: t2.fallbackUrl || t2.splatUrl });
      applyTransform(s, t2.splatTransform);
      s.opacity = 0;
      scene.add(s);
      await s.initialized;
      s.updateMatrixWorld(true);
      o = new Occupancy(s, t2);
    }
    return { name, tour: t2, splat: s, occ: o };
  }

  // Zoomed all the way in and still scrolling → step toward what is under the
  // cursor (a 3D scene can get closer, not just crop the picture).
  let pushAcc = 0;
  canvas.addEventListener("wheel", (e) => {
    if (mode !== "splat" || nav.busy || e.deltaY >= 0) { pushAcc = 0; return; }
    if (look.targetFov > look.minFov + 0.5) return;
    pushAcc += -e.deltaY;
    if (pushAcc < 240) return; // about two notches past the limit
    pushAcc = 0;
    ndc.set((e.clientX / canvas.clientWidth) * 2 - 1, -(e.clientY / canvas.clientHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin.clone(), dir = raycaster.ray.direction.clone();
    const dist = occ.march(o, dir, 12, 0.15);
    const step = Math.min(0.8, dist - 0.55);
    if (step < 0.12) { toast("더 가까이 갈 수 없어요"); return; }
    const eye = o.clone().addScaledVector(dir, step);
    const fy = floorY();
    eye.y = THREE.MathUtils.clamp(eye.y, fy + 0.5, fy + 2.3);
    if (walkMode) {
      // a walker leans in; the eyes stay at standing height
      eye.y = o.y;
      if (!walkMap.canStand(walkMap.level(fy), eye.x, eye.z)) { toast("더 가까이 갈 수 없어요"); return; }
    }
    look.zoomAt(34); // widen as we move in: the object stays about the same size, now sharper
    nav.goToPoint(eye, { fly: true, lookAt: o.clone().addScaledVector(dir, dist), duration: 0.55 });
  }, { passive: true });

  // ---------- keyboard walking (W A S D / ↑ ↓, Shift to hurry) ----------
  // Like a first-person game: move relative to where you look, slide along
  // walls instead of stopping dead, eyes at standing height.
  const held = new Set();
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
    held.add(e.code);
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));
  window.addEventListener("blur", () => held.clear());
  const keyVel = new THREE.Vector3();
  let keyWalking = false;
  function keyWalk(dt) {
    if (!walkMode || mode !== "splat") { keyVel.set(0, 0, 0); return; }
    const fwd = (held.has("KeyW") || held.has("ArrowUp") ? 1 : 0) - (held.has("KeyS") || held.has("ArrowDown") ? 1 : 0);
    const side = (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0);
    const want = new THREE.Vector3();
    if (fwd || side) {
      const sy = Math.sin(look.yaw), cy = Math.cos(look.yaw);
      want.set(-sy * fwd + cy * side, 0, -cy * fwd - sy * side).normalize();
      want.multiplyScalar(nav.walkSpeed * (held.has("ShiftLeft") || held.has("ShiftRight") ? 1.9 : 1));
    }
    // Limited acceleration (1.6 m/s², 2.4 to stop): a calm start, no lurch.
    const dv = want.clone().sub(keyVel);
    const lim = (want.lengthSq() >= keyVel.lengthSq() ? 1.6 : 2.4) * dt;
    if (dv.length() > lim) dv.setLength(lim);
    keyVel.add(dv);
    if (keyVel.length() < 0.02 && !(fwd || side)) {
      keyVel.set(0, 0, 0);
      if (keyWalking) {
        keyWalking = false;
        // Stopped on a viewpoint: show its arrows again (without snapping onto it).
        const n = tour.nearestNode(rig.position, { maxDist: 0.4 });
        nav.current = n;
        nav.dispatchEvent(new CustomEvent("arrive", { detail: { node: n } }));
      }
      return;
    }
    if (!keyWalking) {
      keyWalking = true;
      hideHint();
      if (nav.moving) nav.stop();
      nav.current = null;
      nav.dispatchEvent(new CustomEvent("depart", { detail: { target: null, length: 0, duration: 0 } }));
    }
    const g = walkMap.level(floorY());
    const p = rig.position;
    const nx = p.x + keyVel.x * dt, nz = p.z + keyVel.z * dt;
    // slide along obstacles: try the full step, then each axis alone
    // a door whose other side is still loading stops the step (app/portals.js)
    if (app?.stepBlocked?.(p.x, p.z, nx, nz)) { keyVel.set(0, 0, 0); return; }
    if (walkMap.canStand(g, nx, nz) || !walkMap.canStand(g, p.x, p.z)) { p.x = nx; p.z = nz; }
    else if (walkMap.canStand(g, nx, p.z)) { p.x = nx; keyVel.z = 0; }
    else if (walkMap.canStand(g, p.x, nz)) { p.z = nz; keyVel.x = 0; }
    else keyVel.set(0, 0, 0);
    p.y += (g.fy + tour.eyeHeight - p.y) * (1 - Math.exp(-dt * 6));
  }

  // Small "sharpening" pill while the streamed view still misses chunks.
  function updateStreamPill() {
    let pill = $("#streamPill");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "streamPill";
      document.body.appendChild(pill);
    }
    const st = streamState(streaming.splat);
    streaming.doneFrames = st.done ? (streaming.doneFrames || 0) + 1 : 0;
    if (streaming.doneFrames >= 20) {
      if (!streaming.doneAt) {
        streaming.doneAt = performance.now();
        window.__loadTimes = { ...window.__loadTimes, sharp: Math.round(streaming.doneAt - tLoad) };
        setTimeout(() => tour.markLoaded(), 3000);
      }
      streaming.shown = 0;
      pill.classList.remove("show");
      return;
    }
    streaming.shown = Math.max(streaming.shown || 0, st.frac);
    pill.textContent = `선명하게 하는 중 ${Math.round(streaming.shown * 100)}%`;
    pill.classList.add("show");
  }

  // ---------- loop ----------
  const timer = new THREE.Timer();
  let frames = 0;
  let fpsT = 0;
  renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    if (!renderer.xr.isPresenting) {
      keyWalk(dt);
      nav.update(dt);
      // walking pace needs only a hint of the comfort vignette
      const vk = keyVel.length();
      if (vignetteOn) vignette.style.opacity = nav.busy ? Math.min(1, nav.speedNow / (walkMode ? 4 : 2.2)).toFixed(3) : vk > 0.05 ? Math.min(1, vk / 4).toFixed(3) : "0";
      look.update(dt);
      updateHover(now);
    }
    pano.update(dt, rig);
    lighting.update(dt);
    audio.update();
    updateLamps();
    hotspots.update(dt, hoverMarker);
    if (minimap && !$("#minimap").hidden) minimap.draw(nav.current);
    if (streaming) updateStreamPill();
    app?.frame(dt);

    if (autoTour && !nav.busy && !pano.fade) {
      autoTour.wait += dt;
      look.autoRotate = true;
      if (autoTour.wait > 4) {
        autoTour.wait = 0;
        autoTour.i = (autoTour.i + 1) % tour.nodes.length;
        go(tour.nodes[autoTour.i]);
      }
    }

    renderer.render(scene, camera);
    app?.afterRender?.(); // reads a few pixels beside doors (brightness match), see app/appmode.js
    frames++;
    fpsT += dt;
    if (fpsT > 1) {
      window.__fps = frames / fpsT;
      frames = 0;
      fpsT = 0;
    }
  });

  window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  // Debug / automation hooks (used by the evaluation scripts).
  window.splattour = { photos, tour, occ, lighting, audio, setLamp, nav, look, rig, camera, renderer, spark, splat, go, setMode, THREE, thumbs, Minimap, stream: () => streamState(splat) };
}

main().catch((err) => {
  console.error(err);
  $("#loaderTitle").textContent = "불러오지 못했습니다";
  $("#loaderSub").textContent = err.message;
});
