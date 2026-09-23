// Screenshots of the lighting controls for review: day, night with lamps on,
// night with the main lamp off. Usage: node scripts/light-demo.mjs <scene> <node> <yaw> <pitch> <lampId>
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
const [scene, node, yaw = "3.0", pitch = "0.1", lamp] = process.argv.slice(2);
const out = path.resolve("../docs/checks/lighting-" + scene);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:5190/?scene=${scene}`);
await page.waitForFunction(() => window.splattour, null, { timeout: 180000 });
await page.evaluate(([n, y, p]) => { const S = window.splattour; S.nav.jumpTo(S.tour.byId.get(n), { yaw: +y, pitch: +p }); document.querySelector("#hint").classList.add("gone"); }, [node, yaw, pitch]);
const snap = async (name) => { await page.waitForTimeout(1300); await page.screenshot({ path: path.join(out, name) }); };
await snap("1-day.png");
await page.evaluate(() => window.splattour.lighting.preset("evening")); await snap("2-evening.png");
await page.evaluate(() => window.splattour.lighting.preset("night")); await snap("3-night.png");
if (lamp) { await page.evaluate((id) => { const S = window.splattour; S.setLamp(S.lighting.lights.find((l) => l.id === id), false); }, lamp); await snap("4-night-lamp-off.png"); }
await page.evaluate(() => { const S = window.splattour; S.lighting.lights.forEach((l) => S.setLamp(l, true)); S.lighting.preset("golden"); document.querySelector('[data-act="light"]').click(); }); await snap("5-golden-panel.png");
await browser.close();
console.log(out);
