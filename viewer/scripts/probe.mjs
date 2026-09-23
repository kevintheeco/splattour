// Ad-hoc probe: runs a JS snippet (file or inline) inside the viewer page and
// prints the result. Usage: node scripts/probe.mjs <scene> "<js expression>" [shot.png]
import { chromium } from "playwright-core";

const [scene = "synthetic-apartment", expr = "1", shot] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on("console", (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`${process.env.VIEWER_URL || "http://localhost:5190"}/?scene=${scene}`);
await page.waitForFunction(() => window.splattour, null, { timeout: 180000 });
await page.waitForTimeout(800);
const result = await page.evaluate(`(async () => { const S = window.splattour; const THREE = S.THREE; ${expr} })()`);
console.log(JSON.stringify(result, null, 2));
if (shot) await page.screenshot({ path: shot });
await browser.close();
