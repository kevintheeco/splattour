// UX regression check for look & approach interactions, in real Chrome (GPU).
//   node scripts/ux-check.mjs <scene> [node]
// 1) zoom-to-cursor: the world direction under the cursor must stay under it
// 2) double-click "다가가 보기": camera ends closer to the surface, facing it
// Screenshots go to ../docs/checks/ux-<scene>/.
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const [scene = "drjohnson", nodeId = "n0"] = process.argv.slice(2);
const out = path.resolve("../docs/checks/ux-" + scene);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://localhost:5190/?scene=${scene}`);
await page.waitForFunction(() => window.splattour, null, { timeout: 180000 });
await page.evaluate((n) => { const S = window.splattour; S.nav.jumpTo(S.tour.byId.get(n)); document.querySelector("#hint")?.classList.add("gone"); }, nodeId);
await page.waitForTimeout(1200);
const shot = (n) => page.screenshot({ path: path.join(out, n) });
const rep = { scene, node: nodeId };

// --- 1. zoom to cursor ---------------------------------------------------
const cx = 1000, cy = 250; // well off-centre (upper right)
const dirAt = () => page.evaluate(([x, y]) => {
  const S = window.splattour, THREE = S.THREE;
  const c = S.renderer.domElement, r = c.getBoundingClientRect();
  const ndc = { x: ((x - r.left) / r.width) * 2 - 1, y: -((y - r.top) / r.height) * 2 + 1 };
  S.camera.updateMatrixWorld(true);
  const v = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(S.camera).sub(S.camera.getWorldPosition(new THREE.Vector3())).normalize();
  return [v.x, v.y, v.z, S.look.fov];
}, [cx, cy]);
await shot("zoom-0.png");
const before = await dirAt();
await page.mouse.move(cx, cy);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
await page.waitForTimeout(900);
const after = await dirAt();
const drift = Math.acos(Math.min(1, before[0] * after[0] + before[1] * after[1] + before[2] * after[2])) * 180 / Math.PI;
rep.zoom = { fovBefore: +before[3].toFixed(1), fovAfter: +after[3].toFixed(1), anchorDriftDeg: +drift.toFixed(2) };
await shot("zoom-1.png");

// reset view
await page.evaluate((n) => { const S = window.splattour; S.look.setFov(70); S.nav.jumpTo(S.tour.byId.get(n)); }, nodeId);
await page.waitForTimeout(800);

// --- 2. double-click approach ---------------------------------------------
const px = 640, py = 330;
const cam0 = await page.evaluate(() => window.splattour.rig.position.toArray());
const dist0 = await page.evaluate(([x, y]) => {
  const S = window.splattour, THREE = S.THREE;
  const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2((x / 1280) * 2 - 1, -(y / 760) * 2 + 1), S.camera);
  return S.occ.march(rc.ray.origin, rc.ray.direction, 12, 0.15);
}, [px, py]);
await shot("approach-0.png");
await page.mouse.dblclick(px, py);
await page.waitForTimeout(400);
await shot("approach-mid.png");
await page.waitForFunction(() => !window.splattour.nav.busy, null, { timeout: 10000 });
await page.waitForTimeout(700);
await shot("approach-1.png");
const cam1 = await page.evaluate(() => window.splattour.rig.position.toArray());
const moved = Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]);
// after arriving, the surface point should be near the screen centre
const centreDist = await page.evaluate(() => {
  const S = window.splattour, THREE = S.THREE;
  const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(0, 0), S.camera);
  return S.occ.march(rc.ray.origin, rc.ray.direction, 12, 0.15);
});
rep.approach = { surfaceDistBefore: +dist0.toFixed(2), moved: +moved.toFixed(2), surfaceDistAfterAtCentre: +centreDist.toFixed(2) };
rep.errors = errors;
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(rep, null, 2));
console.log(JSON.stringify(rep));
await browser.close();
