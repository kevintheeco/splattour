// Street View style look controls: grab-drag to rotate with inertia,
// wheel/pinch to zoom (FOV), ← → keys to turn (W A S D walk, see main.js).
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
    this.targetFov = 70; // zoom eases toward this (no stepping on each wheel notch)
    this.zoomAnchor = null; // screen point (NDC) that stays under the cursor while zooming
    this.minFov = 20;
    this.maxFov = 95;
    this.fovKick = 0; // added by the navigator while flying
    this.roll = 0; // camera tilt, only set when matching a photo's pose; eases out once the user drags
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
        this.pinchFov = this.targetFov;
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
        const [a, b] = [...this.pointers.values()];
        if (this.pinchStart > 0) this.zoomAt(this.pinchFov * (this.pinchStart / d), (a.x + b.x) / 2, (a.y + b.y) / 2);
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
        // Trackpads send many small deltas, mouse wheels a few large ones; both feel the same.
        this.zoomAt(this.targetFov * Math.exp(THREE.MathUtils.clamp(e.deltaY, -120, 120) * 0.0016), e.clientX, e.clientY);
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

  // Set the zoom immediately (tour jumps, resets).
  setFov(f) {
    this.fov = this.targetFov = THREE.MathUtils.clamp(f, this.minFov, this.maxFov);
    this.zoomAnchor = null;
  }

  // Zoom toward a screen point, the way maps do: what is under the cursor
  // stays under the cursor while the view narrows onto it.
  zoomAt(f, clientX, clientY) {
    this.targetFov = THREE.MathUtils.clamp(f, this.minFov, this.maxFov);
    const r = this.dom.getBoundingClientRect();
    this.zoomAnchor = clientX === undefined ? null : {
      x: ((clientX - r.left) / r.width) * 2 - 1,
      y: -(((clientY - r.top) / r.height) * 2 - 1),
      aspect: r.width / r.height,
    };
    // the world direction under the cursor right now; zooming keeps it there
    if (this.zoomAnchor) this.zoomAnchor.world = this._dirAt(this.zoomAnchor, this.yaw, this.pitch, this.fov);
  }

  _dirAt(a, yaw, pitch, fov) {
    const t = Math.tan((fov * DEG) / 2);
    this._euler.set(pitch, yaw, 0, "YXZ");
    return new THREE.Vector3(a.x * t * a.aspect, a.y * t, -1).normalize().applyEuler(this._euler);
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
      if (this.keys.has("ArrowLeft")) this.yaw += s;
      if (this.keys.has("ArrowRight")) this.yaw -= s;
      if (this.keys.has("PageUp")) this.pitch = Math.min(this.pitch + s, 85 * DEG);
      if (this.keys.has("PageDown")) this.pitch = Math.max(this.pitch - s, -85 * DEG);
      if (this.keys.has("+") || this.keys.has("=")) this.zoomAt(this.targetFov * Math.exp(-dt));
      if (this.keys.has("-")) this.zoomAt(this.targetFov * Math.exp(dt));
    }
    // Ease the zoom (critically damped feel, framerate independent) and keep
    // the anchor point fixed on screen by turning the view as it narrows.
    if (Math.abs(this.targetFov - this.fov) > 1e-3) {
      const f0 = this.fov;
      const f1 = f0 + (this.targetFov - f0) * (1 - Math.exp(-dt * 14));
      if (this.zoomAnchor && !this.dragging) {
        // Solve yaw/pitch so the remembered world direction sits exactly
        // under the anchor pixel at the new fov (converges in a few steps).
        const W = this.zoomAnchor.world;
        const azW = Math.atan2(-W.x, -W.z), elW = Math.asin(THREE.MathUtils.clamp(W.y, -1, 1));
        for (let i = 0; i < 4; i++) {
          const d = this._dirAt(this.zoomAnchor, this.yaw, this.pitch, f1);
          this.yaw += wrapAngle(azW - Math.atan2(-d.x, -d.z));
          this.pitch = THREE.MathUtils.clamp(this.pitch + elW - Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), -85 * DEG, 85 * DEG);
        }
      }
      this.fov = f1;
    }
    if (this.autoRotate && !this.dragging) this.yaw += 0.06 * dt;

    if (this.roll && this.dragging) this.roll *= Math.pow(0.02, dt);
    this._euler.set(this.pitch, this.yaw, this.roll, "YXZ");
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
