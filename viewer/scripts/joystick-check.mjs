// Touch-phone joystick check (3DGS condition), portrait 390x844 and landscape
// 844x390: the stick shows bottom-left, the plan bottom-right in BOTH
// conditions (same place in the 360° viewer), pushing the knob up walks
// forward, sideways steps sideways, letting go stops; walls still stop you;
// the study log gets joystick start/end. Frames -> docs/checks/joystick/.
//   node scripts/joystick-check.mjs [space=drjohnson]     (VIEWER_URL)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const [space = "drjohnson"] = process.argv.slice(2);
const base = process.env.VIEWER_URL || "http://localhost:5190";
const out = path.resolve(import.meta.dirname, "../../docs/checks/joystick");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const report = {};
const scene = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../public/spaces/${space}/listing.json`), "utf8")).explore?.scene || space;

for (const [w, h] of [[390, 844], [844, 390]]) {
  const tag = w < h ? "portrait" : "landscape";
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("dialog", (d) => d.accept());
  await p.goto(`${base}/?scene=${encodeURIComponent(scene)}&app=1&space=${space}&study=CHK-joy&badge=0&onboarding=0`);
  await p.waitForFunction(() => window.__app?.joystick && window.splattour, null, { timeout: 240000 });
  await p.waitForTimeout(6000);
  let k = 0;
  const shot = async (label) => { const f = `${tag}-${String(k++).padStart(2, "0")}-${label}.png`; await p.screenshot({ path: path.join(out, f) }); return f; };
  const rect = await p.evaluate(() => { const r = document.querySelector(".vc-joy").getBoundingClientRect(); const pl = document.querySelector(".vc-plan").getBoundingClientRect(); return { joy: [r.left, r.top, r.width, r.height], plan: [pl.left, pl.top, pl.width, pl.height] }; });
  await shot("start");
  const cx = rect.joy[0] + rect.joy[2] / 2, cy = rect.joy[1] + rect.joy[3] / 2;
  const pos = () => p.evaluate(() => { const r = window.splattour.rig.position; return { x: +r.x.toFixed(3), z: +r.z.toFixed(3), y: +r.y.toFixed(3), yaw: +window.splattour.look.yaw.toFixed(3) }; });
  const push = async (dx, dy, ms, label) => {
    const a = await pos();
    await p.mouse.move(cx, cy);
    await p.mouse.down();
    await p.mouse.move(cx + dx, cy + dy, { steps: 6 });
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { await p.waitForTimeout(400); await shot(label); }
    await p.mouse.up();
    await p.waitForTimeout(1200);
    const b = await pos();
    const fwd = [-Math.sin(a.yaw), -Math.cos(a.yaw)], right = [Math.cos(a.yaw), -Math.sin(a.yaw)];
    const d = [b.x - a.x, b.z - a.z];
    return { from: a, to: b, forward: +(d[0] * fwd[0] + d[1] * fwd[1]).toFixed(2), right: +(d[0] * right[0] + d[1] * right[1]).toFixed(2), yawChange: +(b.yaw - a.yaw).toFixed(3) };
  };
  const up = await push(0, -40, 2400, "forward");
  const side = await push(40, 0, 1600, "right");
  const half = await push(0, -18, 1600, "slow");
  await shot("stopped");
  // look-around drag elsewhere must not walk
  const a = await pos();
  await p.mouse.move(w * 0.7, h * 0.4); await p.mouse.down(); await p.mouse.move(w * 0.5, h * 0.4, { steps: 8 }); await p.mouse.up();
  await p.waitForTimeout(800);
  const b = await pos();
  const events = await p.evaluate(() => (window.__study?.all || []).filter((e) => e.e === "joystick"));
  report[tag] = { rects: rect, forward: up, right: side, slowPush: half, lookDrag: { moved: +Math.hypot(b.x - a.x, b.z - a.z).toFixed(3), yawChange: +(b.yaw - a.yaw).toFixed(3) }, events, errors };
  // the same chrome in the 360° viewer: plan in the same place, no joystick
  const p2 = await ctx.newPage();
  await p2.goto(`${base}/pano.html?space=${space}&dev=1&onboarding=0`);
  await p2.waitForFunction(() => window.pano360?.current, null, { timeout: 120000 });
  await p2.waitForTimeout(1500);
  report[tag].pano = await p2.evaluate(() => { const pl = document.querySelector(".vc-plan").getBoundingClientRect(); return { plan: [pl.left, pl.top, pl.width, pl.height], joystick: !!document.querySelector(".vc-joy") }; });
  await p2.screenshot({ path: path.join(out, `${tag}-pano-same-plan.png`) });
  console.log(tag, JSON.stringify({ forward: up.forward, right: side.right, slow: half.forward, look: report[tag].lookDrag, events: events.map((e) => e.phase + (e.meters != null ? `:${e.meters}m` : "")), plan3dgs: rect.plan.map(Math.round), plan360: report[tag].pano.plan.map(Math.round), joyIn360: report[tag].pano.joystick, errors: errors.length }));
  await ctx.close();
}
fs.writeFileSync(path.join(out, "joystick-report.json"), JSON.stringify(report, null, 1));
await browser.close();
