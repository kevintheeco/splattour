// Walking navigation check in real Chrome (GPU): eye height stays at standing
// height, pace is a walk, double-click reaches floor spots and stops in front
// of objects, routes never cross furniture, W A S D slides along walls.
//   node scripts/walk-check.mjs <scene> [node]     (vite on :5190)
// Screenshots and walk-report.json go to ../docs/checks/walk-<scene>/.
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const [scene = "drjohnson", nodeId = "n0"] = process.argv.slice(2);
const out = path.resolve("../docs/checks/walk-" + scene);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const W = 1280, H = 760;
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.text().startsWith("[walk]")) console.log(m.text()); });
await page.goto(`http://localhost:5190/?scene=${scene}&onboarding=0${process.env.EXTRA || ""}`); // EXTRA: e.g. "&quality=lod"
await page.waitForFunction(() => window.splattour, null, { timeout: 180000 });
const shot = (n) => page.screenshot({ path: path.join(out, n) });
const rep = { scene, node: nodeId };

// Per-frame recorder: eye height above floor, horizontal speed, walkable or not.
await page.evaluate(() => {
  const S = window.splattour;
  window.__rec = null;
  let last = null;
  const tick = (t) => {
    if (window.__rec) {
      const p = S.rig.position;
      const fy = S.tour.nearestNode(p).floorY;
      const sp = last ? Math.hypot(p.x - last.x, p.z - last.z) / Math.max(1e-3, (t - last.t) / 1000) : 0;
      window.__rec.push({ t, eye: p.y - fy, sp, x: p.x, z: p.z, pitch: S.look.pitch, yaw: S.look.yaw });
      last = { x: p.x, z: p.z, t };
    } else last = null;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const startRec = () => page.evaluate(() => { window.__rec = []; });
const stopRec = () => page.evaluate(() => { const r = window.__rec; window.__rec = null; return r; });
const summarize = (r) => {
  const moving = r.filter((f) => f.sp > 0.05);
  const sp = moving.map((f) => f.sp).sort((a, b) => a - b);
  const eyes = r.map((f) => f.eye);
  return {
    frames: r.length,
    seconds: r.length ? +((r[r.length - 1].t - r[0].t) / 1000).toFixed(2) : 0,
    medianSpeed: sp.length ? +sp[Math.floor(sp.length / 2)].toFixed(2) : 0,
    p95Speed: sp.length ? +sp[Math.floor(sp.length * 0.95)].toFixed(2) : 0,
    eyeMin: +Math.min(...eyes).toFixed(3),
    eyeMax: +Math.max(...eyes).toFixed(3),
    // how abrupt it feels: peak turn rates (deg/s) and acceleration (m/s²), over ~0.1 s windows
    ...(() => {
      let yawR = 0, pitchR = 0, acc = 0;
      for (let i = 6; i < r.length; i++) {
        const a = r[i - 6], b = r[i], dt = (b.t - a.t) / 1000;
        if (dt <= 0) continue;
        yawR = Math.max(yawR, Math.abs(Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw))) / dt);
        pitchR = Math.max(pitchR, Math.abs(b.pitch - a.pitch) / dt);
        acc = Math.max(acc, Math.abs(b.sp - a.sp) / dt);
      }
      return { peakTurnDeg: +(yawR * 57.3).toFixed(0), peakPitchDeg: +(pitchR * 57.3).toFixed(0), peakAccel: +acc.toFixed(2) };
    })(),
  };
};
const reset = () => page.evaluate((n) => { const S = window.splattour; S.look.setFov(70); S.nav.jumpTo(S.tour.byId.get(n)); }, nodeId);
await reset();
await page.waitForTimeout(1500);
rep.eyeHeight = await page.evaluate(() => window.splattour.tour.eyeHeight);

// --- 1. route coverage between neighbouring viewpoints ---------------------
rep.routes = await page.evaluate(() => {
  const S = window.splattour;
  let ok = 0, n = 0, straight = 0, ratio = [];
  for (const a of S.tour.nodes)
    for (const b of S.tour.neighbors(a)) {
      if (a.index > b.index) continue;
      n++;
      const r = S.nav.planner(a.position, b.position);
      if (!r) continue;
      ok++;
      if (r.length === 2) straight++;
      let L = 0;
      for (let i = 1; i < r.length; i++) L += Math.hypot(r[i].x - r[i - 1].x, r[i].z - r[i - 1].z);
      ratio.push(L / Math.max(0.01, Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)));
    }
  ratio.sort((x, y) => x - y);
  return { pairs: n, walkable: ok, straight, detourMedian: +(ratio[Math.floor(ratio.length / 2)] ?? 0).toFixed(2), detourMax: +(ratio[ratio.length - 1] ?? 0).toFixed(2) };
});
console.log("routes", rep.routes);

// --- 2. double-click the floor ahead ---------------------------------------
await shot("floor-0.png");
const floorTarget = await page.evaluate(([x, y, W, H]) => {
  const S = window.splattour, THREE = S.THREE;
  const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), S.camera);
  const fy = S.tour.nearestNode(S.rig.position).floorY;
  const hit = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -fy), new THREE.Vector3());
  return hit ? [hit.x, hit.z, hit.distanceTo(rc.ray.origin)] : null;
}, [W / 2, H * 0.68, W, H]);
await startRec();
await page.mouse.dblclick(W / 2, H * 0.68);
await page.waitForTimeout(700);
await shot("floor-mid.png");
await page.waitForFunction(() => !window.splattour.nav.moving, null, { timeout: 20000 });
await page.waitForTimeout(300);
let r = await stopRec();
const endF = await page.evaluate(() => window.splattour.rig.position.toArray());
rep.floorClick = { ...summarize(r), target: floorTarget, endErr: floorTarget ? +Math.hypot(endF[0] - floorTarget[0], endF[2] - floorTarget[1]).toFixed(2) : null };
await shot("floor-1.png");
console.log("floor", rep.floorClick);

// --- 3. double-click an object / wall at eye level ---------------------------
await reset();
await page.waitForTimeout(800);
const objs = [[W * 0.5, H * 0.45], [W * 0.3, H * 0.4], [W * 0.72, H * 0.42]];
rep.objectClicks = [];
for (const [ox, oy] of objs) {
  await reset();
  await page.waitForTimeout(600);
  const surf = await page.evaluate(([x, y, W, H]) => {
    const S = window.splattour, THREE = S.THREE;
    const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), S.camera);
    const d = S.occ.march(rc.ray.origin, rc.ray.direction, 25, 0.15);
    return rc.ray.origin.clone().addScaledVector(rc.ray.direction, d).toArray().concat([d]);
  }, [ox, oy, W, H]);
  await startRec();
  await page.mouse.dblclick(ox, oy);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !window.splattour.nav.moving, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  r = await stopRec();
  const end = await page.evaluate(() => window.splattour.rig.position.toArray());
  const rec = { click: [ox, oy], surfaceDist0: +surf[3].toFixed(2), ...summarize(r), standoff: +Math.hypot(end[0] - surf[0], end[2] - surf[2]).toFixed(2) };
  rep.objectClicks.push(rec);
  await shot(`object-${rep.objectClicks.length}.png`);
  console.log("object", rec);
}

// --- 4. W for 2 s, then into the nearest wall -------------------------------
await reset();
await page.waitForTimeout(800);
await page.mouse.move(W / 2, H / 2);
await startRec();
await page.keyboard.down("w");
await page.waitForTimeout(2000);
await page.keyboard.up("w");
await page.waitForTimeout(600);
r = await stopRec();
rep.keyW = summarize(r);
await shot("key-w.png");
console.log("W 2s", rep.keyW);

await reset();
await page.waitForTimeout(600);
// face the closest wall, then keep walking into it for 4 s
await page.evaluate(() => {
  const S = window.splattour, THREE = S.THREE;
  let best = 0, bd = 1e9;
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const d = S.occ.march(S.rig.position, new THREE.Vector3(-Math.sin(a), -0.2, -Math.cos(a)).normalize(), 12, 0.15);
    if (d < bd) { bd = d; best = a; }
  }
  S.look.set(best, 0);
});
await page.waitForTimeout(300);
await startRec();
await page.keyboard.down("w");
await page.waitForTimeout(4000);
await shot("key-wall.png");
await page.keyboard.up("w");
await page.waitForTimeout(500);
r = await stopRec();
const wallProbe = await page.evaluate(() => {
  const S = window.splattour, THREE = S.THREE;
  // nearest occupied voxel in the body band around the final position
  const p = S.rig.position, fy = S.tour.nearestNode(p).floorY;
  let min = 9;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    for (const h of [0.5, 1.0, 1.5]) {
      const o = new THREE.Vector3(p.x, fy + h, p.z);
      min = Math.min(min, S.occ.march(o, new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a)), 3, 0));
    }
  }
  return +min.toFixed(2);
});
rep.keyWall = { ...summarize(r), clearanceToGeometry: wallProbe };
console.log("into wall", rep.keyWall);

rep.errors = errors;
fs.writeFileSync(path.join(out, "walk-report.json"), JSON.stringify(rep, null, 2));
console.log(errors.length ? "ERRORS " + errors.join(" | ") : "no page errors");
await browser.close();
