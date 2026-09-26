// 월하정: courtyard -> the real 사랑방 door -> 사랑방 (a room captured as its own
// model, placed by nav.json sceneTransform) and back, in the listing app's 3DGS
// view, phone portrait/landscape + desktop. Double-tap the door from the
// courtyard: walk up, it opens, through; then look around inside, the plan
// with 내 위치, and back out. Every frame's pose/heading/room is recorded
// (heading must stay continuous through the door). -> docs/checks/sarang/
//   node scripts/sarang-check.mjs      (VIEWER_URL; LIVE=1 for the live site's paths)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const base = process.env.VIEWER_URL || "http://localhost:5190";
const out = path.resolve(import.meta.dirname, `../../docs/checks/sarang${process.env.LIVE ? "-live" : ""}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const tourPath = process.env.LIVE ? "/tour.html" : "/";
const report = {};
for (const [tag, w, h, phone] of [["phone-portrait", 390, 844, true], ["phone-landscape", 844, 390, true], ["desktop", 1280, 760, false]]) {
  const ctx = await browser.newContext(phone ? { viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA } : { viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/status of (404|502)/.test(m.text())) errors.push(m.text()); });
  const from = process.env.LIVE ? "&from=cloud" : "";
  await p.goto(`${base}${tourPath}?scene=wolhajeong360-hq${from}&app=1&space=wolhajeong&onboarding=0&node=n2`);
  await p.waitForFunction(() => window.__doors?.portals && [...window.__doors.portals.models.values()].every((m) => m.ready) && window.__doors.portals.models.size > 1, null, { timeout: 300000 });
  await p.waitForTimeout(phone ? 8000 : 10000);
  const pose = () => p.evaluate(() => { const S = window.splattour, r = S.rig.position; const it = window.__doors.set.items.find((k) => k.d.id === "d-sarang"); return { t: Math.round(performance.now()), x: +r.x.toFixed(2), y: +r.y.toFixed(2), z: +r.z.toFixed(2), yawDeg: +((S.look.yaw * 180) / Math.PI).toFixed(1), room: document.querySelector(".vc-room")?.textContent, door: +it.p.toFixed(2), fade: !document.getElementById("loader").classList.contains("done") }; });
  let k = 0;
  const shot = async (label) => { const f = `${tag}-${String(k++).padStart(2, "0")}-${label}.png`; await p.screenshot({ path: path.join(out, f) }); return f; };
  // face the door, from the courtyard point next to it
  const pt = await p.evaluate(() => {
    const S = window.splattour, d = window.__doors.set.doors.find((x) => x.id === "d-sarang"), T = S.THREE, r = S.rig.position;
    S.look.set(Math.atan2(-(d.cx - r.x), -(d.cz - r.z)), -0.12); S.look.update(0); S.camera.updateMatrixWorld(true);
    const v = new T.Vector3(d.cx, d.cy + d.height * 0.45, d.cz).project(S.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
  });
  await p.waitForTimeout(2500);
  const seq = [await pose()];
  await shot("courtyard-facing-door");
  const win1 = seq.length;
  await p.mouse.dblclick(pt.x, pt.y);
  const t0 = Date.now();
  let shots = 0;
  while (Date.now() - t0 < 9000) {
    const s = await pose();
    seq.push(s);
    if (shots < 8 && (seq.length % 3 === 0 || s.door > 0.3)) { await shot(s.room === "별채 사랑방" ? "through" : s.door > 0 ? "door-opening" : "walking"); shots++; }
    await p.waitForTimeout(150);
    if (s.room === "별채 사랑방" && !s.fade && Date.now() - t0 > 3000) break;
  }
  await p.waitForTimeout(1500);
  seq.push(await pose());
  const win1end = seq.length;
  await shot("inside");
  // look around inside
  for (const dy of [70, 140]) {
    await p.evaluate((dy) => { const S = window.splattour; S.look.set(S.look.yaw + (dy * Math.PI) / 180, -0.1); }, dy);
    await p.waitForTimeout(1500);
    await shot(`inside-look-${dy}`);
  }
  // plan with 내 위치
  await p.click(".vc-plan");
  await p.waitForTimeout(900);
  await shot("plan");
  await p.click(".vc-sheet-close").catch(() => {});
  await p.waitForTimeout(500);
  // back out: face the door again and double-tap it
  const pt2 = await p.evaluate(() => {
    const S = window.splattour, d = window.__doors.set.doors.find((x) => x.id === "d-sarang"), T = S.THREE, r = S.rig.position;
    S.look.set(Math.atan2(-(d.cx - r.x), -(d.cz - r.z)), -0.12); S.look.update(0); S.camera.updateMatrixWorld(true);
    const v = new T.Vector3(d.cx, d.cy + d.height * 0.45, d.cz).project(S.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
  });
  await p.waitForTimeout(1200);
  await shot("inside-facing-door");
  const win2 = seq.length;
  await p.mouse.dblclick(pt2.x, pt2.y);
  const t1 = Date.now();
  while (Date.now() - t1 < 9000) { const s = await pose(); seq.push(s); await p.waitForTimeout(150); if (s.room === "앞마당" && !s.fade && Date.now() - t1 > 3000) break; }
  await p.waitForTimeout(1500);
  seq.push(await pose());
  await shot("back-in-courtyard");
  // heading continuity through each transit (tap -> walk -> door -> through -> turn in): peak turn rate, deg/s
  let maxTurn = 0;
  for (const [a, e] of [[win1, win1end], [win2, seq.length]])
    for (let i = a + 1; i < e; i++) { let d = Math.abs(seq[i].yawDeg - seq[i - 1].yawDeg) % 360; if (d > 180) d = 360 - d; const dt = Math.max(0.05, (seq[i].t - seq[i - 1].t) / 1000); maxTurn = Math.max(maxTurn, +(d / dt).toFixed(0)); }
  // position jump at the fade (m) vs the door's depth: should be the 2.15 m straight through, same heading
  const jumps = [];
  for (let i = 1; i < seq.length; i++) { const dj = Math.hypot(seq[i].x - seq[i - 1].x, seq[i].z - seq[i - 1].z); if (dj > 0.6) jumps.push({ m: +dj.toFixed(2), yawBefore: seq[i - 1].yawDeg, yawAfter: seq[i].yawDeg, from: seq[i - 1].room, to: seq[i].room }); }
  const rooms = [...new Set(seq.map((s) => s.room))];
  const events = await p.evaluate(() => (window.__study?.all || []).filter((e) => /door/.test(e.e)));
  report[tag] = { rooms, peakTurnDegPerSec: maxTurn, jumps, inside: seq.find((s) => s.room === "별채 사랑방"), end: seq.at(-1), seq, errors };
  console.log(tag, JSON.stringify({ rooms, peakTurnDegPerSec: maxTurn, jumps, inside: report[tag].inside, end: report[tag].end, errors: errors.length }));
  await ctx.close();
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
await browser.close();
