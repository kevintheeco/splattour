// Camera steadiness during flights (the "시점이 흔들림" complaint), measured
// deterministically: the render loop is paused and nav/look are stepped at
// 60 Hz by hand, recording the camera's heading, pitch, field of view and height.
//   node scripts/motion-check.mjs [scene=drjohnson]
// Metrics per flight: heading reversals (turning left then right then left…),
// peak angular acceleration, fov swing, height change. Lower is steadier.
import { chromium } from "playwright-core";

const scene = process.argv[2] || "drjohnson";
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto(`http://localhost:5190/?scene=${scene}&onboarding=0`);
await p.waitForFunction(() => window.splattour, null, { timeout: 240000 });
const out = await p.evaluate(() => {
  const S = window.splattour, { THREE, nav, look, rig, tour, camera } = S;
  S.renderer.setAnimationLoop(null);
  const N = tour.nodes;
  // neighbours, two hops, and a long route across the house
  const pairs = [[0, 1], [1, 2], [3, 4], [5, 6], [0, 3], [2, 7], [0, Math.min(10, N.length - 1)], [4, N.length - 1]];
  const e = new THREE.Euler(), q = new THREE.Quaternion(), dt = 1 / 60;
  const res = [];
  for (const [a, z] of pairs) {
    nav.jumpTo(N[a]);
    look.update(dt);
    if (!nav.goTo(N[z])) continue;
    const yaw = [], pitch = [], fov = [], y = [];
    for (let f = 0; f < 60 * 10 && nav.moving; f++) {
      nav.update(dt); look.update(dt);
      camera.getWorldQuaternion(q); e.setFromQuaternion(q, "YXZ");
      yaw.push(e.y); pitch.push(e.x); fov.push(camera.fov); y.push(rig.position.y);
    }
    const unwrap = (arr) => { const o = [arr[0]]; for (let i = 1; i < arr.length; i++) { let d = arr[i] - arr[i - 1]; d = Math.atan2(Math.sin(d), Math.cos(d)); o.push(o[i - 1] + d); } return o; };
    const Y = unwrap(yaw), deg = 180 / Math.PI;
    const vel = Y.slice(1).map((v, i) => (v - Y[i]) / dt * deg);
    const acc = vel.slice(1).map((v, i) => (v - vel[i]) / dt);
    let rev = 0, sgn = 0;
    for (const v of vel) { if (Math.abs(v) < 4) continue; const s = Math.sign(v); if (sgn && s !== sgn) rev++; sgn = s; }
    const pv = pitch.slice(1).map((v, i) => Math.abs(v - pitch[i]) / dt * deg);
    res.push({
      route: `${N[a].id}→${N[z].id}`, hops: tour.path(N[a], N[z])?.length - 1, sec: +(yaw.length * dt).toFixed(2),
      turnDeg: +((Y.at(-1) - Y[0]) * deg).toFixed(0), yawReversals: rev,
      peakYawRate: +Math.max(...vel.map(Math.abs)).toFixed(0), peakYawAccel: +Math.max(...acc.map(Math.abs)).toFixed(0),
      peakPitchRate: +Math.max(...pv).toFixed(0), fovSwing: +(Math.max(...fov) - Math.min(...fov)).toFixed(1),
      heightSwing: +(Math.max(...y) - Math.min(...y)).toFixed(3),
    });
  }
  return res;
});
console.table(out);
const avg = (k) => +(out.reduce((s, r) => s + r[k], 0) / out.length).toFixed(1);
console.log(JSON.stringify({ yawReversals: avg("yawReversals"), peakYawAccel: avg("peakYawAccel"), peakYawRate: avg("peakYawRate"), peakPitchRate: avg("peakPitchRate"), fovSwing: avg("fovSwing") }));
await b.close();
