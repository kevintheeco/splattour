// Moves the viewer between viewpoints. In "splat" mode the camera flies
// continuously through the reconstructed space along the tour graph; in
// "pano" mode (the baseline for the user study) it cross-fades between
// static 360 panoramas the way conventional virtual tours do.
import * as THREE from "three";
import { wrapAngle, yawOf } from "./look.js";

const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export class Navigator extends EventTarget {
  constructor({ tour, rig, look }) {
    super();
    this.tour = tour;
    this.rig = rig;
    this.look = look;
    this.current = null;
    this.flight = null;
    this.speed = 2.3; // metres per second at cruise (?speed= overrides, for the user study)
    this.speedNow = 0;
  }

  get busy() {
    return !!this.flight;
  }

  // flying, or still finishing the arrival turn
  get moving() {
    return !!(this.flight || this.settle);
  }

  jumpTo(node, { yaw = node.yaw, pitch = node.pitch } = {}) {
    this.flight = null;
    this.rig.position.copy(node.position);
    this.look.set(yaw, pitch);
    this._arrive(node);
  }

  // Fly to `target`, routing through the graph when possible.
  goTo(target, opts = {}) {
    if (!target || target === this.current) return false;
    if (this.flight) this._settle();
    const from = this.current;
    let route = from ? this.tour.path(from, target) : null;
    if (!route) route = [from, target].filter(Boolean);
    const points = route.map((n) => n.position.clone());
    points[0] = this.rig.position.clone();
    return this._fly(points, target, opts);
  }

  // Free move to an arbitrary point (novel viewpoint, 3DGS only).
  goToPoint(point, opts = {}) {
    if (this.flight) this._settle();
    return this._fly([this.rig.position.clone(), point.clone()], null, opts);
  }

  _fly(points, targetNode, { duration, keepHeading = false, lookAt = null, yaw = null, pitch = null } = {}) {
    const length = points.reduce((s, p, i) => (i ? s + p.distanceTo(points[i - 1]) : 0), 0);
    if (length < 0.05) {
      if (targetNode) this._arrive(targetNode);
      return false;
    }
    const curve =
      points.length > 2
        ? new THREE.CatmullRomCurve3(points, false, "centripetal", 0.5)
        : new THREE.LineCurve3(points[0], points[1]);
    // Cruise at `speed`, but keep short hops from feeling abrupt and long
    // routes from dragging on.
    const T = duration ?? THREE.MathUtils.clamp(0.55 + length / this.speed, 0.9, 5.5);

    const startYaw = this.look.yaw;
    const startPitch = this.look.pitch;
    const endTangent = curve.getTangentAt(1);
    let endYaw = yawOf(endTangent);
    // If the move is mostly sideways/backwards relative to where we look,
    // keep the current heading instead of spinning the view around.
    const turn = Math.abs(wrapAngle(endYaw - startYaw));
    if (keepHeading || turn > (110 * Math.PI) / 180) endYaw = startYaw;
    // Don't arrive staring into a wall: turn toward open space if needed.
    // If the travel direction is blocked, look where the photographer looked
    // at that spot: the capture view is guaranteed to face real content.
    if (this.headingFn && !keepHeading && !lookAt && yaw === null) {
      const end = points[points.length - 1];
      let h = this.headingFn(end, endYaw);
      if (targetNode && targetNode.yaw !== undefined && Math.abs(wrapAngle(h - endYaw)) > 0.3) h = this.headingFn(end, targetNode.yaw);
      endYaw = startYaw + wrapAngle(h - startYaw);
    }
    let endPitch = THREE.MathUtils.clamp(startPitch * 0.5 - 0.1, -0.3, 0.1);
    // "다가가 보기": arrive facing the object that was double-clicked.
    if (lookAt) {
      const d = new THREE.Vector3().subVectors(lookAt, points[points.length - 1]);
      endYaw = startYaw + wrapAngle(yawOf(d) - startYaw);
      endPitch = THREE.MathUtils.clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -1.2, 1.2);
    }

    // Exact arrival view (e.g. the pose a source photo was taken from).
    if (yaw !== null) endYaw = startYaw + wrapAngle(yaw - startYaw);
    if (pitch !== null) endPitch = pitch;

    this.settle = null;
    this.flight = { curve, T, t: 0, startYaw, startPitch, endYaw, endPitch, turn, targetNode, length };
    this.look.velYaw = this.look.velPitch = 0;
    this.dispatchEvent(new CustomEvent("depart", { detail: { target: targetNode, length, duration: T } }));
    return true;
  }

  update(dt) {
    const st = this.settle;
    if (st && !this.flight) {
      // finish the turn onto the arrival heading smoothly (same spring and cap as in flight)
      if (this.look.dragging) { this.settle = null; return; }
      const w = 5.5, cap = (110 * Math.PI) / 180;
      const target = st.hy + wrapAngle(st.endYaw - st.hy);
      st.hv = THREE.MathUtils.clamp(st.hv + (w * w * (target - st.hy) - 2 * w * st.hv) * dt, -cap, cap);
      st.hy += st.hv * dt;
      st.t += dt;
      this.look.yaw = st.hy;
      if ((Math.abs(target - st.hy) < 0.003 && Math.abs(st.hv) < 0.02) || st.t > 1.5) { this.look.yaw = target; this.settle = null; }
      return;
    }
    const f = this.flight;
    if (!f) return;
    f.lastDt = dt;
    f.t = Math.min(f.t + dt / f.T, 1);
    const u = smootherstep(f.t);
    // metres per second right now (derivative of smootherstep), for the comfort vignette
    this.speedNow = (30 * f.t * f.t * (1 - f.t) * (1 - f.t) * f.length) / f.T;
    this.rig.position.copy(f.curve.getPointAt(u));

    // Heading: look where the path goes (a point ~1.6 m ahead, so corners are
    // anticipated instead of snapped to), follow it through a critically damped
    // spring with a turn-rate cap, and blend onto the exact final heading at the
    // end. Measured before this (scripts/motion-check.mjs): peaks of 400-770°/s
    // and 3-4 left/right swings on multi-hop routes; now one smooth turn.
    if (!this.look.dragging) {
      if (f.hy === undefined) { f.hy = this.look.yaw; f.hv = 0; }
      const dt = f.lastDt || 1 / 60;
      let target = f.startYaw;
      if (f.turn <= (110 * Math.PI) / 180) {
        const ahead = Math.min(1, u + 1.6 / Math.max(f.length, 0.01));
        const d = f.curve.getPointAt(ahead).sub(this.rig.position);
        if (d.x * d.x + d.z * d.z > 1e-4) target = yawOf(d);
      }
      // lean toward the final heading as the flight goes on (no snap at the end)
      target = target + wrapAngle(f.endYaw - target) * THREE.MathUtils.smoothstep(f.t, 0.25, 0.85);
      target = f.hy + wrapAngle(target - f.hy);
      const w = 5.5; // spring stiffness (rad/s); critically damped
      f.hv += (w * w * (target - f.hy) - 2 * w * f.hv) * dt;
      const cap = (110 * Math.PI) / 180; // max 110°/s while moving
      f.hv = THREE.MathUtils.clamp(f.hv, -cap, cap);
      f.hy += f.hv * dt;
      this.look.yaw = f.hy;
      this.look.pitch = THREE.MathUtils.lerp(f.startPitch, f.endPitch, THREE.MathUtils.smoothstep(f.t, 0, 0.8));
    } else if (f.hy !== undefined) {
      // the user is looking around mid-flight: continue from where they leave the view (no jump back)
      f.hy = this.look.yaw; f.hv = 0;
    }
    // A very slight FOV widening at cruise conveys forward motion (was up to 6°,
    // read as the view "breathing"; capped at 1.5°).
    this.look.fovKick = Math.sin(Math.PI * f.t) * Math.min(1.5, 0.5 + f.length * 0.3);

    if (f.t >= 1) {
      if (f.hy !== undefined && !this.look.dragging) this.settle = { hy: f.hy, hv: f.hv, endYaw: f.endYaw, t: 0 };
      this.flight = null;
      this.look.fovKick = 0;
      if (f.targetNode) this._arrive(f.targetNode);
      else {
        this.current = null;
        this.dispatchEvent(new CustomEvent("arrive", { detail: { node: null } }));
      }
    }
  }

  _settle() {
    const f = this.flight;
    this.flight = null;
    this.look.fovKick = 0;
    if (f?.targetNode) this.current = null;
  }

  _arrive(node) {
    this.current = node;
    this.dispatchEvent(new CustomEvent("arrive", { detail: { node } }));
  }
}
