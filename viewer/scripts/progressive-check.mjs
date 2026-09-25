// Desktop progressive load check: streamed tree first, then the full file
// swapped in at the same pose. Same view (월하정 n3: the lattice window 3-5 m
// away, 1280x720, vertical FOV 50°) rendered (a) during the tree phase, (b)
// just before and (c) after the swap, (d) with ?quality=full and (e) with
// ?quality=lod (the old desktop default). PSNR of each against (d), pose
// before/after the swap, the progress pill over time.
// Output: docs/checks/progressive/ (+ progressive-report.json).
//   node scripts/progressive-check.mjs [scene=wolhajeong] [node=n3]   (VIEWER_URL)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const [scene = "wolhajeong", node = "n3"] = process.argv.slice(2);
const base = process.env.VIEWER_URL || "http://localhost:5190";
const out = path.resolve(import.meta.dirname, "../../docs/checks/progressive");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const report = { scene, node };
const HIDE = "body * { visibility: hidden !important } #view { visibility: visible !important }";

async function open(q) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (/swapped|full file|streamed tree/.test(m.text())) console.log(`  [${q || "default"}] ${m.text()}`); });
  const t0 = Date.now();
  await p.goto(`${base}/?scene=${scene}&onboarding=0&node=${node}${q}`);
  await p.waitForFunction(() => window.splattour, null, { timeout: 300000 });
  await p.evaluate(() => { const S = window.splattour; S.look.setFov(50); S.look.update(0); });
  return { p, errors, t0 };
}
const pose = (p) => p.evaluate(() => { const S = window.splattour; return { x: +S.rig.position.x.toFixed(4), y: +S.rig.position.y.toFixed(4), z: +S.rig.position.z.toFixed(4), yaw: +S.look.yaw.toFixed(4), pitch: +S.look.pitch.toFixed(4) }; });
const clean = async (p, file) => { const st = await p.addStyleTag({ content: HIDE }); await p.waitForTimeout(150); await p.screenshot({ path: path.join(out, file) }); await st.evaluate((e) => e.remove()); };

// (a)-(c): default desktop load
{
  const { p, errors, t0 } = await open("");
  const timeline = [];
  let k = 0, beforeShot = null, swappedAt = null;
  for (let i = 0; i < 240; i++) {
    const pr = await p.evaluate(() => window.splattour.progress());
    const t = Date.now() - t0;
    timeline.push({ t, pill: pr?.pill, on: pr?.pillOn, full: pr?.full?.frac != null ? +pr.full.frac.toFixed(3) : null, swapped: !!pr?.full?.swapped });
    if (pr?.full?.swapped) { swappedAt = t; break; }
    if (i % 4 === 0) { const f = `seq-${String(k++).padStart(2, "0")}.png`; await p.screenshot({ path: path.join(out, f) }); }
    if (i === 8) { await clean(p, "a-tree-phase.png"); report.treePose = await pose(p); }
    if (pr?.full?.frac >= 0.999) { await clean(p, "b-before-swap.png"); beforeShot = await pose(p); }
    await p.waitForTimeout(250);
  }
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(out, `seq-${String(k++).padStart(2, "0")}-after.png`) });
  await clean(p, "c-after-swap.png");
  report.default = { swappedAtMs: swappedAt, poseBeforeSwap: beforeShot, poseAfterSwap: await pose(p), pillAfter: await p.evaluate(() => window.splattour.progress()), loadTimes: await p.evaluate(() => window.__loadTimes), pagerLeft: await p.evaluate(() => !!window.splattour.spark.pager), meshes: await p.evaluate(() => { const r = []; window.splattour.renderer && window.splattour.rig.parent.traverse((o) => { if (o.isSplatMesh || o.packedSplats || o.paged) r.push({ paged: !!o.paged, n: o.packedSplats?.numSplats ?? null, opacity: o.opacity }); }); return r; }), timeline, errors };
  await p.close();
}
// (d) full file, (e) tree only
for (const [q, file, key] of [["&quality=full", "d-quality-full.png", "full"], ["&quality=lod", "e-quality-lod.png", "lod"]]) {
  const { p, errors } = await open(q);
  if (q.includes("lod")) await p.waitForFunction(() => { const s = window.splattour.stream(); return s.done; }, null, { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(4000);
  await clean(p, file);
  report[key] = { pose: await pose(p), errors };
  await p.close();
}
fs.writeFileSync(path.join(out, "progressive-report.json"), JSON.stringify(report, null, 1));
await browser.close();
console.log(JSON.stringify({ swappedAtMs: report.default.swappedAtMs, poseBefore: report.default.poseBeforeSwap, poseAfter: report.default.poseAfterSwap, pillAfter: report.default.pillAfter, pagerLeft: report.default.pagerLeft, meshes: report.default.meshes, errors: report.default.errors }));
