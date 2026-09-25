// End-to-end study link on an emulated phone: intro → condition 1 (tasks) →
// questionnaire → condition 2 (tasks) → end, then reads the sessions kept in
// the browser and prints each one's app summary (rooms, answers, times).
//   node scripts/study-flow-check.mjs [space=drjohnson] [pid=P02]
// Uses &dev=1 (the drjohnson 360° images are dev renders, blocked otherwise).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const [space = "drjohnson", pid = "P02"] = process.argv.slice(2);
const base = process.env.VIEWER_URL || "http://localhost:5190";
const out = path.resolve(import.meta.dirname, "../../docs/checks/app");
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const c = await b.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await c.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
p.on("dialog", (d) => d.accept());

await p.goto(`${base}/study.html?study=${pid}&space=${space}&dev=1`);
await p.click(".big-btn");
const order = [];
for (let k = 0; k < 2; k++) {
  const isPano = await p.waitForFunction(() => (window.pano360?.runner && "pano") || (window.__app?.runner && "splat"), null, { timeout: 240000 }).then((h) => h.jsonValue());
  order.push(isPano);
  await p.waitForTimeout(1500);
  // answer every task: move toward the target first for goto tasks
  for (let t = 0; t < 10; t++) {
    const task = await p.evaluate(() => { const r = (window.pano360 || window.__app).runner; return r.task ? { type: r.task.type, target: r.task.target } : null; });
    if (!task) break;
    if (task.type === "goto") {
      await p.evaluate(async (target) => {
        if (window.pano360) {
          const P = window.pano360, nav = P.nav;
          const path = [...nav.rooms.get(target).nodes];
          for (let i = 0; i < 6 && P.current.room !== target; i++) {
            const nb = P.current.neighbors.map((id) => nav.byId.get(id)).sort((a, b2) => Math.hypot(a.position[0] - path[0].position[0], a.position[2] - path[0].position[2]) - Math.hypot(b2.position[0] - path[0].position[0], b2.position[2] - path[0].position[2]))[0];
            await P.go(nb.id);
            while (P.busy) await new Promise((r) => setTimeout(r, 50));
          }
        } else {
          const S = window.splattour, nav = window.__app.nav;
          const n = nav.rooms.get(target).nodes[0];
          const tn = S.tour.nearestNode(new S.THREE.Vector3(...n.position));
          S.go(tn);
          while (S.nav.busy) await new Promise((r) => setTimeout(r, 50));
          await new Promise((r) => setTimeout(r, 400));
        }
      }, task.target);
    }
    await p.waitForTimeout(400);
    if (t === 0) await p.screenshot({ path: path.join(out, `s0${k + 1}-study-${isPano}.png`) });
    await p.click(".vc-task [data-act=arrive], .vc-task [data-act=point], .vc-task [data-act=choice] >> nth=0");
    await p.waitForTimeout(700);
  }
  await p.screenshot({ path: path.join(out, `s0${k + 1}-study-${isPano}-done.png`) });
  await p.click('.vc-task [data-act="done"]');
  await p.waitForSelector(".study h1");
  await p.screenshot({ path: path.join(out, `s0${k + 1}-study-questionnaire.png`) });
  await p.click(".big-btn:not(.ghost)");
}
await p.waitForSelector("#dl");
await p.screenshot({ path: path.join(out, "s03-study-end.png") });
const sessions = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("splattour-study:")).map((k) => JSON.parse(localStorage.getItem(k))));
const brief = sessions.map((s) => {
  const ev = s.events;
  const answers = ev.filter((e) => e.e === "task_answer").map((a) => ({ id: a.id, type: a.type, sec: +(a.ms / 1000).toFixed(1), correct: a.correct ?? null, errorDeg: a.errorDeg ?? null, room: a.room }));
  return { session: s.session, cond: s.meta.cond, events: ev.length, rooms: [...new Set(ev.filter((e) => e.e === "room").map((e) => e.room))], answers };
});
console.log(JSON.stringify({ order, sessions: brief, errs }, null, 1));
await b.close();
