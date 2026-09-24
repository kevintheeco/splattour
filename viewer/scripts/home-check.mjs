// Screenshot of the home page (upload + list): node scripts/home-check.mjs [url]
import { chromium } from "playwright-core";
const url = process.argv[2] || "http://localhost:5190/home.html";
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const errs = [];
for (const [name, vp] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]]) {
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: name === "phone" ? 2 : 1 });
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForSelector(".scene, .empty:not(:empty)", { timeout: 20000 });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `../docs/checks/home-${name}.png`, fullPage: true });
  await p.close();
}
console.log(JSON.stringify({ errs }));
await b.close();
