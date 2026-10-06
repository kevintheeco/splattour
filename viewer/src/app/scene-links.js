// Independent 3D scenes, connected only by explicit entrances and a map frame.
// Map transforms never touch a SplatMesh, collision grid or camera pose.
import * as THREE from "three";
import { placeMatrix } from "./placement.js";
import "./scene-links.css";

export function mapPose(definition, position, yaw) {
  const matrix = placeMatrix(definition?.mapTransform);
  const p = position.clone();
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  if (matrix) { p.applyMatrix4(matrix); forward.transformDirection(matrix); }
  return { x: p.x, y: p.y, z: p.z, yaw: Math.atan2(-forward.x, -forward.z) };
}

export function localPoint(definition, position) {
  const p = new THREE.Vector3(...position);
  const matrix = placeMatrix(definition?.mapTransform);
  return matrix ? p.applyMatrix4(matrix.invert()) : p;
}

export class SceneLinks {
  constructor({ config, active, camera, rig, canvas, load, activate, ready, freeze, log, toast, onChange }) {
    Object.assign(this, { config, active, camera, rig, canvas, load, activate, ready, freeze, log, toast, onChange });
    this.definitions = new Map(config.spaces.map((s) => [s.id, s]));
    this.pending = new Map();
    this.retryAt = new Map();
    this.busy = false;
    this.layer = document.createElement("div");
    this.layer.className = "scene-links";
    document.body.append(this.layer);
    this.cover = document.createElement("div");
    this.cover.className = "scene-transition";
    this.cover.setAttribute("role", "status");
    this.cover.setAttribute("aria-live", "polite");
    document.body.append(this.cover);
    this.rebuild();
  }

  get definition() { return this.definitions.get(this.active); }
  pose(position, yaw) { return mapPose(this.definition, position, yaw); }

  rebuild() {
    this.layer.replaceChildren();
    this.entries = [];
    for (const link of this.config.links) {
      const from = link.a.space === this.active ? link.a : link.b.space === this.active ? link.b : null;
      if (!from) continue;
      const to = from === link.a ? link.b : link.a;
      const button = document.createElement("button");
      button.className = "scene-link";
      button.hidden = true;
      button.dataset.link = link.id;
      const name = this.definitions.get(to.space).name;
      const last = name.charCodeAt(name.length - 1);
      const final = last >= 0xac00 && last <= 0xd7a3 ? (last - 0xac00) % 28 : 0;
      const label = `${name}${final && final !== 8 ? "으로" : "로"} 이동`;
      button.setAttribute("aria-label", label);
      const arrow = document.createElement("span");
      arrow.className = "scene-link-arrow";
      arrow.textContent = "↑";
      arrow.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = label;
      button.append(arrow, text);
      button.addEventListener("pointerdown", (e) => e.stopPropagation());
      const entry = { link, from, to, button, point: new THREE.Vector3(...from.marker) };
      button.addEventListener("click", () => this.travel(entry));
      this.layer.append(button);
      this.entries.push(entry);
    }
  }

  ensure(id, retry = false) {
    if (retry) this.retryAt.delete(id);
    if ((this.retryAt.get(id) || 0) > performance.now()) return null;
    if (!this.pending.has(id)) {
      const promise = this.load(this.definitions.get(id)).catch((error) => {
        this.pending.delete(id);
        this.retryAt.set(id, performance.now() + 15000);
        throw error;
      });
      promise.catch(() => {});
      this.pending.set(id, promise);
    }
    return this.pending.get(id);
  }

  update() {
    const rect = this.canvas.getBoundingClientRect();
    for (const entry of this.entries) {
      const distance = Math.hypot(this.rig.position.x - entry.point.x, this.rig.position.z - entry.point.z);
      if (!this.busy && distance < (this.config.preloadDistance || 5)) this.ensure(entry.to.space);
      const p = entry.point.clone().project(this.camera);
      const visible = !this.busy && distance < (entry.from.radius || 3.5) && p.z > -1 && p.z < 1 && Math.abs(p.x) < .94 && Math.abs(p.y) < .9;
      entry.button.hidden = !visible;
      if (visible) {
        entry.button.style.left = `${rect.left + (p.x + 1) * rect.width / 2}px`;
        entry.button.style.top = `${rect.top + (1 - p.y) * rect.height / 2}px`;
      }
    }
  }

  async travel(entry) {
    if (this.busy || entry.from.space !== this.active) return false;
    this.busy = true;
    this.freeze(true);
    this.update();
    const previous = this.active;
    try {
      this.toast("다음 공간을 준비하는 중…", 1500);
      const context = await this.ensure(entry.to.space, true);
      this.cover.textContent = `${this.definitions.get(entry.to.space).name} 이동 중`;
      this.cover.classList.add("on");
      await new Promise((r) => setTimeout(r, 220));
      // No mesh cross-fade. Old scene is detached before the new one is shown.
      this.activate(context, entry.to);
      this.active = entry.to.space;
      this.onChange(context, this.definition);
      this.rebuild();
      // Spark keeps the previous GPU accumulator until its asynchronous sort finishes.
      await this.ready?.(context);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      this.log?.("scene_transition", { link: entry.link.id, from: previous, to: this.active });
      return true;
    } catch (error) {
      console.warn("[scene-links] transition failed", error);
      this.toast("공간을 불러오지 못했어요. 화살표를 눌러 다시 시도해 주세요.", 4500);
      return false;
    } finally {
      this.cover.classList.remove("on");
      this.freeze(false);
      this.busy = false;
    }
  }
}
