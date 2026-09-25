// Listing app walkthrough on an emulated iPhone, portrait 390x844 and
// landscape 844x390: 숙소 목록 → 숙소 상세 (+ 사진 투어) → 360° 시점 탐색 →
// 3DGS 자유 시점 탐색 → 실험 안내. Screenshots → docs/checks/app/, plus a report
// (console errors, horizontal overflow per page).
//   node scripts/app-check.mjs [splatScene=drjohnson]
// Needs the dev server (VIEWER_URL, default http://localhost:5190).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const base = process.env.VIEWER_URL || "http://localhost:5190";
const out = path.resolve(import.meta.dirname, "../../docs/checks/app");
fs.mkdirSync(out, { recursive: true });
const HOME = process.env.HOME_PATH || "/home.html";
const TOUR = process.env.TOUR_PATH || "/";

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const report = { errors: [], overflow: {}, shots: [] };

async function ctx(w, h) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA });
  const p = await c.newPage();
  p.on("pageerror", (e) => report.errors.push(`[${w}x${h}] ${e.message}`));
  p.on("console", (m) => m.type() === "error" && report.errors.push(`[${w}x${h}] ${m.text()}`));
  return p;
}
async function shot(p, name, opts = {}) {
  const f = path.join(out, `${name}.png`);
  await p.screenshot({ path: f, ...opts });
  report.shots.push(path.basename(f));
  report.overflow[name] = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
}

// ---------- portrait ----------
let p = await ctx(390, 844);
await p.goto(base + HOME);
await p.waitForSelector(".lcard");
await p.waitForTimeout(1600);
await shot(p, "p01-home");
await shot(p, "p01-home-full", { fullPage: true });

await p.goto(`${base}/listing.html?id=wolhajeong`);
await p.waitForSelector(".hd-title");
await p.waitForFunction(() => !document.querySelector("#goPano span").textContent.includes("확인 중"));
await p.waitForTimeout(1000);
await shot(p, "p02-detail-top");
for (const [i, sel] of [["a", "#explore"], ["b", ".tiles"], ["c", ".am"], ["d", ".rules"]]) {
  await p.evaluate((s) => { const e = document.querySelector(s); window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 120); }, sel);
  await p.waitForTimeout(1100);
  await shot(p, `p02-detail-${i}`);
}
await shot(p, "p02-detail-full", { fullPage: true });
await p.click(".sec .tile");
await p.waitForTimeout(900);
await shot(p, "p03-phototour");
await p.click(".pt-grid button");
await p.waitForTimeout(700);
await shot(p, "p03-lightbox");

await p.goto(`${base}/listing.html?id=drjohnson`);
await p.waitForSelector(".hd-title");
await p.waitForFunction(() => !document.querySelector("#goSplat span").textContent.includes("확인 중"));
await p.waitForTimeout(900);
await shot(p, "p04-detail-drjohnson");

// 360°: pending state (월하정), dev placeholder, dev render (drjohnson)
await p.goto(`${base}/pano.html?space=wolhajeong`);
await p.waitForSelector(".pv-pending");
await p.waitForTimeout(500);
await shot(p, "p05-pano-wolhajeong-pending");
await p.goto(`${base}/pano.html?space=wolhajeong&dev=1&onboarding=0`);
await p.waitForFunction(() => window.pano360?.current);
await p.waitForTimeout(800);
await shot(p, "p05-pano-wolhajeong-devplaceholder");

await p.goto(`${base}/pano.html?space=drjohnson&tasks=1`);
await p.waitForFunction(() => window.pano360?.current);
await p.waitForTimeout(1500);
await shot(p, "p06-pano-drjohnson");
await p.click(".vc-plan-btn");
await p.waitForTimeout(500);
await shot(p, "p06-pano-drjohnson-plan");
const pano = await p.evaluate(async () => {
  const P = window.pano360;
  const to = P.current.neighbors.find((id) => P.nav.byId.get(id).room !== P.current.room) || P.current.neighbors[0];
  P.go(to);
  return to;
});
await p.waitForTimeout(380);
await shot(p, "p06-pano-drjohnson-transition");
await p.waitForFunction(() => !window.pano360.busy);
await p.waitForTimeout(600);
await shot(p, "p06-pano-drjohnson-arrived");
report.pano = { moved: pano, room: await p.evaluate(() => document.querySelector(".vc-room").textContent) };

// 3DGS 자유 시점 탐색 (app mode)
const scene = process.argv[2] || "drjohnson";
await p.goto(`${base}${TOUR}?scene=${scene}&app=1&space=${scene}&tasks=1&onboarding=0`);
await p.waitForFunction(() => window.splattour && window.__app, null, { timeout: 240000 });
await p.waitForTimeout(3500);
await shot(p, "p07-3dgs");
await p.click(".vc-plan-btn");
await p.waitForTimeout(600);
await shot(p, "p07-3dgs-plan");
report.splat = await p.evaluate(() => ({ room: document.querySelector(".vc-room").textContent, mode: window.splattour.tour.splatMode }));

await p.goto(`${base}/study.html?study=P01&space=${scene}`);
await p.waitForSelector(".steps");
await p.waitForTimeout(500);
await shot(p, "p08-study-intro");
await p.goto(`${base}/study.html?study=P01&space=wolhajeong`);
await p.waitForSelector(".steps");
await shot(p, "p08-study-wolhajeong-blocked");
await p.context().close();

// ---------- landscape ----------
p = await ctx(844, 390);
await p.goto(base + HOME);
await p.waitForSelector(".lcard");
await p.waitForTimeout(1500);
await shot(p, "l01-home");
await p.goto(`${base}/listing.html?id=wolhajeong`);
await p.waitForSelector(".hd-title");
await p.waitForTimeout(1500);
await shot(p, "l02-detail");
await p.goto(`${base}/pano.html?space=drjohnson&tasks=1`);
await p.waitForFunction(() => window.pano360?.current);
await p.waitForTimeout(1500);
await p.click(".vc-plan-btn");
await p.waitForTimeout(500);
await shot(p, "l06-pano-drjohnson");
await p.goto(`${base}${TOUR}?scene=${scene}&app=1&space=${scene}&tasks=1&onboarding=0`);
await p.waitForFunction(() => window.splattour && window.__app, null, { timeout: 240000 });
await p.waitForTimeout(3500);
await p.click(".vc-plan-btn");
await p.waitForTimeout(600);
await shot(p, "l07-3dgs");
await p.context().close();

// portrait, full screen requested on an iPhone (no Fullscreen API): CSS fallback + rotate hint
p = await ctx(390, 844);
await p.addInitScript(() => { Object.defineProperty(document, "fullscreenEnabled", { get: () => false }); Element.prototype.requestFullscreen = undefined; });
await p.goto(`${base}/pano.html?space=drjohnson&onboarding=0`);
await p.waitForFunction(() => window.pano360?.current);
await p.waitForTimeout(800);
await p.click(".vc-fs-btn");
await p.waitForTimeout(600);
await shot(p, "p09-fullscreen-rotate-hint");
report.pseudoFs = await p.evaluate(() => document.documentElement.classList.contains("pseudo-fs"));
await p.context().close();

await browser.close();
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, shots: report.shots.length }, null, 2));
