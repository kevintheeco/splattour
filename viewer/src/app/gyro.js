// Look around by moving the phone (device orientation), for both viewers.
// Relative: turning the phone turns the view by the same amount, so it
// composes with dragging and never jumps when switched on. Pitch follows
// the phone's tilt directly.
import * as THREE from "three";

const zee = new THREE.Vector3(0, 0, 1);
const qX = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° about X: camera looks out the back of the phone
const DEG = Math.PI / 180;

export class Gyro {
  static supported() { return typeof window !== "undefined" && "DeviceOrientationEvent" in window; }

  constructor(look) {
    this.look = look;
    this.on = false;
    this.o = null;
    this.prevYaw = null;
    this._q = new THREE.Quaternion();
    this._qs = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._f = new THREE.Vector3();
    this._h = (e) => { if (e.alpha != null) this.o = e; };
  }

  async enable() {
    const D = window.DeviceOrientationEvent;
    // iOS asks once, from a tap
    if (typeof D?.requestPermission === "function") {
      try { if ((await D.requestPermission()) !== "granted") return false; } catch { return false; }
    }
    window.addEventListener("deviceorientation", this._h);
    this.on = true;
    this.prevYaw = null;
    return true;
  }

  disable() {
    window.removeEventListener("deviceorientation", this._h);
    this.on = false;
    this.o = null;
  }

  update() {
    if (!this.on || !this.o) return;
    const { alpha, beta, gamma } = this.o;
    const orient = (screen.orientation?.angle ?? window.orientation ?? 0) * DEG;
    this._e.set(beta * DEG, alpha * DEG, -gamma * DEG, "YXZ");
    this._q.setFromEuler(this._e).multiply(qX).multiply(this._qs.setFromAxisAngle(zee, -orient));
    const f = this._f.set(0, 0, -1).applyQuaternion(this._q);
    const yaw = Math.atan2(-f.x, -f.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
    if (this.prevYaw !== null) {
      const d = Math.atan2(Math.sin(yaw - this.prevYaw), Math.cos(yaw - this.prevYaw));
      this.look.yaw += d;
    }
    this.prevYaw = yaw;
    this.look.pitch = THREE.MathUtils.clamp(pitch, -85 * DEG, 85 * DEG);
  }
}
