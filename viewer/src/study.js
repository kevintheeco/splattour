// User-study logging (RQ1: 3D continuous flight vs panorama cross-fade).
// Loaded only when the URL has ?study=<participant>, so normal visitors never
// run this code. Events are batched to the studio (/api/study/<id>) every 5 s
// and on page hide; a copy stays in memory for "기록 받기" (download).
//
//   /?scene=hanok&mode=pano&onboarding=0&study=P03[&task=T1][&badge=0]

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
  const pid = (params.get("study") || "anon").replace(/[^\w-]/g, "").slice(0, 40) || "anon";
  const session = `${pid}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const t0 = performance.now();
  const all = [];
  let queue = [];
  const log = (e, data = {}) => {
    const rec = { t: Math.round(performance.now() - t0), e, ...data };
    all.push(rec);
    queue.push(rec);
  };
  log("start", {
    pid, session, scene: params.get("scene"), mode: getMode(), task: params.get("task") || "",
    ua: navigator.userAgent, screen: [innerWidth, innerHeight, devicePixelRatio], speed: nav.speed,
    vignette: params.get("vignette") !== "0", onboarding: params.get("onboarding") ?? "",
  });

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

  const flush = (beacon = false) => {
    if (!queue.length) return;
    const body = JSON.stringify({ session, events: queue });
    queue = [];
    const url = `/api/study/${encodeURIComponent(pid)}`;
    try {
      if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      else fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
    } catch {}
  };
  setInterval(flush, 5000);
  addEventListener("pagehide", () => { log("end", { summary: summarize(all) }); flush(true); });

  // researcher badge (hide with &badge=0): participant id, live counters, download
  if (params.get("badge") !== "0") {
    const b = document.createElement("div");
    b.style.cssText = "position:absolute;left:16px;bottom:120px;z-index:5;font:600 12px/1.4 Pretendard,system-ui,sans-serif;color:#fff;background:rgba(160,30,40,.78);padding:6px 10px;border-radius:10px;display:flex;gap:10px;align-items:center";
    const txt = document.createElement("span");
    const dl = document.createElement("button");
    dl.textContent = "기록 받기";
    dl.style.cssText = "font:inherit;color:#fff;background:rgba(255,255,255,.18);border:0;border-radius:6px;padding:2px 8px;cursor:pointer";
    dl.onclick = () => {
      const blob = new Blob([JSON.stringify({ session, summary: summarize(all), events: all }, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${session}.json`;
      a.click();
    };
    b.append(txt, dl);
    document.body.appendChild(b);
    setInterval(() => {
      const s = summarize(all);
      txt.textContent = `실험 기록 중 · ${pid} · ${getMode() === "pano" ? "파노라마" : "3D"} · 이동 ${s.moves} · ${Math.round(s.durationSec)}초`;
    }, 1000);
  }
  return { log, summarize: () => summarize(all), stop: () => { clearInterval(poseTimer); flush(true); } };
}
