// 360° 시점 탐색: the conventional capture-point tour. You stand on a fixed
// capture point, look around in its equirectangular panorama (drag, pinch,
// or by moving the phone), and hop to a neighbouring point through a floor
// hotspot, with a short Street View style transition. Data-driven by the
// space's nav.json (see scripts/import-360.mjs for bringing real 360 files in).
//
//   /pano.html?space=<id>[&node=<id>][&study=<pid>&tasks=1&next=<url>][&dev=1]
//
// Real 360 captures only. A point without an image shows a clearly labelled
// placeholder (and only with &dev=1 while nav.json says the captures are not ready).
import * as THREE from "three";
import { LookControls } from "../look.js";
import { loadListing, loadNav, loadTasks, esc, bearing } from "./data.js";
import { icon } from "./icons.js";
import { ViewerChrome, matchLook } from "./chrome.js";
import { TaskRunner } from "./tasks.js";
import { createStudyLog, studyBadge, summarizeApp } from "./studylog.js";
import "./viewer.css";

const params = new URLSearchParams(location.search);
const spaceId = params.get("space") || "wolhajeong";
const DEV = params.get("dev") === "1";
const STUDY = params.has("study");
const PHONE = matchMedia("(pointer: coarse)").matches;
const EYE = 1.5; // metres: camera height used to lay hotspot discs on the floor
const START_PITCH = -0.2; // same as the 3DGS viewer's start views: floor hotspots in sight

const vert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }`;
// Two panoramas, each placed as a sphere of radius R around its capture point.
// During a "warp" transition the virtual eye travels from A to B and each
// sphere is sampled where the eye's ray meets it (the Street View move);
// "fade" keeps the eye still and only cross-fades.
const frag = /* glsl */ `
  uniform sampler2D texA;
  uniform sampler2D texB;
  uniform float yawA;
  uniform float yawB;
  uniform float mixAB;
  uniform float radA;
  uniform float radB;
  uniform vec3 posA;
  uniform vec3 posB;
  uniform vec3 eye;
  uniform float warp;
  varying vec3 vDir;
  vec2 equi(vec3 d, float y0) {
    float yaw = atan(-d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    return vec2(fract(0.5 + (y0 - yaw) / 6.28318531), 0.5 + lat / 3.14159265);
  }
  vec3 through(vec3 d, vec3 c, vec3 p, float R) {
    vec3 q = c - p;
    float b = dot(q, d);
    float h = b * b - (dot(q, q) - R * R);
    if (h < 0.0) return d;
    return normalize(q + (-b + sqrt(h)) * d);
  }
  void main() {
    vec3 d = normalize(vDir);
    vec3 da = warp > 0.5 ? through(d, eye, posA, radA) : d;
    vec3 db = warp > 0.5 ? through(d, eye, posB, radB) : d;
    vec4 a = texture2D(texA, equi(da, yawA));
    vec4 b = texture2D(texB, equi(db, yawB));
    gl_FragColor = mix(a, b, mixAB);
    #include <colorspace_fragment>
  }`;

const $ = (s) => document.querySelector(s);
const DEG = Math.PI / 180;
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

async function main() {
  const listing = await loadListing(spaceId);
  const nav = await loadNav(spaceId, listing);
  document.title = `${listing.title} · 360° 시점 탐색`;
  const backHref = `/listing.html?id=${encodeURIComponent(spaceId)}`;

  // Not ready (no real captures yet): say so instead of showing anything.
  if ((!nav.panoViewable || (STUDY && !nav.panoReady)) && !DEV) return pending(listing, nav, backHref);

  // ---------- renderer ----------
  const canvas = $("#view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 100);
  scene.add(camera);
  const look = new LookControls(camera, canvas);
  matchLook(look);

  const blank = new THREE.DataTexture(new Uint8Array([40, 40, 44, 255]), 1, 1);
  blank.needsUpdate = true;
  const U = {
    texA: { value: blank }, texB: { value: blank }, yawA: { value: 0 }, yawB: { value: 0 }, mixAB: { value: 0 },
    radA: { value: 3 }, radB: { value: 3 }, posA: { value: new THREE.Vector3() }, posB: { value: new THREE.Vector3() },
    eye: { value: new THREE.Vector3() }, warp: { value: 0 },
  };
  const sky = new THREE.Mesh(
    new THREE.BoxGeometry(40, 40, 40),
    new THREE.ShaderMaterial({ uniforms: U, vertexShader: vert, fragmentShader: frag, side: THREE.BackSide, depthWrite: false, depthTest: false }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // ---------- textures (real equirect files; labelled placeholder where missing) ----------
  const cache = new Map();
  const maxTex = PHONE ? 4 : 8;
  function tex(node) {
    if (cache.has(node.id)) { const e = cache.get(node.id); cache.delete(node.id); cache.set(node.id, e); return e; }
    const p = (async () => {
      let t;
      if (node.panoUrl) {
        t = await new THREE.TextureLoader().loadAsync(node.panoUrl);
      } else {
        t = new THREE.CanvasTexture(placeholder(nav.roomName(node.room), node.id));
      }
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      renderer.initTexture(t);
      return t;
    })();
    cache.set(node.id, p);
    // LRU: phones hold a few 4K panoramas at most (32 MB each on the GPU)
    while (cache.size > maxTex) {
      const [id, old] = cache.entries().next().value;
      if (id === current?.id) { cache.delete(id); cache.set(id, old); continue; }
      cache.delete(id);
      old.then((t) => { if (U.texA.value !== t && U.texB.value !== t) t.dispose(); });
    }
    return p;
  }
  const yawOfNode = (n) => (n.imageYawDeg || 0) * DEG;
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

  // ---------- hotspots: discs on the floor toward each neighbour ----------
  const hsGroup = new THREE.Group();
  scene.add(hsGroup);
  const labels = $("#labels");
  const ringGeo = new THREE.RingGeometry(0.21, 0.27, 48).rotateX(-Math.PI / 2);
  const discGeo = new THREE.CircleGeometry(0.21, 48).rotateX(-Math.PI / 2);
  let spots = [];
  function hotspotDir(from, to) {
    const o = from.hotspots?.find((h) => h.to === to.id);
    const yaw = o?.yawDeg != null ? yawOfNode(from) + o.yawDeg * DEG : bearing(from.position, to.position);
    const horiz = Math.hypot(to.position[0] - from.position[0], to.position[2] - from.position[2]);
    const d = o?.pitchDeg != null && o.pitchDeg < -3 ? EYE / Math.tan(-o.pitchDeg * DEG) : THREE.MathUtils.clamp(horiz, 1.3, 3.2);
    return { yaw, d };
  }
  function showSpots(node) {
    clearSpots();
    for (const id of node.neighbors) {
      const to = nav.byId.get(id);
      if (!to) continue;
      const { yaw, d } = hotspotDir(node, to);
      const g = new THREE.Group();
      g.position.set(-Math.sin(yaw) * d, -EYE, -Math.cos(yaw) * d);
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }));
      const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthTest: false }));
      ring.renderOrder = disc.renderOrder = 2;
      g.add(disc, ring);
      hsGroup.add(g);
      let label = null;
      if (to.room !== node.room) {
        label = document.createElement("button");
        label.className = "pv-label";
        label.innerHTML = `${esc(nav.roomName(to.room))}${icon("chevron")}`;
        label.addEventListener("click", () => go(to));
        labels.appendChild(label);
      }
      spots.push({ to, g, disc, label, yaw, t: 0 });
    }
  }
  function clearSpots() {
    for (const s of spots) { hsGroup.remove(s.g); s.g.children.forEach((m) => m.material.dispose()); s.label?.remove(); }
    spots = [];
  }
  const _v = new THREE.Vector3();
  function projectSpots(dt) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const s of spots) {
      s.t = Math.min(1, s.t + dt * 3);
      const k = smoother(s.t) * (s.hover ? 1.18 : 1);
      s.g.scale.setScalar(Math.max(0.001, k));
      s.disc.material.opacity = s.hover ? 0.5 : 0.22;
      _v.copy(s.g.position).setY(s.g.position.y + 0.42).project(camera);
      s.screen = { x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * h, front: _v.z < 1 };
      _v.copy(s.g.position).project(camera);
      s.base = { x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * h, front: _v.z < 1 };
      if (s.label) {
        const vis = s.screen.front && s.screen.x > -40 && s.screen.x < w + 40;
        s.label.style.display = vis ? "" : "none";
        if (vis) s.label.style.transform = `translate(${s.screen.x.toFixed(1)}px, ${s.screen.y.toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
  }
  function spotAt(x, y) {
    let best = null, bd = 64;
    for (const s of spots) {
      if (!s.base?.front) continue;
      const d = Math.hypot(s.base.x - x, s.base.y - y);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) return best;
    // a tap on the floor in roughly the direction of a point also goes there
    const r = canvas.getBoundingClientRect();
    const nd = new THREE.Vector3(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1, 0.5).unproject(camera).normalize();
    if (nd.y > -0.12) return null;
    const yaw = Math.atan2(-nd.x, -nd.z);
    let ba = 22 * DEG;
    for (const s of spots) {
      const a = Math.abs(Math.atan2(Math.sin(s.yaw - yaw), Math.cos(s.yaw - yaw)));
      if (a < ba) { ba = a; best = s; }
    }
    return best;
  }

  // ---------- state, moving ----------
  let current = null;
  let busy = false;
  let fade = null;
  const style = params.get("transition") || nav.transition?.style || "warp";
  const duration = +(params.get("tdur") || nav.transition?.duration || 0.8);

  async function place(node, { yaw } = {}) {
    const t = await tex(node);
    U.texA.value = U.texB.value = t;
    U.yawA.value = U.yawB.value = yawOfNode(node);
    U.posA.value.copy(V(node.position));
    U.posB.value.copy(V(node.position));
    U.eye.value.copy(V(node.position));
    U.mixAB.value = 0;
    U.warp.value = 0;
    if (yaw !== undefined) look.set(yaw, START_PITCH);
    arrive(node);
  }

  async function go(to) {
    if (busy || !to || to === current) return;
    busy = true;
    hideHint();
    const from = current;
    study?.log("depart", { from: from.id, to: to.id });
    clearSpots();
    const t = await tex(to);
    const dist = Math.hypot(to.position[0] - from.position[0], to.position[2] - from.position[2]);
    U.texB.value = t;
    U.yawB.value = yawOfNode(to);
    U.posB.value.copy(V(to.position));
    U.radA.value = U.radB.value = Math.max(2.6, dist * 1.3);
    U.warp.value = style === "warp" ? 1 : 0;
    await new Promise((resolve) => { fade = { t: 0, resolve, from, to }; });
    U.texA.value = t;
    U.yawA.value = U.yawB.value;
    U.posA.value.copy(U.posB.value);
    U.eye.value.copy(U.posB.value);
    U.mixAB.value = 0;
    U.warp.value = 0;
    look.fovKick = 0;
    busy = false;
    arrive(to);
    for (const id of to.neighbors) { const n = nav.byId.get(id); if (n) tex(n); } // warm the next hop
  }

  function stepFade(dt) {
    const f = fade;
    if (!f) return;
    f.t = Math.min(1, f.t + dt / duration);
    const e = smoother(f.t);
    if (style === "warp") {
      U.eye.value.lerpVectors(U.posA.value, U.posB.value, e);
      U.mixAB.value = THREE.MathUtils.smoothstep(f.t, 0.25, 0.85);
      look.fovKick = -5 * Math.sin(Math.PI * f.t);
    } else {
      U.mixAB.value = e;
      look.fovKick = -12 * Math.sin(Math.PI * Math.min(1, f.t * 1.1)) * (1 - f.t * 0.2);
    }
    if (f.t >= 1) { fade = null; f.resolve(); }
  }

  let lastRoom = null;
  function arrive(node) {
    current = node;
    showSpots(node);
    chrome.setRoom(nav.roomName(node.room));
    const u = new URL(location.href);
    u.searchParams.set("node", node.id);
    history.replaceState(null, "", u);
    study?.log("arrive", { node: node.id, room: node.room });
    if (node.room !== lastRoom) {
      lastRoom = node.room;
      study?.log("room", { room: node.room, node: node.id });
      runner?.roomChanged(node.room);
    }
  }

  // ---------- pointer ----------
  canvas.addEventListener("pointermove", (e) => {
    if (look.dragging) return;
    const s = busy ? null : spotAt(e.clientX, e.clientY);
    for (const x of spots) x.hover = x === s;
    canvas.style.cursor = s ? "pointer" : "grab";
  });
  canvas.addEventListener("pointerup", (e) => {
    if (look.moved > 6 || e.button !== 0) return;
    const s = spotAt(e.clientX, e.clientY);
    if (s) go(s.to);
  });
  window.addEventListener("keydown", (e) => {
    if (!current || busy || !(e.key === "ArrowUp" || e.key === "w")) return;
    let best = null, ba = 50 * DEG;
    for (const s of spots) {
      const a = Math.abs(Math.atan2(Math.sin(s.yaw - look.yaw), Math.cos(s.yaw - look.yaw)));
      if (a < ba) { ba = a; best = s; }
    }
    if (best) go(best.to);
  });

  // ---------- chrome, study, tasks ----------
  const chrome = new ViewerChrome({
    spaceTitle: listing.title, condition: "pano", backHref: STUDY ? "#" : backHref, nav, look,
    plan: params.get("plan") !== "0",
    onBack: () => (STUDY ? confirm("실험을 그만두고 나갈까요?") : true),
  });
  if (nav.devOnly) chrome.dev(nav.nodes.some((n) => !n.panoUrl) ? "360 촬영본이 도착하기 전의 자리표시 화면이에요" : "3DGS에서 렌더링한 임시 파노라마예요. 실험의 360° 조건은 실제 360 촬영본만 씁니다");

  let study = null;
  if (STUDY) {
    study = createStudyLog({ pid: params.get("study"), meta: { space: spaceId, cond: "pano", seq: params.get("seq") || "", transition: style, devOnly: nav.devOnly } });
    chrome.onEvent = (e, d) => study.log(e, d);
    let lastFov = look.targetFov;
    setInterval(() => {
      if (!current) return;
      study.log("pose", { node: current.id, p: [...U.eye.value.toArray().map((v) => +v.toFixed(3))], yaw: +look.yaw.toFixed(3), pitch: +look.pitch.toFixed(3), fov: +look.fov.toFixed(1) });
      if (Math.abs(look.targetFov - lastFov) > 0.5) { study.log("zoom", { fov: +look.targetFov.toFixed(1) }); lastFov = look.targetFov; }
    }, 250);
    addEventListener("pagehide", () => { study.log("end", { summary: summarizeApp(study.all) }); study.flush(true); });
    if (params.get("badge") !== "0") studyBadge(() => { const s = summarizeApp(study.all); return `실험 기록 중 · ${study.pid} · 360° · 방 ${s.roomsVisited.length} · ${Math.round(s.durationSec)}초`; }, () => study.download(summarizeApp(study.all)));
    window.__study = { log: study.log, summarize: () => summarizeApp(study.all), all: study.all };
  }

  let runner = null;
  const tasks = STUDY || params.get("tasks") === "1" ? await loadTasks(spaceId, listing) : [];
  const next = params.get("next");

  // ---------- start ----------
  const startNode = nav.byId.get(params.get("node")) || nav.start;
  await place(startNode, { yaw: yawOfNode(startNode) });
  $("#loader").classList.add("done");
  if (tasks.length) {
    runner = new TaskRunner({
      slot: chrome.taskSlot, tasks, nav,
      log: (e, d) => study?.log(e, d),
      getPose: () => ({ x: current.position[0], z: current.position[2], yaw: look.yaw, room: current.room }),
      jumpTo: async (id) => { const n = nav.byId.get(id); if (n && n !== current) await place(n, { yaw: yawOfNode(n) }); else if (n) look.set(yawOfNode(n), START_PITCH); },
      onDone: () => { study?.log("end", { summary: summarizeApp(study.all) }); study?.flush(true); location.href = next || backHref; },
      nextLabel: next ? "다음으로" : "숙소로 돌아가기",
    });
    runner.start();
  }

  // first-visit hint (off with &onboarding=0)
  const hint = document.createElement("div");
  hint.className = "vc-hint";
  hint.innerHTML = PHONE ? "손가락으로 밀어서 둘러보고<br />바닥의 흰 원을 눌러 옮겨 가세요" : "드래그해서 둘러보고<br />바닥의 흰 원을 눌러 옮겨 가세요";
  if (params.get("onboarding") === "0" || tasks.length) hint.classList.add("gone");
  document.body.appendChild(hint);
  function hideHint() { hint.classList.add("gone"); }
  look.addEventListener("interact", () => setTimeout(hideHint, 1500));

  // ---------- loop ----------
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    chrome.update();
    look.update(dt);
    stepFade(dt);
    projectSpots(dt);
    if (current) chrome.setPose(U.eye.value.x, U.eye.value.z, look.yaw);
    renderer.render(scene, camera);
  });
  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  // automation hooks (scripts/app-check.mjs)
  window.pano360 = { nav, look, go: (id) => go(nav.byId.get(id)), get current() { return current; }, get busy() { return busy; }, chrome, runner };
}

// Clearly a placeholder: a grid sphere with the room name and a banner.
// Never a picture of the place (the 360 condition must come from real 360 captures).
function placeholder(room, id) {
  const W = 2048, H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, "#1d2330");
  sky.addColorStop(1, "#4a5361");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H / 2);
  const gr = g.createLinearGradient(0, H / 2, 0, H);
  gr.addColorStop(0, "#4b453d");
  gr.addColorStop(1, "#1c1a17");
  g.fillStyle = gr;
  g.fillRect(0, H / 2, W, H / 2);
  g.strokeStyle = "rgba(255,255,255,.12)";
  g.lineWidth = 2;
  for (let i = 0; i <= 12; i++) { g.beginPath(); g.moveTo((i * W) / 12, 0); g.lineTo((i * W) / 12, H); g.stroke(); }
  for (let j = 1; j < 12; j++) { g.beginPath(); g.moveTo(0, (j * H) / 12); g.lineTo(W, (j * H) / 12); g.stroke(); }
  g.strokeStyle = "rgba(255,210,102,.55)";
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  g.textAlign = "center";
  const dirs = ["앞", "왼쪽", "뒤", "오른쪽"];
  for (let k = 0; k < 4; k++) {
    // u = 0.5 is the image centre ("앞"); +90° to the left is u = 0.25
    const x = (((0.5 - k * 0.25) % 1) + 1) % 1 * W;
    for (const dx of [0, x < 300 ? W : x > W - 300 ? -W : 0]) {
      g.fillStyle = "rgba(255,255,255,.92)";
      g.font = "700 40px Pretendard, system-ui, sans-serif";
      g.fillText(room, x + dx, H / 2 - 56);
      g.fillStyle = "rgba(255,210,102,.95)";
      g.font = "600 20px Pretendard, system-ui, sans-serif";
      g.fillText("개발용 자리표시 · 360 촬영본 준비 중", x + dx, H / 2 - 22);
      g.fillStyle = "rgba(255,255,255,.55)";
      g.font = "500 18px Pretendard, system-ui, sans-serif";
      g.fillText(`${dirs[k]} · 지점 ${id}`, x + dx, H / 2 + 32);
    }
  }
  return c;
}

function pending(listing, nav, backHref) {
  $("#loader").classList.add("done");
  const el = document.createElement("div");
  el.className = "pv-pending";
  el.innerHTML = `
    <a class="vc-btn pv-pending-back" href="${backHref}" aria-label="뒤로">${icon("back")}</a>
    <div class="pv-pending-card">
      <div class="pv-pending-ic">${icon("pano")}</div>
      <div class="pv-pending-eyebrow">${esc(listing.title)} · 360° 시점 탐색</div>
      <h1>${esc(nav.pendingLabel)}</h1>
      <p>실제 360° 카메라로 찍은 원본이 도착하면 이 화면에서 바로 둘러볼 수 있어요.</p>
      <a class="pv-pending-btn" href="${backHref}">숙소로 돌아가기</a>
    </div>`;
  document.body.appendChild(el);
}

main().catch((e) => {
  console.error(e);
  $("#loaderTitle").textContent = "불러오지 못했습니다";
  $("#loaderSub").textContent = e.message;
});
