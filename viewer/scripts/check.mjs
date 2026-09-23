// Automated visual check: loads a scene in real Chrome (GPU), screenshots
// the start view, flies to each node, and reports fps + console errors.
// Usage: node scripts/check.mjs <scene> [outDir]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const scene = process.argv[2] || "synthetic-apartment";
const out = path.resolve(process.argv[3] || "../docs/checks/" + scene);
fs.mkdirSync(out, { recursive: true });
const base = process.env.VIEWER_URL || "http://localhost:5190";

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const logs = [];
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

const t0 = Date.now();
await page.goto(`${base}/?scene=${scene}`);
await page.waitForFunction(() => window.splattour, null, { timeout: 180000 });
const loadMs = Date.now() - t0;
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, "00-start.png") });

const info = await page.evaluate(() => {
  const s = window.splattour;
  return {
    gpu: (() => { const gl = s.renderer.getContext(); const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; })(),
    splats: s.splat.packedSplats?.numSplats,
    nodes: s.tour.nodes.map((n) => n.id),
  };
});

const shots = [];
for (const id of info.nodes.slice(1)) {
  await page.evaluate((id) => window.splattour.go(window.splattour.tour.byId.get(id)), id);
  // capture mid-flight and arrival
  await page.waitForTimeout(600);
  const mid = path.join(out, `${String(shots.length + 1).padStart(2, "0")}-${id}-flight.png`);
  await page.screenshot({ path: mid });
  await page.waitForFunction(() => !window.splattour.nav.busy, null, { timeout: 20000 });
  await page.waitForTimeout(700);
  const arr = path.join(out, `${String(shots.length + 1).padStart(2, "0")}-${id}.png`);
  await page.screenshot({ path: arr });
  shots.push(arr);
}
const fps = await page.evaluate(() => window.__fps);

// Hover the floor to show the cursor disc, then click to move there.
await page.mouse.move(640, 600);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, "90-hover.png") });
await page.mouse.click(640, 600);
await page.waitForTimeout(500);
const clickMoved = await page.evaluate(() => window.splattour.nav.busy);

// Baseline panorama mode: enter, cross-fade to a neighbour.
await page.evaluate(() => window.splattour.setMode("pano"));
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(out, "91-pano.png") });
await page.evaluate(() => { const s = window.splattour; const n = s.tour.neighbors(s.nav.current)[0]; s.go(n); });
await page.waitForTimeout(450);
await page.screenshot({ path: path.join(out, "92-pano-fade.png") });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, "93-pano-arrived.png") });
await browser.close();

const report = { scene, loadMs, clickMoved, fps: Math.round(fps * 10) / 10, ...info, errors: logs };
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
