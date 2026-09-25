// Study link: /study.html?study=<participant>&space=<id>
// Runs both conditions in a counterbalanced order with the same tasks:
//   intro → condition 1 → questionnaire → condition 2 → questionnaire → end
// Order: odd participant numbers start with 360°, even with 3DGS (&order=AB|BA
// overrides; A = 360° 시점 탐색, B = 3DGS 자유 시점 탐색). &conds=pano or
// &conds=splat runs a single condition (between-subjects design).
// Each condition page logs to /api/study/<participant> (see studylog.js);
// the end page offers every session kept in this browser as one file.
import { loadListing, loadNav, loadTasks, findScene, esc } from "./data.js";
import { icon } from "./icons.js";
import { BACKUP_PREFIX, participantId } from "./studylog.js";

const params = new URLSearchParams(location.search);
const pid = participantId(params.get("study"));
const spaceId = params.get("space") || "wolhajeong";
const step = +(params.get("step") || 0);
const DEV = params.get("dev") === "1";
const $ = (s) => document.querySelector(s);
const NAMES = { pano: "360° 시점 탐색", splat: "3DGS 자유 시점 탐색" };

function order() {
  const only = params.get("conds");
  if (only === "pano" || only === "splat") return [only];
  let o = params.get("order");
  if (o !== "AB" && o !== "BA") {
    const n = parseInt((pid.match(/\d+/) || ["1"])[0], 10);
    o = n % 2 === 1 ? "AB" : "BA";
  }
  return o === "AB" ? ["pano", "splat"] : ["splat", "pano"];
}

// steps: 0 intro, then per condition: run (odd), questionnaire (even), last = end
const conds = order();
const stepUrl = (s) => { const u = new URL(location.href); u.searchParams.set("step", String(s)); return u.pathname + u.search; };

async function main() {
  const listing = await loadListing(spaceId);
  const [nav, tasksData, scene] = await Promise.all([loadNav(spaceId, listing), loadTasks(spaceId, listing), findScene(listing.explore?.scene)]);
  const cfg = (await fetch(`/spaces/${spaceId}/tasks.json`).then((r) => r.json()).catch(() => ({}))).study || {};
  const root = $("#study");
  const last = conds.length * 2 + 1;
  const list = conds.map((c, i) => `<li class="${step > i * 2 + 2 ? "done" : step === i * 2 + 1 || step === i * 2 + 2 ? "now" : ""}"><i>${step > i * 2 + 2 ? icon("check") : i + 1}</i><span>${NAMES[c]}${step > i * 2 + 1 && step <= i * 2 + 2 ? " · 설문" : ""}</span></li>`).join("");

  const ready = { pano: nav.panoReady || (DEV && nav.panoViewable), splat: !!scene };
  const common = `&space=${encodeURIComponent(spaceId)}&study=${encodeURIComponent(pid)}&onboarding=0&badge=${DEV ? 1 : 0}${DEV ? "&dev=1" : ""}${cfg.plan === false ? "&plan=0" : ""}`;
  const condUrl = (c, i) => {
    const next = encodeURIComponent(stepUrl(i * 2 + 2));
    const seq = `&seq=${i + 1}&next=${next}`;
    return c === "pano" ? `/pano.html?${common.slice(1)}${seq}` : `${scene.href}&app=1${common}${seq}`;
  };

  if (step === 0) {
    const missing = conds.filter((c) => !ready[c]);
    root.innerHTML = `
      <span class="eyebrow">참가자 ${esc(pid)}</span>
      <h1>${esc(listing.title)}을(를)<br />두 가지 방식으로 둘러봅니다</h1>
      <p>각 방식마다 같은 과제 ${tasksData.length}개를 차례로 풀게 됩니다. 과제는 화면 위쪽에 나타나요. 끝나면 짧은 설문이 이어집니다.</p>
      <ol class="steps">${list}</ol>
      <p style="font-size:13.5px;color:var(--muted)">휴대폰을 가로로 돌리면 더 넓게 볼 수 있어요. 화면 오른쪽 위의 전체 화면 버튼을 눌러 주세요.</p>
      ${missing.length ? `<div class="warn-box"><b>아직 시작할 수 없어요.</b><br />${missing.map((c) => (c === "pano" ? (nav.panoViewable ? "360°: 개발용 파노라마뿐이라 실험에 쓸 수 없어요 (미리 보기는 주소에 &dev=1)" : `360°: ${esc(nav.pendingLabel)}`) : "3DGS: 3D 준비 중")).join("<br />")}</div>` : ""}
      ${missing.length ? "" : `<a class="big-btn" href="${condUrl(conds[0], 0)}">시작하기${icon("chevron")}</a>`}`;
    return;
  }
  if (step === last) {
    const sessions = Object.keys(localStorage).filter((k) => k.startsWith(BACKUP_PREFIX + pid + "-"));
    root.innerHTML = `
      <span class="eyebrow">참가자 ${esc(pid)}</span>
      <h1>모두 마쳤어요.<br />참여해 주셔서 감사합니다</h1>
      <ol class="steps">${list}</ol>
      <div class="note-box">연구자용: 기록은 실험 서버로 보냈고, 이 기기에도 ${sessions.length}개 세션이 남아 있어요.</div>
      <button class="big-btn" id="dl">기록 받기 (JSON)</button>`;
    $("#dl").addEventListener("click", () => {
      const data = sessions.map((k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }).filter(Boolean);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ pid, space: spaceId, order: conds, sessions: data }, null, 1)], { type: "application/json" }));
      a.download = `study-${pid}.json`;
      a.click();
    });
    return;
  }
  const i = Math.floor((step - 1) / 2);
  if (step % 2 === 1) {
    // back from a condition page with the browser: offer to (re)start it
    location.replace(ready[conds[i]] ? condUrl(conds[i], i) : stepUrl(0));
    return;
  }
  // questionnaire after condition i (placeholder hook)
  const q = cfg.questionnaireUrl ? cfg.questionnaireUrl.replace("{pid}", encodeURIComponent(pid)).replace("{cond}", conds[i]) : "";
  root.innerHTML = `
    <span class="eyebrow">참가자 ${esc(pid)} · ${i + 1}번째 방식 끝</span>
    <h1>${NAMES[conds[i]]}에 대한<br />설문에 답해 주세요</h1>
    <ol class="steps">${list}</ol>
    ${q ? `<a class="big-btn ghost" href="${esc(q)}" target="_blank" rel="noopener">설문 열기</a>` : `<div class="note-box"><b>설문 자리</b><br />여기에 조건별 설문(예: 실재감 IPQ · 사용성 SUS · 멀미 SSQ · 공간 이해)이 들어갑니다. tasks.json의 study.questionnaireUrl에 설문 주소를 넣으면 이 자리에 버튼이 생겨요. ({pid}, {cond} 자리에 참가자·조건이 들어갑니다)</div>`}
    <a class="big-btn" href="${step + 1 === last ? stepUrl(last) : condUrl(conds[i + 1], i + 1)}">${step + 1 === last ? "마치기" : "다음 방식으로"}${icon("chevron")}</a>`;
}

main().catch((e) => { $("#study").innerHTML = `<p>${esc(e.message)}</p>`; });
