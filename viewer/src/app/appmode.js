// 3DGS 자유 시점 탐색 inside the listing app (tour viewer with &app=1&space=<id>).
// Swaps the tour's own tool UI for the chrome shared with the 360° viewer
// (see chrome.js), names places with the same room names (nearest capture
// point of nav.json), keeps walking inside the same exploration range as the
// 360° tour (within range.radius of a capture point), and runs the same tasks.
import * as THREE from "three";
import { loadListing, loadNav, loadTasks } from "./data.js";
import { ViewerChrome, matchLook } from "./chrome.js";
import { TaskRunner } from "./tasks.js";
import { summarizeApp } from "./studylog.js";
import "./viewer.css";

// Before the viewer builds anything: data, names, hide the tour's own UI.
export async function prepare({ params, tour }) {
  const spaceId = params.get("space") || params.get("scene");
  const listing = await loadListing(spaceId).catch(() => null);
  const nav = listing ? await loadNav(spaceId, listing).catch(() => null) : null;
  document.documentElement.classList.add("app-mode");
  if (listing) document.title = `${listing.title} · 3DGS 자유 시점 탐색`;
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
  async start({ nav: navigator3d, look, rig, canvas, tour }) {
    const { params, listing, nav } = this;
    const STUDY = params.has("study");
    const backHref = `/listing.html?id=${encodeURIComponent(this.spaceId)}`;
    this.look = look;
    matchLook(look);
    this.rig = rig;
    const chrome = (this.chrome = new ViewerChrome({
      spaceTitle: listing?.title || tour.title, condition: "splat", backHref: STUDY ? "#" : backHref, nav, look,
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
        chrome.setRoom(nav.roomName(r));
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

    const tasks = nav && (STUDY || params.get("tasks") === "1") ? await loadTasks(this.spaceId, listing) : [];
    const next = params.get("next");
    if (tasks.length) {
      this.runner = new TaskRunner({
        slot: chrome.taskSlot, tasks, nav, log,
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

  frame() {
    if (!this.chrome) return;
    this.chrome.update();
    this.chrome.setPose(this.rig.position.x, this.rig.position.z, this.look.yaw);
  }
}
