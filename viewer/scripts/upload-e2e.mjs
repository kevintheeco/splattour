// End-to-end: upload a folder of photos through the live home page.
//   node scripts/upload-e2e.mjs <folder> <title> [quality=cloud-draft]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
const [dir, title, quality = "cloud-draft"] = process.argv.slice(2);
const pw = fs.readFileSync("../secrets/upload_password.txt", "utf8").trim();
const files = fs.readdirSync(dir).filter((n) => /\.(jpe?g|png)$/i.test(n)).map((n) => path.resolve(dir, n));
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto("https://splattour-rho.vercel.app/");
await p.waitForFunction(() => !document.querySelector("#uploadNote").textContent.includes("연결하는 중"), null, { timeout: 20000 });
await p.setInputFiles("#picker", files);
await p.fill("#title", title);
await p.fill("#pw", pw);
await p.selectOption("#quality", quality);
const t0 = Date.now();
await p.click("#go");
await p.waitForFunction(() => /다 올라갔어요/.test(document.querySelector("#upState").textContent) || document.querySelector("#uploadNote .warn"), null, { timeout: 1800000 });
await p.screenshot({ path: "../docs/checks/upload-e2e.png" });
console.log(JSON.stringify({ files: files.length, mb: Math.round(files.reduce((s, f) => s + fs.statSync(f).size, 0) / 1e6), sec: Math.round((Date.now() - t0) / 1000), state: await p.textContent("#upState"), note: await p.textContent("#uploadNote"), errs }));
await b.close();
