// 3DGS 자유 시점 탐색 inside the listing app (tour viewer with &app=1&space=<id>).
// Swaps the tour's own tool UI for the chrome shared with the 360° viewer
// (see chrome.js), names places with the same room names (nearest capture
// point of nav.json), keeps walking inside the same exploration range as the
// 360° tour (within range.radius of a capture point), and runs the same tasks.
import * as THREE from "three";
import { loadListing, loadNav, loadTasks, spaceBase } from "./data.js";
import { ViewerChrome, matchLook } from "./chrome.js";
import { TaskRunner } from "./tasks.js";
import { summarizeApp } from "./studylog.js";
import "./viewer.css";

// Before the viewer builds anything: data, names, hide the tour's own UI.
export async function prepare({ params, tour }) {
  const spaceId = params.get("space") || params.get("scene");
  const listing = await loadListing(spaceId).catch(() => null);
  const nav = listing ? await loadNav(spaceId, listing, params.get("navfile")).catch(() => null) : null;
  document.documentElement.classList.add("app-mode");
  if (listing) document.title = `${listing.title} · 3DGS 자유 시점 탐색`;
  // nav.json generated for this scene (scripts/space-from-scene.mjs) knows the
  // floor under each capture point (a 거실 above the courtyard): eyes and walking levels follow it
  if (nav?.scene && nav.scene === (params.get("scene") || "")) {
    for (const n of tour.nodes) {
      const m = nav.byId.get(n.id);
      if (m && Number.isFinite(m.floorY)) { n.floorY = m.floorY; n.position.y = m.floorY + tour.eyeHeight; }
    }
  }
  // markers and labels speak the same room names as the 360° tour
  if (nav) for (const n of tour.nodes) n.name = nav.roomName(nav.nearest(n.position.x, n.position.z).node.room);
  return new AppMode({ params, tour, listing, nav, spaceId });
}

class AppMode {
  constructor(o) { Object.assign(this, o); }

  // Same exploration range as the 360° condition: walkable cells farther than
  // range.radius from every capture point are closed (?range=0 turns this off).
  limitWalk(walkMap) {
    const R = +(this.params.get("range") ?? this.nav?.range?.radius ?? 0);
    if (!walkMap || !this.nav || !(R > 0)) return;
    const pts = this.nav.nodes.map((n) => [n.position[0], n.position[2]]);
    const orig = walkMap.level.bind(walkMap);
    walkMap.level = (fy) => {
      const g = orig(fy);
      if (g.ranged) return g;
      g.ranged = true;
      let closed = 0;
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++) {
          const i = z * g.nx + x;
          if (!g.walk[i]) continue;
          const wx = g.minX + (x + 0.5) * g.v, wz = g.minZ + (z + 0.5) * g.v;
          let ok = false;
          for (const [px, pz] of pts) if ((px - wx) ** 2 + (pz - wz) ** 2 <= R * R) { ok = true; break; }
          if (!ok) { g.walk[i] = 0; closed++; }
        }
      console.info(`[app] exploration range ${R} m around ${pts.length} capture points: closed ${closed} cells`);
      return g;
    };
  }

  // After the viewer is up.
  async start({ nav: navigator3d, look, rig, canvas, tour, ...viewer }) {
    const { params, listing, nav } = this;
    this.nav3 = navigator3d;
    const STUDY = params.has("study");
    const backHref = `/listing.html?id=${encodeURIComponent(this.spaceId)}`;
    this.look = look;
    matchLook(look);
    this.rig = rig;
    const chrome = (this.chrome = new ViewerChrome({
      spaceTitle: listing?.title || tour.title, condition: "splat", backHref: STUDY ? "#" : backHref, nav, look, base: spaceBase(this.spaceId),
      plan: params.get("plan") !== "0" && !!nav,
      onBack: () => (STUDY ? confirm("실험을 그만두고 나갈까요?") : true),
    }));
    if (!nav) chrome.dev("이 공간의 촬영 지점(nav.json)이 없어 방 이름·평면도·탐색 범위를 맞출 수 없어요");

    // study log: the tour's study.js (pose, moves, zoom) + room and task events
    let study = null;
    if (STUDY) {
      for (let i = 0; i < 200 && !window.__study; i++) await new Promise((r) => setTimeout(r, 50));
      study = window.__study || null;
      chrome.onEvent = (e, d) => study?.log(e, d);
    }
    const log = (e, d) => study?.log(e, d);

    // room = that of the nearest capture point
    let lastRoom = null;
    const rooms = () => {
      if (!nav) return;
      const r = nav.nearest(rig.position.x, rig.position.z).node.room;
      this.room = r;
      if (r !== lastRoom) {
        lastRoom = r;
        chrome.setRoom(nav.roomName(r), r);
        log("room", { room: r });
        this.runner?.roomChanged(r);
      }
    };
    rooms();
    this.roomTimer = setInterval(rooms, 250);

    // stand on a capture point, facing where its panorama faces (as the 360° viewer does)
    const jump = async (id) => {
      const n = nav.byId.get(id);
      if (!n) return;
      const p = new THREE.Vector3(...n.position);
      const yaw = ((n.imageYawDeg || 0) * Math.PI) / 180;
      if (navigator3d.moving) navigator3d.stop();
      const tn = tour.nearestNode(p);
      if (tn && Math.hypot(tn.position.x - p.x, tn.position.z - p.z) < 0.3) navigator3d.jumpTo(tn, { yaw, pitch: -0.2 });
      else {
        rig.position.set(p.x, (tn?.floorY ?? 0) + tour.eyeHeight, p.z);
        navigator3d.current = null;
        look.set(yaw, -0.2);
      }
      log("jump", { node: id });
      rooms();
    };
    // same start as the 360° tour
    if (nav && !params.get("node")) await jump(nav.start.id);

    // ≡ menu: the tour's own tools (their code stays in main.js; these just
    // press them). Not in the study, so both conditions show the same screen.
    if (!STUDY) {
      const tool = (act) => document.querySelector(`#tools [data-act="${act}"]`);
      const isOn = (act) => !!tool(act)?.classList.contains("on");
      chrome.setMenu([
        { id: "photos", icon: "photo", label: "원본 사진 보기", run: () => tool("photos")?.click(), on: () => isOn("photos"), hidden: () => !tool("photos") || tool("photos").hidden },
        { id: "cinema", icon: "play", label: "자동 둘러보기", run: () => window.splattour?.toggleCinema(), on: () => !!window.splattour?.cinema?.active, hidden: () => !window.splattour?.cinema },
        { id: "light", icon: "bulb", label: "조명", run: () => tool("light")?.click(), on: () => isOn("light") },
        { id: "music", icon: "sound", label: "소리", run: () => tool("music")?.click(), on: () => isOn("music") },
        { id: "help", icon: "help", label: "도움말 · 조작법", run: () => tool("help")?.click() },
        { id: "fullscreen", icon: "expand", label: "전체 화면", run: () => chrome.fullscreen() },
        { id: "vr", icon: "vr", label: "VR로 보기", run: () => tool("vr")?.click(), hidden: () => !tool("vr") || tool("vr").hidden },
      ]);
    }

    // touch phones walk with a joystick (bottom-left), like W A S D on a keyboard;
    // the plan sits bottom-right in both conditions (same place in the 360° viewer)
    if (matchMedia("(pointer: coarse)").matches && params.get("move") !== "fly" && params.get("joystick") !== "0") {
      const { Joystick } = await import("./joystick.js");
      this.joystick = new Joystick({ log });
    }

    // doors between places: the same data, look, timing and sound as the 360° viewer (../doors.js)
    await this.setupDoors({ ...viewer, tour, log }).catch((e) => console.warn("[doors]", e));

    const tasks = nav && (STUDY || params.get("tasks") === "1") ? await loadTasks(this.spaceId, listing) : [];
    const next = params.get("next");
    if (tasks.length) {
      this.runner = new TaskRunner({
        slot: chrome.taskSlot, tasks, nav, log, look,
        getPose: () => ({ x: rig.position.x, z: rig.position.z, yaw: look.yaw, room: this.room }),
        jumpTo: jump,
        onDone: () => {
          log("end", { summary: summarizeApp(study?.all || []) });
          study?.flush?.(true);
          location.href = next || backHref;
        },
        nextLabel: next ? "다음으로" : "숙소로 돌아가기",
      });
      this.runner.start();
    }
    window.__app = this;
  }

  frame(dt = 1 / 60) {
    if (!this.chrome) return;
    this.chrome.update();
    this.chrome.setPose(this.rig.position.x, this.rig.position.z, this.look.yaw);
    if (this.doorSet) this.updateDoors(dt);
  }

  // ---------- doors (../doors.js) and rooms in other models (./portals.js) ----------
  async setupDoors({ scene, camera, renderer, occ, walkMap, splat, sceneName, loadScene, tour, log }) {
    const { nav, params } = this;
    if (!nav || !scene) return;
    const D = await import("../doors.js");
    const { fx, doors } = D.prepareDoors(nav, spaceBase(this.spaceId));
    if (!doors.length) return;
    const ds = params.get("doorsound");
    const soundOn = ds != null ? ds !== "0" : fx.sound !== false;
    this.D = D;
    this.view = { scene, camera, renderer, occ };
    renderer.localClippingEnabled = true; // sliding leaves are cut at the jambs
    this.samples = new Map();
    this.sampleQueue = new Map();
    this.doorSet = new D.DoorSet({
      doors, fx, parent: scene, log, sound: new D.DoorSound(soundOn),
      // brightness beside the doorway: read after the next render (afterRender)
      sample: (d, side) => { this.sampleQueue.set(d.id, { d, side }); return this.samples.get(d.id) || null; },
      canOpen: (d) => !this.portals || this.portals.ready(d),
    });
    if ([...nav.rooms.values()].some((r) => r.scene && r.scene !== sceneName)) {
      const { Portals } = await import("./portals.js");
      this.portals = new Portals({ nav, doors, primary: { name: sceneName, splat, occ, tour }, loadScene, walkMap, log });
    }
    log("doors", { n: doors.length, ids: doors.map((d) => d.id), sound: soundOn, duration: fx.duration, portals: this.portals?.doors.map((d) => d.id) || [] });
    window.__doors = { set: this.doorSet, portals: this.portals, app: this };
  }

  // metres until the current walking route goes through each door
  routeAhead() {
    const f = this.nav3?.flight;
    if (!f) { this.route = null; return null; }
    if (this.route?.f !== f) {
      const crossings = new Map();
      const N = Math.max(8, Math.ceil(f.length / 0.08));
      let prev = f.curve.getPointAt(0);
      for (let i = 1; i <= N; i++) {
        const p = f.curve.getPointAt(i / N);
        for (const d of this.doorSet.doors) {
          if (crossings.has(d.id)) continue;
          const c = this.D.segmentCrossing(d, prev.x, prev.z, p.x, p.z, 0.35);
          if (c) crossings.set(d.id, (i - 1 + c.u) / N);
        }
        prev = p;
      }
      this.route = { f, crossings };
    }
    const out = new Map();
    for (const [id, u] of this.route.crossings) out.set(id, (u - (f.u ?? 0)) * f.length);
    return out;
  }

  updateDoors(dt) {
    const eye = this.rig.position;
    // walking velocity (keyboard or route), smoothed a little
    // a jump (task start, capture point) is not walking
    if (this.lastEye && Math.hypot(eye.x - this.lastEye.x, eye.z - this.lastEye.z) > 0.5) this.vel = null;
    else if (this.lastEye && dt > 0) {
      const vx = (eye.x - this.lastEye.x) / dt, vz = (eye.z - this.lastEye.z) / dt;
      const k = 1 - Math.exp(-dt * 12);
      this.vel = this.vel ? { x: this.vel.x + (vx - this.vel.x) * k, z: this.vel.z + (vz - this.vel.z) * k } : { x: vx, z: vz };
    }
    this.lastEye = eye.clone();
    const ahead = this.routeAhead();
    this.portals?.update(dt, eye);
    // hold the walk at a door whose other side is still loading
    let hold = false;
    if (this.portals && ahead) for (const d of this.portals.doors) {
      const m = ahead.get(d.id);
      if (m !== undefined && m < 0.8 && m > -0.2 && !this.portals.ready(d)) hold = true;
    }
    if (hold !== !!this.nav3.hold) {
      this.nav3.hold = hold;
      if (hold) this.chrome.toast("문 너머 공간을 불러오는 중…", 2500);
    }
    this.doorSet.update(dt, { eye, camYaw: this.look.yaw, vel: this.vel, ahead, camera: this.view.camera });
  }

  // keyboard walking: no stepping through a door whose other side is not loaded yet
  stepBlocked(px, pz, nx, nz) {
    if (!this.portals) return false;
    for (const d of this.portals.doors) if (!this.portals.ready(d) && this.D.segmentCrossing(d, px, pz, nx, nz, 0.3)) return true;
    return false;
  }

  // Right after the frame is drawn: read a few pixels of the wall beside each
  // door that asked (DoorSet samples twice a second while a door is near).
  afterRender() {
    if (!this.sampleQueue?.size) return;
    const { camera, renderer, occ } = this.view;
    const gl = renderer.getContext();
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const px = new Uint8Array(4);
    const eye = camera.getWorldPosition(new THREE.Vector3());
    for (const { d, side } of this.sampleQueue.values()) {
      const got = [];
      for (const p of this.D.jambPoints(d, side)) {
        const dir = p.clone().sub(eye);
        const dist = dir.length();
        // whatever surface is around the doorway there (a wall, a deep reveal) counts; furniture well in front doesn't
        if (occ && occ.march(eye, dir.normalize(), dist, 0.15) < Math.min(dist - 1, dist * 0.6)) continue;
        const q = p.clone().project(camera);
        if (q.z > 1 || Math.abs(q.x) > 0.97 || Math.abs(q.y) > 0.97) continue;
        const x = Math.round(((q.x + 1) / 2) * size.x), y = Math.round(((q.y + 1) / 2) * size.y);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        got.push([px[0], px[1], px[2]]);
      }
      if (got.length >= 2) this.samples.set(d.id, this.D.summarizeSamples(got));
    }
    this.sampleQueue.clear();
  }
}
