// Browser check of the source-photo feature: gallery, full view, "이 자리에서 3D로 보기"
// and the photo/3D overlay. Screenshots → docs/checks/photos-<scene>/
//   node scripts/photos-check.mjs <scene> [photoIndexInGallery=0]
import { chromium } from "playwright-core";
import fs from "node:fs";

const [scene = "drjohnson-hq", pick = "0"] = process.argv.slice(2);
const out = `../docs/checks/photos-${scene}`;
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`http://localhost:5190/?scene=${scene}&onboarding=0`);
await p.waitForFunction(() => window.splattour, null, { timeout: 240000 });
await p.waitForSelector('[data-act="photos"]:not([hidden])', { timeout: 20000 });
await p.waitForTimeout(1200);
await p.click('[data-act="photos"]');
await p.waitForTimeout(1500);
await p.screenshot({ path: `${out}/1-gallery.png` });
await p.click('#photoOrder [data-o="capture"]');
await p.waitForTimeout(800);
const n = await p.$$eval(".pthumb", (e) => e.length);
await p.locator(".pthumb").nth(+pick).click();
await p.waitForTimeout(1500);
await p.screenshot({ path: `${out}/2-photo.png` });
await p.click("#photoGo");
await p.waitForFunction(() => !document.querySelector("#photoCompare").hidden, null, { timeout: 15000 });
await p.waitForTimeout(1500);
for (const [k, v] of [["3-overlay-photo", 1], ["4-overlay-half", 0.5], ["5-overlay-3d", 0]]) {
  await p.evaluate((v) => { const s = document.querySelector("#photoMix"); s.value = v; s.dispatchEvent(new Event("input")); }, v);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/${k}.png` });
}
const state = await p.evaluate(() => { const S = window.splattour; return { fov: S.look.fov, roll: S.look.roll, pos: S.rig.position.toArray(), fps: window.__fps }; });
console.log(JSON.stringify({ thumbs: n, state, errors }));
await b.close();
