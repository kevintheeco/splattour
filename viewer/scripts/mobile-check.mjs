// Phone-sized check (touch, portrait): layout, first tip wording, tap-to-move.
//   node scripts/mobile-check.mjs <scene>
import { chromium, devices } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
const scene = process.argv[2] || "drjohnson";
const out = path.resolve("../docs/checks/mobile-" + scene);
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ ...devices["iPhone 13"], deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto(`http://localhost:5190/?scene=${scene}&onboarding=1`);
await p.waitForFunction(() => window.splattour, null, { timeout: 180000 });
await p.waitForTimeout(1500);
await p.screenshot({ path: path.join(out, "1-start.png") });
const tip = await p.evaluate(() => document.querySelector("#hint span")?.innerText);
// swipe to look
await p.touchscreen.tap(195, 420);
await p.waitForTimeout(600);
await p.screenshot({ path: path.join(out, "2-after-tap.png") });
console.log(JSON.stringify({ tip, fps: await p.evaluate(() => window.__fps), errs }));
await b.close();
