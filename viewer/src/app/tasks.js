// Study tasks (tasks.json), shown the same way in both conditions: a slim
// pill under the top bar ("1/5 · …" + the answer button). A new task opens
// as a small card so it can be read; it folds back into the pill as soon as
// you start looking around, and a tap on the pill opens it again.
//   goto   "…까지 가 보세요"      → [도착]; arrival in the target room is also logged by itself
//   point  "…은 어느 방향인가요?"  → face it, [이 방향]; logs the angle error
//   choice "…"                     → one of the options (in the open card)
// Each task may start at a capture point (`start`): the viewer puts you there first.
import { icon } from "./icons.js";
import { esc, bearing, angDiff } from "./data.js";

export class TaskRunner {
  // opts: { slot, tasks, nav, log, look, getPose: () => ({x, z, yaw, room}), jumpTo(nodeId), onDone, nextLabel }
  constructor(opts) {
    this.o = opts;
    this.i = -1;
    this.open = true;
    this.el = document.createElement("section");
    this.el.className = "vc-task";
    opts.slot.appendChild(this.el);
    this.crosshair = document.createElement("div");
    this.crosshair.className = "vc-crosshair";
    this.crosshair.hidden = true;
    this.crosshair.innerHTML = icon("target");
    document.body.appendChild(this.crosshair);
    this.el.addEventListener("click", (e) => this._click(e));
    // fold into the pill once the participant starts exploring
    opts.look?.addEventListener("interact", () => {
      if (this.open && this.task && this.task.type !== "choice" && performance.now() - this.shownAt > 900) this.setOpen(false);
    });
  }

  get task() { return this.o.tasks[this.i]; }

  start() { this.next(); }

  async next() {
    this.i++;
    const t = this.task;
    if (!t) return this._finish();
    this.reached = false;
    if (t.start) await this.o.jumpTo(t.start);
    this.t0 = performance.now();
    this.o.log("task_start", { id: t.id, type: t.type, target: t.target ?? null, start: t.start ?? null });
    this.open = true;
    this._render();
  }

  roomChanged(roomId) {
    const t = this.task;
    if (t?.type === "goto" && !this.reached && roomId === t.target) {
      this.reached = true;
      this.o.log("task_reached", { id: t.id, ms: Math.round(performance.now() - this.t0) });
    }
  }

  setOpen(on) {
    if (this.open === on) return;
    this.open = on;
    this.el.classList.toggle("open", on);
    this.o.log("task_card", { id: this.task?.id ?? null, open: on });
  }

  _render(done = false) {
    const t = this.task, n = this.o.tasks.length;
    this.crosshair.hidden = t?.type !== "point" || done;
    const num = `<span class="vc-task-n">${done ? n : this.i + 1}<i>/${n}</i></span>`;
    if (done) {
      this.open = true;
      this.el.className = "vc-task open done";
      this.el.innerHTML = `<div class="vc-task-row">${num}<p class="vc-task-q">모든 과제를 마쳤어요</p>${this.o.onDone ? `<button class="vc-pill primary" data-act="done">${esc(this.o.nextLabel || "다음으로")}${icon("chevron")}</button>` : ""}</div>`;
      return;
    }
    const quick = t.type === "goto" ? `<button class="vc-pill primary" data-act="arrive">${icon("check")}<span>도착</span></button>`
      : t.type === "point" ? `<button class="vc-pill primary" data-act="point">${icon("target")}<span>이 방향</span></button>`
      : `<button class="vc-pill" data-act="expand"><span>답하기</span></button>`;
    const choices = t.type === "choice" ? `<div class="vc-task-choices">${(t.options || []).map((o, k) => `<button class="vc-pill" data-act="choice" data-k="${k}">${esc(o)}</button>`).join("")}</div>` : "";
    this.el.className = `vc-task ${this.open ? "open" : ""} t-${t.type}`;
    this.el.innerHTML = `
      <div class="vc-task-row" data-act="toggle">
        ${num}<p class="vc-task-q">${esc(t.prompt)}</p>${quick}
        <button class="vc-task-tg" data-act="toggle" aria-label="과제 펼치기/접기">${icon("down")}</button>
      </div>${choices}`;
    this.shownAt = performance.now();
    this.el.classList.remove("enter");
    void this.el.offsetWidth;
    this.el.classList.add("enter");
  }

  _click(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "toggle") return this.setOpen(!this.open);
    if (act === "expand") return this.setOpen(true);
    if (act === "done") return this.o.onDone?.();
    e.stopPropagation();
    const t = this.task;
    if (!t) return;
    const pose = this.o.getPose();
    const ms = Math.round(performance.now() - this.t0);
    const rec = { id: t.id, type: t.type, ms, room: pose.room, p: [+pose.x.toFixed(3), +pose.z.toFixed(3)], yaw: +pose.yaw.toFixed(3) };
    if (act === "arrive") Object.assign(rec, { answer: pose.room, correct: pose.room === t.target, reached: this.reached });
    if (act === "point") {
      const room = this.o.nav.rooms.get(t.target);
      const truth = bearing([pose.x, 0, pose.z], room.anchor);
      Object.assign(rec, { truthYaw: +truth.toFixed(3), errorDeg: +Math.abs((angDiff(pose.yaw, truth) * 180) / Math.PI).toFixed(1) });
    }
    if (act === "choice") {
      const ans = t.options[+b.dataset.k];
      Object.assign(rec, { answer: ans, correct: t.answer != null ? ans === t.answer : null });
    }
    this.o.log("task_answer", rec);
    this.el.classList.add("sent");
    setTimeout(() => { this.el.classList.remove("sent"); this.next(); }, 420);
  }

  _finish() {
    this.i = this.o.tasks.length;
    this.o.log("tasks_done", {});
    this._render(true);
  }
}
