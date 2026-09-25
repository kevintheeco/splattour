// Study log transport shared by both viewers (and study.js of the 3DGS
// viewer). Events are batched to /api/study/<participant> every 5 s and on
// page hide: the studio server (localhost:5200, data/study/) in the lab, or
// the site's function (web-api/api/study, R2 study/) when published. Every
// session is also kept in this browser (localStorage) so the study page can
// hand the researcher a file even when the network failed.

export const BACKUP_PREFIX = "splattour-study:";

export function participantId(raw) {
  return String(raw || "anon").replace(/[^\w-]/g, "").slice(0, 40) || "anon";
}

export function createStudyLog({ pid: rawPid, meta = {} }) {
  const pid = participantId(rawPid);
  const session = `${pid}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const t0 = performance.now();
  const all = [];
  let queue = [];
  const log = (e, data = {}) => {
    const rec = { t: Math.round(performance.now() - t0), e, ...data };
    all.push(rec);
    queue.push(rec);
    return rec;
  };
  const backup = () => {
    try { localStorage.setItem(BACKUP_PREFIX + session, JSON.stringify({ pid, session, meta, events: all })); } catch {}
  };
  const flush = (beacon = false) => {
    backup();
    if (!queue.length) return;
    const body = JSON.stringify({ session, events: queue });
    queue = [];
    const url = `/api/study/${encodeURIComponent(pid)}`;
    try {
      if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      else fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
    } catch {}
  };
  const timer = setInterval(flush, 5000);
  log("start", { pid, session, ...meta, ua: navigator.userAgent, screen: [innerWidth, innerHeight, devicePixelRatio] });
  const download = (summary) => {
    const blob = new Blob([JSON.stringify({ session, summary, events: all }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${session}.json`;
    a.click();
  };
  return { pid, session, log, all, flush, backup, download, stop: () => { clearInterval(timer); flush(true); } };
}

// Researcher badge (hidden with &badge=0): live text + "기록 받기".
export function studyBadge(textFn, onDownload) {
  const b = document.createElement("div");
  b.className = "study-badge";
  b.style.cssText = "position:fixed;left:max(12px,env(safe-area-inset-left));bottom:calc(12px + env(safe-area-inset-bottom));z-index:30;font:600 12px/1.4 Pretendard,system-ui,sans-serif;color:#fff;background:rgba(160,30,40,.78);padding:6px 10px;border-radius:10px;display:flex;gap:10px;align-items:center;max-width:calc(100vw - 24px)";
  const txt = document.createElement("span");
  const dl = document.createElement("button");
  dl.textContent = "기록 받기";
  dl.style.cssText = "font:inherit;color:#fff;background:rgba(255,255,255,.18);border:0;border-radius:6px;padding:2px 8px;cursor:pointer;white-space:nowrap";
  dl.onclick = onDownload;
  b.append(txt, dl);
  document.body.appendChild(b);
  setInterval(() => { txt.textContent = textFn(); }, 1000);
  return b;
}

// Common summary of an app-mode session (both conditions): time, rooms in
// the order visited, path length, task answers.
export function summarizeApp(events) {
  const rooms = events.filter((e) => e.e === "room").map((e) => e.room);
  const path = events.filter((e) => e.e === "pose" && e.p);
  let dist = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1].p, b = path[i].p;
    dist += Math.hypot(b[0] - a[0], b[2] - a[2]);
  }
  const answers = events.filter((e) => e.e === "task_answer");
  return {
    durationSec: +(((events.at(-1)?.t ?? 0) - (events[0]?.t ?? 0)) / 1000).toFixed(1),
    roomsVisited: [...new Set(rooms)],
    roomSequence: rooms,
    pathMeters: +dist.toFixed(2),
    tasks: answers.map((a) => ({ id: a.id, type: a.type, sec: +(a.ms / 1000).toFixed(1), correct: a.correct ?? null, errorDeg: a.errorDeg ?? null, answer: a.answer ?? null })),
  };
}
