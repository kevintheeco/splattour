// Street View style look controls: grab-drag to rotate with inertia,
// wheel/pinch to zoom (FOV), arrow keys, and optional device orientation.
import * as THREE from "three";

const DEG = Math.PI / 180;

export class LookControls extends EventTarget {
  constructor(camera, dom) {
    super();
    this.camera = camera;
    this.dom = dom;
    this.yaw = 0; // radians, 0 = looking toward -Z
    this.pitch = 0;
    this.fov = 70;
    this.minFov = 30;
    this.maxFov = 95;
    this.fovKick = 0; // added by the navigator while flying
    this.velYaw = 0;
    this.velPitch = 0;
    this.enabled = true;
    this.autoRotate = false;
    this.dragging = false;
    this.moved = 0; // pixels moved during the current press (click vs drag)
    this.pointers = new Map();
    this.pinchStart = 0;
    this.keys = new Set();
    this._euler = new THREE.Euler(0, 0, 0, "YXZ");
    this._bind();
  }

  set(yaw, pitch = this.pitch) {
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, -85 * DEG, 85 * DEG);
    this.velYaw = this.velPitch = 0;
  }

  // Radians of view rotation per dragged pixel, so content tracks the cursor.
  _radPerPx() {
    return (this.fov * DEG) / this.dom.clientHeight;
  }

  _bind() {
    const el = this.dom;
    el.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.dragging = true;
        this.moved = 0;
        this.velYaw = this.velPitch = 0;
        this.dispatchEvent(new Event("interact"));
      } else if (this.pointers.size === 2) {
        this.pinchStart = this._pinchDist();
        this.pinchFov = this.fov;
      }
    });
    el.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p || !this.enabled) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 2) {
        const d = this._pinchDist();
        if (this.pinchStart > 0) this.setFov(this.pinchFov * (this.pinchStart / d));
        return;
      }
      this.moved += Math.abs(dx) + Math.abs(dy);
      const k = this._radPerPx();
      this.yaw += dx * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, -85 * DEG, 85 * DEG);
      // Velocity in rad per frame at ~60fps, low-pass filtered for smooth fling.
      this.velYaw = this.velYaw * 0.5 + dx * k * 0.5;
      this.velPitch = this.velPitch * 0.5 + dy * k * 0.5;
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.dragging = false;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.setFov(this.fov * Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.key);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key));
    window.addEventListener("blur", () => this.keys.clear());
  }

  _pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  setFov(f) {
    this.fov = THREE.MathUtils.clamp(f, this.minFov, this.maxFov);
  }

  update(dt) {
    if (!this.dragging) {
      // Inertia: exponential decay, framerate independent.
      const decay = Math.pow(0.0025, dt);
      this.yaw += this.velYaw * dt * 60;
      this.pitch = THREE.MathUtils.clamp(this.pitch + this.velPitch * dt * 60, -85 * DEG, 85 * DEG);
      this.velYaw *= decay;
      this.velPitch *= decay;
      if (Math.abs(this.velYaw) < 1e-5) this.velYaw = 0;
      if (Math.abs(this.velPitch) < 1e-5) this.velPitch = 0;
    }
    if (this.enabled) {
      const s = 1.6 * dt;
      if (this.keys.has("ArrowLeft") || this.keys.has("a")) this.yaw += s;
      if (this.keys.has("ArrowRight") || this.keys.has("d")) this.yaw -= s;
      if (this.keys.has("PageUp")) this.pitch = Math.min(this.pitch + s, 85 * DEG);
      if (this.keys.has("PageDown")) this.pitch = Math.max(this.pitch - s, -85 * DEG);
      if (this.keys.has("+") || this.keys.has("=")) this.setFov(this.fov * Math.exp(-dt));
      if (this.keys.has("-")) this.setFov(this.fov * Math.exp(dt));
    }
    if (this.autoRotate && !this.dragging) this.yaw += 0.06 * dt;

    this._euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this._euler);
    const fov = this.fov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// Yaw of a horizontal direction under our convention (yaw 0 looks at -Z).
export function yawOf(dir) {
  return Math.atan2(-dir.x, -dir.z);
}
