// Step-up walking in the real viewer (Chrome, GPU), on an emulated phone.
// Dr Johnson's House is flat, so this puts a test 마루 (0.45 m platform with a
// capture point on it) and a 댓돌 (0.27 m stone) into its walls grid, with
// plain boxes drawn where they are, then walks from the parlour floor up onto
// the platform (click-walk) and back down (W A S D). Frames of both, the eye
// height over time (chart) and step-report.json go to docs/checks/steps/.
// TEST ONLY: the boxes exist only in this check, not in any data.
//   node scripts/steps-check.mjs      (VIEWER_URL, default http://localhost:5190)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const base = process.env.VIEWER_URL || "http://localhost:5190";
const out = path.resolve(import.meta.dirname, "../../docs/checks/steps");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const report = {};

// test geometry (world metres, axis-aligned): [x0, x1, y0, y1, z0, z1]
const MARU = [-2.2, -1.1, 0, 0.45, -2.0, -1.0];
const STONE = [-1.1, -0.72, 0, 0.27, -1.75, -1.28];
const TOP = { x: -1.75, z: -1.5, floor: 0.45 };
const START = { x: 0.35, z: -1.5, yaw: Math.PI / 2 }; // facing west, at the 마루

for (const [w, h] of [[844, 390], [390, 844]]) {
  const tag = w > h ? "landscape" : "portrait";
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${base}/?scene=drjohnson&onboarding=0&node=n0`);
  await p.waitForFunction(() => window.splattour?.walkMap, null, { timeout: 240000 });
  await p.waitForTimeout(4000);
  const setup = await p.evaluate(({ MARU, STONE, TOP }) => {
    const S = window.splattour, T = S.THREE, o = S.occ;
    const fill = ([x0, x1, y0, y1, z0, z1]) => {
      const v = o.voxel, I = (a, m) => Math.floor((a - m) / v);
      for (let y = I(y0, o.box.min.y); y <= I(y1 - 1e-4, o.box.min.y); y++)
        for (let z = I(z0, o.box.min.z); z <= I(z1 - 1e-4, o.box.min.z); z++)
          for (let x = I(x0, o.box.min.x); x <= I(x1 - 1e-4, o.box.min.x); x++) o.solid[(y * o.nz + z) * o.nx + x] = 1;
    };
    fill(MARU); fill(STONE);
    // a capture point standing on the 마루 makes it a floor level
    S.tour.nodes.push({ id: "test-maru", index: S.tour.nodes.length, name: "test", position: new T.Vector3(TOP.x, TOP.floor + S.tour.eyeHeight, TOP.z), yaw: 0, pitch: -0.2, floorY: TOP.floor });
    S.walkMap.levels.clear();
    // draw them: plain wood / stone, top lit, sides shaded
    const box = ([x0, x1, y0, y1, z0, z1], col) => {
      const c = new T.Color(col);
      const mats = [0.62, 0.62, 1, 0.4, 0.8, 0.8].map((k) => new T.MeshBasicMaterial({ color: c.clone().multiplyScalar(k) }));
      const m = new T.Mesh(new T.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mats);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2 + 0.001, (z0 + z1) / 2);
      S.rig.parent.add(m);
    };
    box(MARU, "#8a6a4a");
    box(STONE, "#8c8a84");
    const g = S.walkMap.level(0);
    window.__steps = [];
    // eye height recorder
    window.__eye = [];
    const rec = (t) => { const r = S.rig.position; window.__eye.push({ t, y: r.y, x: r.x, z: r.z, f: S.walkMap.heightAt(g, r.x, r.z) }); requestAnimationFrame(rec); };
    requestAnimationFrame(rec);
    return { levels: g.levels, steps: g.steps, top: S.walkMap.heightAt(g, TOP.x, TOP.z), stone: S.walkMap.heightAt(g, -0.9, -1.5) };
  }, { MARU, STONE, TOP });
  // stand in front, facing the 마루
  await p.evaluate((st) => { const S = window.splattour; S.nav.current = null; S.rig.position.set(st.x, 1.45, st.z); S.look.set(st.yaw, -0.62); }, START);
  await p.waitForTimeout(3000);
  let k = 0;
  const shot = async (label) => { const f = `${tag}-${String(k++).padStart(2, "0")}-${label}.png`; await p.screenshot({ path: path.join(out, f) }); return f; };
  const frames = [];
  frames.push(await shot("before"));
  // click-walk onto the 마루 (the route goes over the 댓돌)
  const t0 = await p.evaluate(({ TOP }) => { const S = window.splattour; window.__eye.length = 0; const r = S.nav.goToPoint(new S.THREE.Vector3(TOP.x, TOP.floor + 1.45, TOP.z)); return { ok: r, t: performance.now() }; }, { TOP });
  for (let i = 0; i < 40; i++) {
    const busy = await p.evaluate(() => window.splattour.nav.busy);
    frames.push(await shot("up"));
    if (!busy && i > 3) break;
    await p.waitForTimeout(120);
  }
  await p.waitForTimeout(800);
  frames.push(await shot("on-maru"));
  const upSeries = await p.evaluate(() => window.__eye.slice());
  // turn around and step down with the keyboard (W)
  await p.evaluate((st) => { const S = window.splattour; S.look.set(st.yaw + Math.PI, -0.62); window.__eye.length = 0; }, START);
  await p.waitForTimeout(600);
  frames.push(await shot("turned"));
  await p.keyboard.down("KeyW");
  for (let i = 0; i < 14; i++) { await p.waitForTimeout(150); frames.push(await shot("down")); }
  await p.keyboard.up("KeyW");
  await p.waitForTimeout(1200);
  frames.push(await shot("after"));
  const downSeries = await p.evaluate(() => window.__eye.slice());
  const steps = await p.evaluate(() => window.__steps);

  // the same two walks again without screenshots (they stall frames), for the numbers
  const measure = async (up) => {
    await p.evaluate(({ up, TOP, START }) => {
      const S = window.splattour;
      if (up) { S.nav.current = null; S.rig.position.set(START.x, 1.45, START.z); S.look.set(START.yaw, -0.3); }
      window.__eye.length = 0;
      if (up) setTimeout(() => S.nav.goToPoint(new S.THREE.Vector3(TOP.x, TOP.floor + 1.45, TOP.z)), 300);
      else S.look.set(START.yaw + Math.PI, -0.3);
    }, { up, TOP, START });
    if (up) await p.waitForFunction(() => window.__eye.length > 30 && !window.splattour.nav.busy, null, { timeout: 30000 });
    else { await p.keyboard.down("KeyW"); await p.waitForTimeout(2100); await p.keyboard.up("KeyW"); }
    await p.waitForTimeout(900);
    return p.evaluate(() => window.__eye.slice());
  };
  const upM = await measure(true), downM = await measure(false);

  // eye-height analysis: how fast the eyes move (no jumps), floors met
  const analyse = (s) => {
    let maxRate = 0, maxJump = 0, maxDt = 0;
    for (let i = 1; i < s.length; i++) {
      const dt = (s[i].t - s[i - 1].t) / 1000;
      if (dt <= 0) continue;
      maxDt = Math.max(maxDt, dt);
      const dy = Math.abs(s[i].y - s[i - 1].y);
      maxJump = Math.max(maxJump, dy);
      maxRate = Math.max(maxRate, dy / dt);
    }
    const floors = [];
    for (const e of s) { const f = Number.isFinite(e.f) ? +e.f.toFixed(2) : null; if (f !== null && floors.at(-1) !== f) floors.push(f); }
    return { frames: s.length, maxFrameMs: Math.round(maxDt * 1000), eyeStart: +s[0]?.y.toFixed(3), eyeEnd: +s.at(-1)?.y.toFixed(3), maxEyeStepPerFrame: +maxJump.toFixed(3), maxEyeSpeed: +maxRate.toFixed(2), floors };
  };
  report[tag] = { setup, walkStarted: t0.ok, up: analyse(upM), down: analyse(downM), withScreenshots: { up: analyse(upSeries), down: analyse(downSeries) }, stepAnims: steps, frames, errors };
  // chart of the eye height (both walks)
  const chart = await p.evaluate(({ up, down }) => {
    const c = document.createElement("canvas");
    c.width = 900; c.height = 320;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 900, 320);
    g.font = "14px sans-serif"; g.fillStyle = "#222";
    g.fillText("눈높이(m) — 위: 마루로 올라가기(댓돌 경유), 아래: 걸어서 내려오기. 회색 = 발밑 바닥 + 1.45 m", 12, 20);
    const plot = (s, y0, label) => {
      if (!s.length) return;
      const t0 = s[0].t, T = s.at(-1).t - t0 || 1;
      const Y = (v) => y0 + 110 - ((v - 1.35) / 0.65) * 110;
      g.strokeStyle = "#ddd";
      for (const v of [1.45, 1.67, 1.9]) { g.beginPath(); g.moveTo(40, Y(v)); g.lineTo(880, Y(v)); g.stroke(); g.fillStyle = "#888"; g.fillText(v.toFixed(2), 2, Y(v) + 4); }
      g.strokeStyle = "#bbb"; g.lineWidth = 6; g.beginPath();
      s.forEach((e, i) => { const x = 40 + ((e.t - t0) / T) * 840, y = Y((Number.isFinite(e.f) ? e.f : NaN) + 1.45); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
      g.strokeStyle = "#d33"; g.lineWidth = 2; g.beginPath();
      s.forEach((e, i) => { const x = 40 + ((e.t - t0) / T) * 840, y = Y(e.y); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
      g.fillStyle = "#222"; g.fillText(`${label} (${(T / 1000).toFixed(1)} s)`, 44, y0 + 12);
    };
    plot(up, 30, "올라가기");
    plot(down, 175, "내려오기");
    return c.toDataURL("image/png");
  }, { up: upM, down: downM });
  fs.writeFileSync(path.join(out, `${tag}-eye-height.png`), Buffer.from(chart.split(",")[1], "base64"));
  console.log(tag, JSON.stringify({ setup, up: report[tag].up, down: report[tag].down, stepAnims: steps.length, errors: errors.length }));
  await ctx.close();
}
fs.writeFileSync(path.join(out, "step-report.json"), JSON.stringify(report, null, 1));
await browser.close();
