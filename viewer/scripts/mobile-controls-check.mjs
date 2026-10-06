// Real touch events: shared 3DGS viewer, simultaneous walking/look, and cancellation.
// VIEWER_URL=http://127.0.0.1:5191 CHROME_PATH=... node scripts/mobile-controls-check.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${process.env.VIEWER_URL || 'http://127.0.0.1:5191'}/?scene=${process.env.SCENE || "wolhajeong360-hq"}&quality=mobile&onboarding=0`);
    await page.waitForFunction(() => window.splattour?.joystick, null, { timeout: 120000 });
    const stick = page.locator('.vc-joy');
    assert.equal(await stick.count(), 1);
    assert.ok(await stick.isVisible());
    const box = await stick.boundingBox();
    const client = await context.newCDPSession(page);
    const touch = (type, touchPoints) => client.send('Input.dispatchTouchEvent', { type, touchPoints });
    const pose = () => page.evaluate(() => {
      const { look, rig, joystick } = window.splattour;
      return { yaw: look.yaw, pitch: look.pitch, x: rig.position.x, z: rig.position.z, joy: joystick.value(), dragging: look.dragging };
    });
    await page.evaluate(() => window.splattour.look.set(0, 0));
    const start = await pose();
    const a = { id: 1, x: viewport.width * .72, y: viewport.height * .50 };
    await touch('touchStart', [a]);
    await touch('touchMove', [{ ...a, x: a.x - 65, y: a.y - 55 }]);
    const looked = await pose();
    assert.ok(looked.yaw < start.yaw && looked.pitch < start.pitch, 'up-left drag looks right and down');
    assert.ok(Math.hypot(looked.x - start.x, looked.z - start.z) < .01, 'look does not walk');
    await touch('touchEnd', []);
    await page.evaluate(() => window.splattour.look.set(0, 0));
    const joy = { id: 2, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const pushed = { ...joy, y: joy.y - 30 };
    await touch('touchStart', [joy]);
    await touch('touchMove', [pushed]);
    assert.ok((await pose()).joy.y > .5);
    const beforeWalk = await pose();
    await page.waitForTimeout(800);
    const walked = await pose();
    assert.ok(Math.hypot(walked.x - beforeWalk.x, walked.z - beforeWalk.z) > .05, 'joystick moves camera');
    const second = { id: 3, x: viewport.width * .75, y: viewport.height * .45 };
    await touch('touchStart', [pushed, second]);
    await touch('touchMove', [pushed, { ...second, x: second.x - 45, y: second.y - 30 }]);
    const both = await pose();
    assert.ok(both.yaw < walked.yaw && both.pitch < walked.pitch && both.joy.y > .5, 'walk and look together');
    await touch('touchCancel', []);
    const canceled = await pose();
    assert.deepEqual(canceled.joy, { x: 0, y: 0 });
    assert.equal(canceled.dragging, false);
    await page.waitForTimeout(1000);
    const stopped = await pose();
    await page.waitForTimeout(300);
    const later = await pose();
    assert.ok(Math.hypot(later.x - stopped.x, later.z - stopped.z) < .001, 'release stops walking');
    await page.evaluate(() => window.splattour.setMode('pano'));
    assert.equal(await stick.isVisible(), false);
    await page.evaluate(() => window.splattour.setMode('splat'));
    assert.equal(await stick.isVisible(), true);
    assert.deepEqual(errors, []);
    console.log(`${viewport.width}x${viewport.height}: touch look, walking, simultaneous input, cancel, and mode visibility passed`);
    await context.close();
  }
} finally { await browser.close(); }
