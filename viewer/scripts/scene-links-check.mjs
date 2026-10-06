// Real local SPZ models: single-model rendering, entrance buttons, round trip,
// live map coordinates, independent collision state, failure and retry.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const base = process.argv.find((s) => s.startsWith("--url="))?.slice(6) || process.env.VIEWER_URL || "http://127.0.0.1:5190";
const origin = process.argv.find((s) => s.startsWith("--origin="))?.slice(9) || base;
const dist = process.argv.find((s) => s.startsWith("--dist="))?.slice(7);
const entry = dist ? "/tour.html" : "/";
const cloud = process.argv.includes("--cloud") ? "&from=cloud" : "";
const mobile = process.argv.includes("--mobile");
const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
const page = await context.newPage();
if (origin !== base || dist) {
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (dist) {
      const relative = url.pathname === "/" ? "home.html" : url.pathname === "/tour.html" ? "index.html" : url.pathname.slice(1);
      const file = path.resolve(dist, relative);
      if (!file.startsWith(path.resolve(dist) + path.sep)) return route.fulfill({ status: 404, body: "not found" });
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
      try { await route.fulfill({ body: await fs.readFile(file), contentType: types[path.extname(file)] || "application/octet-stream" }); }
      catch { await route.fulfill({ status: 404, body: "not found" }); }
    } else {
      const response = await page.request.get(base + url.pathname + url.search);
      await route.fulfill({ response });
    }
  });
}
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") console.error(m.text()); });
const status = () => page.evaluate(() => {
  const s = window.splattour, a = window.__app;
  return { active: a.links.active, name: s.sceneName, busy: a.links.busy,
    visible: s.splat.parent.children.filter((o) => o.constructor === s.splat.constructor && o.visible).length,
    edits: s.splat.edits?.length || 0, room: a.room,
    pose: a.chrome.st.pose, expected: a.mapPose(), position: s.rig.position.toArray(),
    tourMatches: s.nav.tour === s.tour, mapMatches: s.walkMap.occ === s.occ,
    mapVisible: !a.chrome.$(".vc-plan").hidden,
  };
});
async function faceEntrance() {
  await page.evaluate(() => {
    const s = window.splattour, a = window.__app, p = a.links.entries[0].point;
    s.nav.stop();
    // Face the ground marker from a safe nearby capture location.
    const n = s.tour.nearestNode(p);
    s.rig.position.copy(n.position);
    const dx = p.x - n.position.x, dz = p.z - n.position.z;
    s.look.set(Math.atan2(-dx, -dz), Math.atan2(p.y - n.position.y, Math.hypot(dx, dz)));
  });
  await page.locator('.scene-link:not([hidden])').waitFor({ state: "visible", timeout: 15000 });
}
try {
  await page.goto(`${origin}${entry}?scene=wolhajeong360-hq&app=1&space=wolhajeong&quality=mobile&onboarding=0${cloud}`);
  await page.waitForFunction(() => window.__app?.links && window.splattour, null, { timeout: 120000 });
  await page.waitForFunction(() => window.__app.chrome.plan, null, { timeout: 15000 });
  await page.evaluate(() => { window.testOriginal = { tour: splattour.tour, occ: splattour.occ, splat: splattour.splat }; });
  await faceEntrance();
  await page.waitForTimeout(500);
  const before = await status();
  assert.equal(before.visible, 1);
  assert.equal(before.edits, 0);
  await fs.mkdir("output/scene-links", { recursive: true });
  await page.screenshot({ path: `output/scene-links/yard${mobile ? "-mobile" : ""}.png` });
  await page.getByRole("button", { name: "별채 사랑방으로 이동", exact: true })[mobile ? "tap" : "click"]();
  await page.waitForFunction(() => __app.links.active === "sarang" && !__app.links.busy, null, { timeout: 120000 });
  const inside = await status();
  assert.equal(inside.visible, 1);
  assert.equal(inside.edits, 0);
  assert.equal(inside.room, "sarang");
  assert.equal(inside.name, "wolhajeong360-sarang3");
  assert.ok(inside.tourMatches && inside.mapMatches && inside.mapVisible);
  assert.ok(Math.abs(inside.pose.x - inside.expected.x) < .001);
  assert.ok(Math.abs(inside.pose.z - inside.expected.z) < .001);
  assert.ok(Math.abs(inside.pose.yaw - inside.expected.yaw) < .001);
  assert.ok(await page.evaluate(() => testOriginal.occ !== splattour.occ && !testOriginal.splat.parent));
  assert.ok(await page.evaluate(() => {
    const s = splattour, t = s.tour.splatTransform;
    return s.splat.position.distanceTo(new s.THREE.Vector3(...t.position)) < 1e-8
      && Math.abs(s.splat.scale.x - t.scale) < 1e-8;
  }), "map transform must never be applied to the model");
  await page.evaluate(() => { splattour.rig.position.x += .12; splattour.look.set(splattour.look.yaw + .2, -.15); });
  await page.waitForTimeout(150);
  const moved = await status();
  assert.ok(Math.hypot(moved.pose.x - inside.pose.x, moved.pose.z - inside.pose.z) > .03);
  assert.ok(Math.abs(moved.pose.yaw - inside.pose.yaw) > .1);
  await page.screenshot({ path: `output/scene-links/sarang${mobile ? "-mobile" : ""}.png` });
  await faceEntrance();
  await page.getByRole("button", { name: "앞마당·안채로 이동", exact: true })[mobile ? "tap" : "click"]();
  await page.waitForFunction(() => __app.links.active === "main" && !__app.links.busy);
  assert.ok(await page.evaluate(() => testOriginal.occ === splattour.occ && testOriginal.tour === splattour.tour));
  assert.equal((await status()).visible, 1);
  // A failed target load must keep the old scene and release input; retry works.
  await page.evaluate(() => {
    const l = __app.links;
    window.realLoad = l.load;
    l.pending.clear();
    l.load = async () => { throw new Error("test offline"); };
  });
  await faceEntrance();
  await page.getByRole("button", { name: "별채 사랑방으로 이동", exact: true })[mobile ? "tap" : "click"]();
  await page.waitForFunction(() => !__app.links.busy);
  assert.equal((await status()).active, "main");
  assert.equal((await status()).visible, 1);
  assert.ok(await page.evaluate(() => splattour.look.enabled && !document.querySelector(".scene-transition").classList.contains("on")));
  await page.evaluate(() => { __app.links.load = window.realLoad; });
  await page.getByRole("button", { name: "별채 사랑방으로 이동", exact: true })[mobile ? "tap" : "click"]();
  await page.waitForFunction(() => __app.links.active === "sarang" && !__app.links.busy);
  // Direct reload in the secondary scene retains local coordinates + common map.
  await page.reload();
  await page.waitForFunction(() => window.__app?.links && window.splattour, null, { timeout: 120000 });
  assert.equal((await status()).active, "sarang");
  assert.equal((await status()).visible, 1);
  assert.equal((await status()).room, "sarang");
  assert.ok(await page.evaluate(() => {
    const a = __app, b = a.links.entries[0].from.barrier;
    return a.stepBlocked(b.center[0] - b.normal[0] * .1, b.center[1] - b.normal[1] * .1,
      b.center[0] + b.normal[0] * .1, b.center[1] + b.normal[1] * .1);
  }));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ before, inside, moved, passed: "round trip, exclusive rendering, independent collision, continuous map position/heading, failure/retry" }, null, 2));
} finally { await browser.close(); }
