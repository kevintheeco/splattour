// A space in the listing app's 3DGS view on a phone (portrait, landscape) and
// desktop: the start view, the plan with 내 위치, and going into another room
// by double-tapping toward it from a capture point by its door (e.g. 앞마당 n9 -> 안채 거실 n13). Frames ->
// docs/checks/space-<space>/ (+ report.json).
//   node scripts/space-check.mjs [space=wolhajeong] [targetNode=n13] [fromNode=n9]   (VIEWER_URL; LIVE=1 uses the site's paths)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const [space = "wolhajeong", target = "n13", from = "n9"] = process.argv.slice(2);
const base = process.env.VIEWER_URL || "http://localhost:5190";
const live = !!process.env.LIVE;
const out = path.resolve(import.meta.dirname, `../../docs/checks/space-${space}${live ? "-live" : ""}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const report = {};
for (const [tag, w, h, phone] of [["phone-portrait", 390, 844, true], ["phone-landscape", 844, 390, true], ["desktop", 1280, 760, false]]) {
  const ctx = await browser.newContext(phone ? { viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA } : { viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/status of (404|502)/.test(m.text())) errors.push(m.text()); });
  // the listing page's own link into the 3DGS view
  await p.goto(`${base}/listing.html?id=${space}`);
  await p.waitForSelector("#goSplat, a[href*='app=1']", { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const href = await p.evaluate(() => [...document.querySelectorAll("a")].map((a) => a.href).find((u) => u.includes("app=1")) || null);
  report[tag] = { href };
  await p.goto(`${href}&onboarding=0`);
  await p.waitForFunction(() => window.__app?.chrome && window.splattour, null, { timeout: 300000 });
  await p.waitForTimeout(phone ? 9000 : 12000);
  const state = () => p.evaluate(() => { const S = window.splattour, A = window.__app; const r = S.rig.position; return { room: A.chrome.$(".vc-room")?.textContent, x: +r.x.toFixed(2), y: +r.y.toFixed(2), z: +r.z.toFixed(2), yaw: +S.look.yaw.toFixed(2), scene: new URLSearchParams(location.search).get("scene") }; });
  report[tag].start = await state();
  await p.screenshot({ path: path.join(out, `${tag}-1-start.png`) });
  // full plan sheet (내 위치)
  await p.click(".vc-plan");
  await p.waitForTimeout(900);
  await p.screenshot({ path: path.join(out, `${tag}-2-plan.png`) });
  await p.click(".vc-sheet-close").catch(() => {});
  await p.waitForTimeout(600);
  // stand by the door, face the target room and double-tap where it is
  await p.evaluate((id) => { const S = window.splattour; S.nav.jumpTo(S.tour.byId.get(id)); }, from);
  await p.waitForTimeout(2500);
  const pt = await p.evaluate((id) => {
    const S = window.splattour, A = window.__app, n = A.nav.byId.get(id), T = S.THREE;
    const r = S.rig.position;
    S.look.set(Math.atan2(-(n.position[0] - r.x), -(n.position[2] - r.z)), -0.15);
    S.look.update(0); S.camera.updateMatrixWorld(true);
    const v = new T.Vector3(n.position[0], n.position[1] - 1.3, n.position[2]).project(S.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
  }, target);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(out, `${tag}-3-facing.png`) });
  await p.mouse.dblclick(pt.x, pt.y);
  for (let i = 0; i < 16; i++) { await p.waitForTimeout(700); if (!(await p.evaluate(() => window.splattour.nav.busy))) break; }
  await p.waitForTimeout(3500);
  report[tag].after = await state();
  await p.screenshot({ path: path.join(out, `${tag}-4-after-doubletap.png`) });
  report[tag].errors = errors;
  console.log(tag, JSON.stringify(report[tag]));
  await ctx.close();
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
await browser.close();
