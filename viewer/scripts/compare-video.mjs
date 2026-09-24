// Records the same route twice, conventional 360 panorama (cross-fade) vs SplatTour 3D
// flight, for the thesis/presentation (RQ1). Output: ../docs/video/<scene>-{pano,splat}.webm
//   node scripts/compare-video.mjs [scene=drjohnson] [n0,n1,n2,...]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const scene = process.argv[2] || "drjohnson";
const out = path.resolve("../docs/video");
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });

for (const mode of ["pano", "splat"]) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:5190/?scene=${scene}&mode=${mode}&onboarding=0&node=n0`);
  await p.waitForFunction(() => window.splattour, null, { timeout: 240000 });
  // hide chrome that isn't part of the comparison (thumb strip, tools)
  await p.addStyleTag({ content: "#strip,#stripToggle,#tools,#brand,#toast{display:none!important}" });
  await p.waitForTimeout(mode === "pano" ? 6000 : 2500); // pano pre-renders its cube maps
  const route = (process.argv[3] || "").split(",").filter(Boolean);
  const ids = route.length ? route : await p.evaluate(() => {
    // a walk through the graph: follow neighbours, prefer unvisited
    const { tour } = window.splattour; const seen = new Set(["n0"]); const r = []; let cur = tour.byId.get("n0");
    for (let k = 0; k < 7; k++) {
      const nb = tour.neighbors(cur).filter((n) => !seen.has(n.id));
      if (!nb.length) break;
      cur = nb[0]; seen.add(cur.id); r.push(cur.id);
    }
    return r;
  });
  const t0 = Date.now();
  await p.waitForTimeout(1200);
  for (const id of ids) {
    await p.evaluate((id) => window.splattour.go(window.splattour.tour.byId.get(id)), id);
    await p.waitForFunction(() => !window.splattour.nav.moving && !window.splattour.nav.busy, null, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(mode === "pano" ? 900 : 1200); // pano fades are handled inside go()
    await p.waitForTimeout(1300); // look for a moment
  }
  const sec = (Date.now() - t0) / 1000;
  const file = await p.video().path();
  await ctx.close();
  const dst = path.join(out, `${scene}-${mode}.webm`);
  fs.renameSync(file, dst);
  console.log(mode, ids.join(" → "), `${sec.toFixed(1)} s`, dst);
}
await b.close();
