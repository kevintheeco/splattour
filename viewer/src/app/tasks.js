// Study tasks (tasks.json), shown the same way in both conditions.
//   goto   "…까지 가 보세요"      → [도착했어요]; arrival in the target room is also logged by itself
//   point  "…은 어느 방향인가요?"  → face it, [이 방향이에요]; logs the angle error
//   choice "…"                     → one of the options
// Each task may start at a capture point (`start`): the viewer puts you there first.
import { icon } from "./icons.js";
import { esc, bearing, angDiff } from "./data.js";

export class TaskRunner {
  // opts: { slot, tasks, nav, log, getPose: () => ({x, z, yaw, room}), jumpTo(nodeId), onDone, nextLabel }
  constructor(opts) {
    this.o = opts;
    this.i = -1;
    this.el = document.createElement("section");
    this.el.className = "vc-task";
    opts.slot.appendChild(this.el);
    this.crosshair = document.createElement("div");
    this.crosshair.className = "vc-crosshair";
    this.crosshair.hidden = true;
    this.crosshair.innerHTML = icon("target");
    document.body.appendChild(this.crosshair);
    this.el.addEventListener("click", (e) => this._click(e));
  }

  get task() { return this.o.tasks[this.i]; }

  start() {
    this.next();
  }

  async next() {
    this.i++;
    const t = this.task;
    if (!t) return this._finish();
    this.reached = false;
    if (t.start) await this.o.jumpTo(t.start);
    this.t0 = performance.now();
    this.o.log("task_start", { id: t.id, type: t.type, target: t.target ?? null, start: t.start ?? null });
    this._render();
  }

  // Called by the viewer whenever the room changes.
  roomChanged(roomId) {
    const t = this.task;
    if (t?.type === "goto" && !this.reached && roomId === t.target) {
      this.reached = true;
      this.o.log("task_reached", { id: t.id, ms: Math.round(performance.now() - this.t0) });
    }
  }

  _render(done = false) {
    const t = this.task;
    const n = this.o.tasks.length;
    this.crosshair.hidden = !(t?.type === "point") || done;
    if (done) {
      this.el.innerHTML = `<div class="vc-task-head"><span>과제 ${n} / ${n}</span></div><p class="vc-task-q">모든 과제를 마쳤어요.</p>
        <div class="vc-task-acts">${this.o.onDone ? `<button class="vc-pill primary" data-act="done">${esc(this.o.nextLabel || "다음으로")}${icon("chevron")}</button>` : ""}</div>`;
      return;
    }
    let acts = "";
    if (t.type === "goto") acts = `<button class="vc-pill primary" data-act="arrive">${icon("check")}도착했어요</button>`;
    else if (t.type === "point") acts = `<button class="vc-pill primary" data-act="point">${icon("target")}이 방향이에요</button>`;
    else if (t.type === "choice") acts = (t.options || []).map((o, k) => `<button class="vc-pill" data-act="choice" data-k="${k}">${esc(o)}</button>`).join("");
    this.el.innerHTML = `
      <div class="vc-task-head"><span>과제 ${this.i + 1} / ${n}</span><button class="vc-task-min" data-act="min" aria-label="과제 접기">${icon("up")}</button></div>
      <p class="vc-task-q">${esc(t.prompt)}</p>
      <div class="vc-task-acts">${acts}</div>`;
    this.el.classList.remove("min", "enter");
    void this.el.offsetWidth;
    this.el.classList.add("enter");
  }

  _click(e) {
    const b = e.target.closest("button");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "min") {
      const m = this.el.classList.toggle("min");
      b.innerHTML = icon(m ? "down" : "up");
      return;
    }
    if (act === "done") return this.o.onDone?.();
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
    setTimeout(() => { this.el.classList.remove("sent"); this.next(); }, 380);
  }

  _finish() {
    this.i = this.o.tasks.length;
    this.o.log("tasks_done", {});
    this._render(true);
  }
}
