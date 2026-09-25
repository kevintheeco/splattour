// Door-opening check ("문 여는 연출") in both study conditions, on an emulated
// phone, portrait 390x844 and landscape 844x390: stand before a door (closed),
// move through it (opening -> open -> passed), look back (closing / closed).
// Frames of every run go to docs/checks/doors/<case>-<orientation>/, the key
// frames to docs/checks/doors/, plus doors-report.json (door events from the
// study log, measured opening time, console errors).
//   node scripts/doors-check.mjs [case ...]     (VIEWER_URL, default http://localhost:5190)
// cases: dj-splat dj-pano wh-splat wh-pano portal
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const base = process.env.VIEWER_URL || "http://localhost:5190";
const out = path.resolve(import.meta.dirname, "../../docs/checks/doors");
fs.mkdirSync(out, { recursive: true });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// from: where to stand (x, z) or a capture point; to: capture point to go to; door: which door to face
// back: step back this far from `from`, away from the door (a wider first view), when it is walkable
// via: capture points to hop to first (no door on the way), then `to` through the door
const CASES = {
  "dj-splat": { cond: "splat", url: "/?scene=drjohnson&app=1&space=drjohnson", from: "n3", to: "n11", door: "d-dining" },
  "dj-pano": { cond: "pano", url: "/pano.html?space=drjohnson&dev=1", from: "n3", via: ["n9"], to: "n8", door: "d-dining" },
  "wh-splat": { cond: "splat", url: "/?scene=wolhajeong&app=1&space=wolhajeong", from: "n4", to: "n0", door: "d-gate" },
  "wh-pano": { cond: "pano", url: "/pano.html?space=wolhajeong&dev=1", from: "n8", via: ["n4"], to: "n0", door: "d-gate" },
  "portal": { cond: "splat", url: "/?scene=drjohnson-split-parlour&app=1&space=drjohnson&navfile=nav.split-test.json", from: "n10", to: "n11", door: "d-dining", portal: true },
};
const pick = process.argv.slice(2);
const run = pick.length ? pick : Object.keys(CASES);

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const report = {};

async function one(name, c, w, h) {
  const orient = w < h ? "portrait" : "landscape";
  const tag = `${name}-${orient}`;
  const dir = path.join(out, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA });
  const p = await ctx.newPage();
  const rep = { errors: [], frames: [] };
  p.on("pageerror", (e) => rep.errors.push(e.message));
  // (a missing favicon and the study upload to a studio that isn't running are not errors here)
  p.on("console", (m) => { if (m.type() === "error" && !/status of (404|502)/.test(m.text())) rep.errors.push(m.text()); if (/\[portals\]|\[doors\]/.test(m.text())) console.log(`  ${tag}: ${m.text()}`); });
  p.on("dialog", (d) => d.accept());
  // landscape runs go through the study log (tasks on screen), portrait runs are clean views
  const withStudy = orient === "landscape";
  const q = `${withStudy ? "&study=CHK-doors&badge=0" : ""}&onboarding=0&node=${c.from}`;
  await p.goto(base + c.url + q);
  if (c.cond === "splat") await p.waitForFunction(() => window.__doors?.set && window.splattour, null, { timeout: 240000 });
  else await p.waitForFunction(() => window.pano360?.doors && window.pano360.current, null, { timeout: 120000 });
  // mirror door events (the study log has them too when it is on)
  await p.evaluate(() => {
    const set = window.__doors?.set || window.pano360.doors;
    const orig = set.log;
    window.__doorEvents = [];
    set.log = (e, d) => { window.__doorEvents.push({ e, t: Math.round(performance.now()), ...d }); orig(e, d); };
  });
  if (withStudy) {
    // the first task moves to its start point: wait for it, then fold the task card
    await p.waitForTimeout(2500);
    await p.mouse.move(w * 0.6, h * 0.55); await p.mouse.down(); await p.mouse.move(w * 0.5, h * 0.55, { steps: 6 }); await p.mouse.up();
  }
  // a key press unlocks audio (the creak) like a real first touch (a tap would also move)
  await p.keyboard.press("Shift");
  await p.waitForTimeout(600);

  // stand at the start point, facing the door
  await p.evaluate(async ({ c }) => {
    const face = (x, z, d) => Math.atan2(-(d.cx - x), -(d.cz - z));
    if (c.cond === "splat") {
      const S = window.splattour, D = window.__doors;
      const d = D.set.doors.find((k) => k.id === c.door);
      const n = S.tour.byId.get(c.from);
      S.nav.jumpTo(n, { yaw: face(n.position.x, n.position.z, d), pitch: -0.06 });
      if (c.back) {
        const x = n.position.x - d.n[0] * c.back, z = n.position.z - d.n[1] * c.back;
        const wm = window.__doors.app.view && window.splattour; // walkable check through the occupancy grid
        if (!S.occ.occupied(new S.THREE.Vector3(x, 1.0, z))) { S.nav.current = null; S.rig.position.set(x, n.position.y, z); S.look.set(face(x, z, d), -0.06); }
      }
    } else {
      const P = window.pano360;
      const d = P.doors.doors.find((k) => k.id === c.door);
      const n = P.nav.byId.get(c.from);
      await P.place(c.from, face(n.position[0], n.position[2], d));
      P.look.set(face(n.position[0], n.position[2], d), -0.06);
    }
  }, { c });
  // let the streamed view sharpen and the door match its brightness
  await p.waitForTimeout(c.cond === "splat" ? 7000 : 2500);
  const state = () => p.evaluate(({ c }) => {
    const set = c.cond === "splat" ? window.__doors.set : window.pano360.doors;
    const it = set.items.find((k) => k.d.id === c.door);
    const eye = c.cond === "splat" ? window.splattour.rig.position : window.pano360.U.eye.value;
    const busy = c.cond === "splat" ? window.splattour.nav.busy : window.pano360.busy;
    const portals = window.__doors?.portals;
    return { t: performance.now(), p: +it.p.toFixed(3), light: +it.light.toFixed(3), eye: [eye.x, eye.z].map((v) => +v.toFixed(2)), busy, models: portals ? [...portals.models.values()].map((m) => `${m.name}:${m.ready ? "ready" : "loading"}:${m.splat ? m.splat.opacity.toFixed(2) : "-"}`) : undefined };
  }, { c });
  const shot = async (file) => { await p.screenshot({ path: file }); };
  let k = 0;
  const frame = async (label = "") => {
    const s = await state();
    const f = path.join(dir, `${String(k++).padStart(2, "0")}${label ? "-" + label : ""}.png`);
    await shot(f);
    rep.frames.push({ file: path.basename(f), ...s });
    return s;
  };
  const closed = await frame("closed");
  fs.copyFileSync(path.join(dir, rep.frames[0].file), path.join(out, `${tag}-1-closed.png`));
  if (c.portal) rep.modelsBefore = closed.models;

  // hop closer first (360°), still facing the door
  for (const v of c.via || []) {
    await p.evaluate(async ({ c, v }) => {
      const P = window.pano360;
      await P.go(v);
      const d = P.doors.doors.find((k) => k.id === c.door), n = P.current;
      P.look.set(Math.atan2(-(d.cx - n.position[0]), -(d.cz - n.position[2])), -0.06);
    }, { c, v });
    await p.waitForTimeout(1200);
    await frame(`at-${v}`);
  }
  // go through
  await p.evaluate(({ c }) => {
    if (c.cond === "splat") { const S = window.splattour; S.go(S.tour.byId.get(c.to)); }
    else window.pano360.go(c.to);
  }, { c });
  const t0 = Date.now();
  let opening = null, open = null;
  for (;;) {
    const s = await frame();
    if (!opening && s.p > 0.2 && s.p < 0.8) { opening = rep.frames.at(-1).file; }
    if (!open && s.p >= 0.999) open = rep.frames.at(-1).file;
    if (!s.busy && Date.now() - t0 > 1500) break;
    if (Date.now() - t0 > 20000) break;
  }
  if (opening) fs.copyFileSync(path.join(dir, opening), path.join(out, `${tag}-2-opening.png`));
  if (open) fs.copyFileSync(path.join(dir, open), path.join(out, `${tag}-3-open.png`));
  // passed: turn around and watch it close behind
  await p.evaluate(({ c }) => {
    const face = (x, z, d) => Math.atan2(-(d.cx - x), -(d.cz - z));
    const set = c.cond === "splat" ? window.__doors.set : window.pano360.doors;
    const d = set.doors.find((k) => k.id === c.door);
    const eye = c.cond === "splat" ? window.splattour.rig.position : window.pano360.U.eye.value;
    (c.cond === "splat" ? window.splattour.look : window.pano360.look).set(face(eye.x, eye.z, d), -0.06);
  }, { c });
  await p.waitForTimeout(250);
  await frame("lookback");
  fs.copyFileSync(path.join(dir, rep.frames.at(-1).file), path.join(out, `${tag}-4-passed.png`));
  await p.waitForTimeout(2200);
  await frame("closed-behind");
  fs.copyFileSync(path.join(dir, rep.frames.at(-1).file), path.join(out, `${tag}-5-closed-behind.png`));

  // measured opening time (first frame above 0 to first frame at 1), and the study log
  rep.openingSec = await p.evaluate(({ c }) => (window.__doors?.set || window.pano360.doors).items.find((k) => k.d.id === c.door).lastOpenSec, { c });
  rep.events = await p.evaluate(() => window.__doorEvents);
  rep.studyEvents = withStudy ? await p.evaluate(() => (window.__study?.all || []).filter((e) => /^door|^portal|^doors$/.test(e.e))) : null;
  rep.soundUnlocked = await p.evaluate(() => { const s = (window.__doors?.set || window.pano360?.doors)?.sound; return s?.ctx?.state || "none"; });
  await ctx.close();
  return rep;
}

for (const name of run) {
  const c = CASES[name];
  if (!c) { console.warn(`unknown case ${name}`); continue; }
  for (const [w, h] of [[390, 844], [844, 390]]) {
    const tag = `${name}-${w < h ? "portrait" : "landscape"}`;
    console.log(`${tag} ...`);
    try {
      const r = await one(name, c, w, h);
      report[tag] = r;
      const ev = (list) => list.map((e) => `${e.e}${e.trigger ? "(" + e.trigger + ")" : ""}${e.from ? " " + e.from + "->" + e.to : ""}`).join(", ");
      console.log(`  frames ${r.frames.length}, opening ${r.openingSec}s, events ${ev(r.events)}${r.studyEvents ? ` | study log: ${ev(r.studyEvents)}` : ""}, audio ${r.soundUnlocked}, errors ${r.errors.length}`);
    } catch (e) {
      report[tag] = { failed: String(e) };
      console.log(`  FAILED ${e}`);
    }
  }
}
fs.writeFileSync(path.join(out, "doors-report.json"), JSON.stringify(report, null, 1));
await browser.close();
