// Render the scene from exact held-out camera poses (see pipeline eval_views.py)
// at the photos' resolution, with every overlay hidden, for PSNR/SSIM scoring.
//   node scripts/eval-render.mjs <scene> <views.json> <outDir> [full|mobile|lod]
// The optional quality picks the file the viewer loads (default: its own
// choice, i.e. the full scene on desktop). With "lod" every view waits until
// the chunks it asks for are resident.
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const [scene, viewsPath, outDir, quality] = process.argv.slice(2);
const views = JSON.parse(fs.readFileSync(viewsPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: views[0].w, height: views[0].h }, deviceScaleFactor: 1 });
p.on("pageerror", (e) => console.log("[pageerror]", e.message));
await p.goto(`http://localhost:5190/?scene=${scene}&onboarding=0&vignette=0${quality ? `&quality=${quality}` : ""}${process.env.EXTRA || ""}`);
await p.waitForFunction(() => window.splattour, null, { timeout: 240000 });
await p.waitForTimeout(1500);
await p.evaluate(() => {
  const S = window.splattour;
  S.renderer.setAnimationLoop(null); // we render by hand
  const scene = S.splat.parent;
  for (const o of scene.children) if (o !== S.splat && o !== S.spark && o !== S.rig) o.visible = false;
  S.lighting.preset?.("day");
  window.__evalCam = new S.THREE.PerspectiveCamera(50, 1, 0.03, 500);
  scene.add(window.__evalCam);
});
let i = 0;
for (const v of views) {
  const data = await p.evaluate(async (v) => {
    const S = window.splattour, cam = window.__evalCam, scene = S.splat.parent;
    S.renderer.setPixelRatio(1);
    S.renderer.setSize(v.w, v.h, false);
    cam.fov = v.fovY; cam.aspect = v.w / v.h; cam.updateProjectionMatrix();
    cam.position.fromArray(v.position); cam.quaternion.fromArray(v.quaternion); cam.updateMatrixWorld(true);
    for (let k = 0; k < 3; k++) { await S.spark.update({ scene, camera: cam }); S.renderer.render(scene, cam); await new Promise((r) => requestAnimationFrame(r)); }
    // streamed tree: keep rendering until this view's chunks stay resident
    if (S.splat.paged) {
      const t0 = performance.now();
      let ok = 0;
      while (ok < 10 && performance.now() - t0 < 20000) {
        await S.spark.update({ scene, camera: cam });
        S.renderer.render(scene, cam);
        await new Promise((r) => requestAnimationFrame(r));
        ok = S.stream().done ? ok + 1 : 0;
      }
    }
    await S.spark.update({ scene, camera: cam });
    S.renderer.render(scene, cam);
    return S.renderer.domElement.toDataURL("image/png");
  }, v);
  const name = v.name.replace(/\.[^.]+$/, "");
  fs.writeFileSync(path.join(outDir, name + ".png"), Buffer.from(data.split(",")[1], "base64"));
  i++;
}
console.log(`${i} renders → ${outDir}`);
await b.close();
