// Bakes what the streamed (LoD) phone path cannot compute itself, because it
// never holds every splat at once: the occupancy grid (walking, collisions),
// the minimap floor plan and the viewpoint thumbnails. They are produced by the
// desktop viewer from the full scene, so the phone gets exactly the same ones.
//   node scripts/bake-lod-aux.mjs <scene>      (dev server on :5190)
// Writes scenes/<scene>/lod/{occupancy.bin, plan.png, thumbs/<node>.jpg}.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const scene = process.argv[2] || "drjohnson";
const base = process.env.VIEWER_URL || "http://localhost:5190";
const out = path.resolve(import.meta.dirname, "../../scenes", scene, "lod");
fs.mkdirSync(path.join(out, "thumbs"), { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(`${base}/?scene=${encodeURIComponent(scene)}&quality=full&onboarding=0`);
await page.waitForFunction(() => window.splattour, null, { timeout: 300000 });

const baked = await page.evaluate(async () => {
  const s = window.splattour;
  if (s.tour.splatMode !== "full") throw new Error("bake must run on the full scene");
  const b64 = (u8) => {
    let t = "";
    for (let i = 0; i < u8.length; i += 0x8000) t += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(t);
  };
  const occ = b64(s.occ.toBuffer());
  const mm = new s.Minimap({ canvas: document.createElement("canvas"), tour: s.tour, splat: s.splat, rig: s.rig, look: s.look });
  const plan = mm.plan.canvas.toDataURL("image/png").split(",")[1];
  const thumbs = {};
  for (const [id, url] of s.thumbs) thumbs[id] = b64(new Uint8Array(await (await fetch(url)).arrayBuffer()));
  return { occ, plan, thumbs, grid: [s.occ.nx, s.occ.ny, s.occ.nz], planCount: mm.plan.count };
});

fs.writeFileSync(path.join(out, "occupancy.bin"), Buffer.from(baked.occ, "base64"));
fs.writeFileSync(path.join(out, "plan.png"), Buffer.from(baked.plan, "base64"));
for (const [id, data] of Object.entries(baked.thumbs)) fs.writeFileSync(path.join(out, "thumbs", `${id}.jpg`), Buffer.from(data, "base64"));
const size = (f) => fs.statSync(path.join(out, f)).size;
console.log(JSON.stringify({ out, grid: baked.grid, occupancyBytes: size("occupancy.bin"), planBytes: size("plan.png"), planSplats: baked.planCount, thumbs: Object.keys(baked.thumbs).length }));
await browser.close();
