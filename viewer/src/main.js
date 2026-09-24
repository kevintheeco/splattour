import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkXr } from "@sparkjsdev/spark";
import { loadTour } from "./tour.js";
import { LookControls, yawOf } from "./look.js";
import { Navigator } from "./navigator.js";
import { Hotspots } from "./hotspots.js";
import { Minimap } from "./minimap.js";
import { PanoMode } from "./panomode.js";
import { Occupancy } from "./occupancy.js";
import { Lighting } from "./lighting.js";
import { TourAudio } from "./audio.js";
import { Coach } from "./coach.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const sceneName = params.get("scene") || "demo";
const baseUrl = new URL(`/scenes/${encodeURIComponent(sceneName)}/`, location.href);

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

const spark = new SparkRenderer({ renderer });
scene.add(spark);

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

function applyTransform(obj, t) {
  if (!t) return;
  if (t.position) obj.position.fromArray(t.position);
  if (t.quaternion) obj.quaternion.fromArray(t.quaternion); // [x, y, z, w]
  if (t.scale != null) obj.scale.setScalar(t.scale);
}

async function main() {
  const tour = await loadTour(baseUrl);
  document.title = `${tour.title} · SplatTour`;
  $("#title").textContent = tour.title;
  $("#subtitle").textContent = tour.subtitle;
  $("#loaderTitle").textContent = tour.title;

  const splat = new SplatMesh({
    url: tour.splatUrl,
    raycastable: true,
    minRaycastOpacity: 0.2,
    onProgress: (e) => {
      if (e.lengthComputable) setProgress(e.loaded / e.total, `${(e.loaded / 1048576).toFixed(0)} / ${(e.total / 1048576).toFixed(0)} MB`);
    },
  });
  applyTransform(splat, tour.splatTransform);
  scene.add(splat);
  const tLoad = performance.now();
  await splat.initialized;
  console.info(`[splattour] splat loaded ${splat.packedSplats?.numSplats} in ${Math.round(performance.now() - tLoad)}ms`);
  splat.updateMatrixWorld(true);
  setProgress(1, "공간 준비 중");

  const tOcc = performance.now();
  const occ = new Occupancy(splat, tour);
  console.info(`[splattour] occupancy ${occ.nx}x${occ.ny}x${occ.nz} in ${Math.round(performance.now() - tOcc)}ms`);

  const nav = new Navigator({ tour, rig, look });
  nav.headingFn = (p, yaw) => occ.openHeading(p, yaw);
  // Study parameters: ?speed=<m/s> flight speed, ?vignette=0 turns the comfort vignette off.
  if (+params.get("speed") > 0) nav.speed = +params.get("speed");
  const vignetteOn = params.get("vignette") !== "0";
  const vignette = $("#vignette");
  const hotspots = new Hotspots({ scene, camera, rig, tour, labelLayer: $("#labels") });
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
  let mode = params.get("mode") === "pano" ? "pano" : "splat";
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
      await pano.transition(node, look);
      nav.jumpTo(node, { yaw: from ? yawOf(new THREE.Vector3().subVectors(node.position, from.position)) : node.yaw, pitch: 0 });
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

  // Double-click an object → fly up to it and look at it ("다가가 보기").
  // The surface is found with the occupancy grid (microseconds, no splat raycast).
  canvas.addEventListener("dblclick", (e) => {
    e.preventDefault();
    clearTimeout(clickTimer);
    if (mode !== "splat") return;
    ndc.set((e.clientX / canvas.clientWidth) * 2 - 1, -(e.clientY / canvas.clientHeight) * 2 + 1);
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
  window.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "w" && e.key !== "ArrowDown" && e.key !== "s") return;
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
    }
    if (act === "music") toggleMusic();
    if (act === "fullscreen") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    }
    if (act === "map") {
      const mm = $("#minimap");
      mm.hidden = !mm.hidden;
      b.classList.toggle("on", !mm.hidden);
      if (!mm.hidden) { $("#mood").hidden = true; document.querySelector('[data-act="light"]').classList.remove("on"); }
      if (!mm.hidden && !minimap) {
        toast("평면도를 만드는 중…");
        await new Promise((r) => setTimeout(r, 30));
        minimap = new Minimap({ canvas: mm, tour, splat, rig, look });
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

  // First-visit coaching (look → move → get close), see coach.js
  const coach = new Coach($("#hint"), params);
  function hideHint() {} // moves report to the coach via the arrive/depart events instead
  look.addEventListener("interact", () => { const m0 = look.yaw; setTimeout(() => { if (Math.abs(look.yaw - m0) > 0.15 || look.moved > 40) coach.did("look"); }, 700); });
  nav.addEventListener("depart", () => coach.did("move"));
  canvas.addEventListener("dblclick", () => coach.did("close"));
  canvas.addEventListener("wheel", () => coach.did("zoom"), { passive: true });

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
    look.zoomAt(34); // widen as we move in: the object stays about the same size, now sharper
    nav.goToPoint(eye, { lookAt: o.clone().addScaledVector(dir, dist), duration: 0.55 });
  }, { passive: true });

  // ---------- loop ----------
  const timer = new THREE.Timer();
  let frames = 0;
  let fpsT = 0;
  renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    if (!renderer.xr.isPresenting) {
      nav.update(dt);
      if (vignetteOn) vignette.style.opacity = nav.busy ? Math.min(1, nav.speedNow / 2.2).toFixed(3) : "0";
      look.update(dt);
      updateHover(now);
    }
    pano.update(dt, rig);
    lighting.update(dt);
    audio.update();
    updateLamps();
    hotspots.update(dt, hoverMarker);
    if (minimap && !$("#minimap").hidden) minimap.draw(nav.current);

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
  window.splattour = { tour, occ, lighting, audio, setLamp, nav, look, rig, camera, renderer, spark, splat, go, setMode, THREE };
}

main().catch((err) => {
  console.error(err);
  $("#loaderTitle").textContent = "불러오지 못했습니다";
  $("#loaderSub").textContent = err.message;
});
