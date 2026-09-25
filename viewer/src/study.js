// User-study logging (RQ1: 3D continuous flight vs panorama cross-fade).
// Loaded only when the URL has ?study=<participant>, so normal visitors never
// run this code. Events are batched to the studio (/api/study/<id>) every 5 s
// and on page hide; a copy stays in memory for "기록 받기" (download).
//
//   /?scene=hanok&mode=pano&onboarding=0&study=P03[&task=T1][&badge=0]

import { createStudyLog, studyBadge, summarizeApp } from "./app/studylog.js";

export function summarize(events) {
  const moves = events.filter((e) => e.e === "depart");
  const arrives = events.filter((e) => e.e === "arrive");
  const path = events.filter((e) => e.e === "pose");
  let dist = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1].p, b = path[i].p;
    dist += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const dwell = {};
  for (let i = 0; i < arrives.length; i++) {
    const end = i + 1 < arrives.length ? arrives[i + 1].t : (events.at(-1)?.t ?? arrives[i].t);
    const id = arrives[i].node ?? "(free)";
    dwell[id] = (dwell[id] || 0) + (end - arrives[i].t);
  }
  return {
    durationSec: +(((events.at(-1)?.t ?? 0) - (events[0]?.t ?? 0)) / 1000).toFixed(1),
    moves: moves.length,
    uniqueNodes: new Set(arrives.map((e) => e.node).filter(Boolean)).size,
    pathMeters: +dist.toFixed(2),
    zooms: events.filter((e) => e.e === "zoom").length,
    approaches: events.filter((e) => e.e === "approach").length,
    modeSwitches: events.filter((e) => e.e === "mode").length,
    dwellSec: Object.fromEntries(Object.entries(dwell).map(([k, v]) => [k, +(v / 1000).toFixed(1)])),
  };
}

export function start({ nav, look, rig, params, canvas, getMode, tour }) {
  // transport, session id and local backup are shared with the 360° viewer (app/studylog.js)
  const S = createStudyLog({
    pid: params.get("study"),
    meta: {
      scene: params.get("scene"), mode: getMode(), task: params.get("task") || "", speed: nav.speed,
      vignette: params.get("vignette") !== "0", onboarding: params.get("onboarding") ?? "",
      app: params.get("app") === "1", space: params.get("space") || "", cond: params.get("app") === "1" ? "splat" : "", seq: params.get("seq") || "",
    },
  });
  const { log, all, pid } = S;

  // the viewer jumps to the start node before this module loads: record it as the first arrival
  if (nav.current) log("arrive", { node: nav.current.id }); // already at a viewpoint
  nav.addEventListener("depart", (e) => log("depart", { to: e.detail?.target?.id ?? null, len: +(e.detail?.length ?? 0).toFixed(2), dur: +(e.detail?.duration ?? 0).toFixed(2) }));
  nav.addEventListener("arrive", (e) => log("arrive", { node: e.detail?.node?.id ?? null }));
  canvas.addEventListener("dblclick", () => log("approach"));
  let lastFov = look.targetFov;
  let lastMode = getMode();

  // pose sampled at 4 Hz: position, yaw, pitch, fov (enough for path plots and heatmaps)
  const poseTimer = setInterval(() => {
    const p = rig.position;
    log("pose", { p: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)], yaw: +look.yaw.toFixed(3), pitch: +look.pitch.toFixed(3), fov: +look.fov.toFixed(1) });
    if (Math.abs(look.targetFov - lastFov) > 0.5) { log("zoom", { fov: +look.targetFov.toFixed(1) }); lastFov = look.targetFov; }
    const m = getMode();
    if (m !== lastMode) { log("mode", { mode: m }); lastMode = m; }
  }, 250);

  const full = () => ({ ...summarize(all), app: summarizeApp(all) });
  addEventListener("pagehide", () => { log("end", { summary: full() }); S.flush(true); });

  // researcher badge (hide with &badge=0): participant id, live counters, download
  if (params.get("badge") !== "0") {
    studyBadge(() => {
      const s = summarize(all);
      return `실험 기록 중 · ${pid} · ${getMode() === "pano" ? "파노라마" : "3D"} · 이동 ${s.moves} · ${Math.round(s.durationSec)}초`;
    }, () => S.download(full()));
  }
  return { log, all, flush: S.flush, summarize: () => summarize(all), stop: () => { clearInterval(poseTimer); S.stop(); } };
}
