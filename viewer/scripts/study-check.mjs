// ?study= logging check: badge shows, events reach the studio, summary sane.
import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:5190/?scene=playroom-2m&onboarding=0&study=PCHECK&task=T0");
await p.waitForFunction(() => window.splattour && window.__study, null, { timeout: 180000 });
await p.evaluate(() => { const S = window.splattour; S.go(S.tour.neighbors(S.nav.current)[0]); });
await p.waitForTimeout(4000);
await p.mouse.move(640, 380); await p.mouse.wheel(0, -240); await p.waitForTimeout(6500);
const badge = await p.evaluate(() => [...document.querySelectorAll("div")].find((d) => d.textContent.startsWith("실험 기록 중"))?.textContent);
console.log(JSON.stringify({ badge, summary: await p.evaluate(() => window.__study.summarize()), errs }));
await b.close();
