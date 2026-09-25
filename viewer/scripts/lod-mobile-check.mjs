// Phone loading check: emulated iPhone (touch, 390x844, DPR 3, iOS user agent
// and platform) with Chrome DevTools "Fast 4G" network and 4x CPU slowdown.
// Loads the scene once per quality mode and reports, from navigation start:
//   visibleMs  - loader gone, the scene is on screen
//   sharpMs    - every chunk the start view wants is resident (streamed mode;
//                the single-file modes are sharp as soon as they are visible)
//   MB         - bytes downloaded until sharp
//   splatMemMB - bytes held by splat buffers (CPU copy; the GPU holds the same again)
//   heapPeakMB - peak JS heap of the page
//   procPeakMB - peak private memory of all the browser's processes (Windows)
// then screenshots a few viewpoints once they are sharp.
//   node scripts/lod-mobile-check.mjs <scene> [modes=mobile,lod] [outDir]
// VIEWER_URL (default http://localhost:5191, a `vite preview` of the build).
import { chromium, devices } from "playwright-core";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const scene = process.argv[2] || "drjohnson";
const modes = (process.argv[3] || "mobile,lod").split(",");
const out = path.resolve(process.argv[4] || path.join(import.meta.dirname, "../../docs/checks/lod-mobile-" + scene));
const base = process.env.VIEWER_URL || "http://localhost:5191";
const nodes = (process.env.NODES || "n0,n6,n12").split(",");
fs.mkdirSync(out, { recursive: true });

// Chrome DevTools "Fast 4G" preset: 9 Mbps down, 1.5 Mbps up (x0.9), 60 ms x2.75 latency.
const FAST_4G = { offline: false, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9, latency: 60 * 2.75 };

function procMemMB() {
  try {
    const cmd = `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*playwright_chromiumdev_profile*' } | Measure-Object -Property PrivatePageCount -Sum).Sum"`;
    return Math.round(Number(execSync(cmd, { encoding: "utf8" }).trim()) / 1048576);
  } catch {
    return 0;
  }
}

const results = [];
for (const mode of modes) {
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
  const ctx = await browser.newContext({ ...devices["iPhone 13"], deviceScaleFactor: 3 });
  // Spark picks its phone defaults from navigator.platform / user agent.
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "iPhone" }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const throttle = process.env.THROTTLE !== "0";
  if (throttle) {
    await cdp.send("Network.emulateNetworkConditions", FAST_4G);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  await cdp.send("Performance.enable");
  let bytes = 0;
  cdp.on("Network.loadingFinished", (e) => (bytes += e.encodedDataLength || 0));

  const t0 = Date.now();
  await page.goto(`${base}/?scene=${scene}&quality=${mode}&onboarding=0${process.env.EXTRA || ""}`, { waitUntil: "commit" });
  let visibleMs = null, sharpMs = null, bytesVisible = 0, bytesSharp = 0, heapPeak = 0, procPeak = 0, lastProc = 0;
  let firstFrameMs = null;
  while (Date.now() - t0 < 240000) {
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => ({
      done: document.querySelector("#loader")?.classList.contains("done"),
      stream: window.splattour?.stream?.(),
      times: window.__loadTimes,
      label: document.querySelector("#loaderSub")?.textContent,
    })).catch(() => ({}));
    const m = await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }));
    const heap = m.metrics.find((x) => x.name === "JSHeapUsedSize")?.value || 0;
    heapPeak = Math.max(heapPeak, heap);
    if (Date.now() - lastProc > 2000) { procPeak = Math.max(procPeak, procMemMB()); lastProc = Date.now(); }
    if (firstFrameMs == null && st.times?.firstFrame != null) firstFrameMs = Date.now() - t0;
    if (visibleMs == null && st.done) { visibleMs = Date.now() - t0; bytesVisible = bytes; }
    const isStreamed = st.stream && st.stream.want > 0;
    if (visibleMs != null && sharpMs == null && (!isStreamed || st.times?.sharp != null)) { sharpMs = Date.now() - t0; bytesSharp = bytes; }
    if (visibleMs != null && sharpMs != null) break;
  }
  const info = await page.evaluate(() => {
    const S = window.splattour;
    let mem = 0;
    const add = (a) => { if (a && a.byteLength) mem += a.byteLength; };
    const p = S.spark.pager;
    if (S.splat.paged && p) {
      add(p.packedTexture.value.image.data);
      for (const t of p.shTextures) if (t.value.image?.data?.byteLength > 64) add(t.value.image.data);
    } else {
      add(S.splat.packedSplats?.packedArray);
      for (const v of Object.values(S.splat.packedSplats?.extra || {})) add(v);
    }
    return { mode: S.tour.splatMode, splatMem: mem, pool: p ? p.maxSplats : null, lodSplatCount: S.spark.lodSplatCount, pr: S.renderer.getPixelRatio(), fps: window.__fps, times: window.__loadTimes };
  });
  procPeak = Math.max(procPeak, procMemMB());
  await page.waitForTimeout(3000);
  const procSettled = procMemMB();
  await page.screenshot({ path: path.join(out, `${mode}-start.png`) });

  // Viewpoints: jump (no flight), wait for sharp, screenshot.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 });
  for (const id of nodes) {
    await page.evaluate((id) => { const S = window.splattour; S.nav.jumpTo(S.tour.byId.get(id)); }, id);
    const tn = Date.now();
    let ok = 0;
    while (ok < 8 && Date.now() - tn < 30000) {
      await page.waitForTimeout(150);
      const s = (await page.evaluate(() => window.splattour.stream?.())) || {};
      ok = !s.want || s.done ? ok + 1 : 0;
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `${mode}-${id}.png`) });
  }

  const r = {
    mode,
    loaded: info.mode,
    firstFrameMs,
    visibleMs,
    sharpMs,
    MBvisible: +(bytesVisible / 1048576).toFixed(1),
    MBsharp: +(bytesSharp / 1048576).toFixed(1),
    splatMemMB: +(info.splatMem / 1048576).toFixed(0),
    heapPeakMB: Math.round(heapPeak / 1048576),
    procPeakMB: procPeak,
    procSettledMB: procSettled,
    pool: info.pool,
    lodSplatCount: info.lodSplatCount,
    pixelRatio: info.pr,
    fps: info.fps && Math.round(info.fps),
    pageTimes: info.times,
    errors: errors.filter((e) => !/favicon/.test(e)).slice(0, 5),
  };
  console.log(JSON.stringify(r));
  results.push(r);
  await browser.close();
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ network: "Fast 4G (9/1.5 Mbps, 165 ms)", cpu: "4x slowdown", device: "iPhone 13 (390x844, DPR 3)", results }, null, 2));
console.log("→", out);
