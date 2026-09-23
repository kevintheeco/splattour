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
    this.speed = 1.8; // metres per second at cruise
  }

  get busy() {
    return !!this.flight;
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

  _fly(points, targetNode, { duration, keepHeading = false } = {}) {
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
    if (this.headingFn) endYaw = startYaw + wrapAngle(this.headingFn(points[points.length - 1], endYaw) - startYaw);
    const endPitch = THREE.MathUtils.clamp(startPitch * 0.5 - 0.1, -0.3, 0.1);

    this.flight = { curve, T, t: 0, startYaw, startPitch, endYaw, endPitch, turn, targetNode, length };
    this.look.velYaw = this.look.velPitch = 0;
    this.dispatchEvent(new CustomEvent("depart", { detail: { target: targetNode, length, duration: T } }));
    return true;
  }

  update(dt) {
    const f = this.flight;
    if (!f) return;
    f.t = Math.min(f.t + dt / f.T, 1);
    const u = smootherstep(f.t);
    this.rig.position.copy(f.curve.getPointAt(u));

    // Heading: ease from the start heading toward the direction of travel,
    // then settle on the final heading. Users may still look around while
    // flying; their drag is applied on top as an offset.
    if (!this.look.dragging) {
      const travelYaw = f.turn > (110 * Math.PI) / 180 ? f.startYaw : yawOf(f.curve.getTangentAt(Math.min(u + 0.08, 1)));
      const a = THREE.MathUtils.smoothstep(f.t, 0, 0.45);
      const b = THREE.MathUtils.smoothstep(f.t, 0.6, 1);
      const mid = f.startYaw + wrapAngle(travelYaw - f.startYaw) * a;
      this.look.yaw = mid + wrapAngle(f.endYaw - mid) * b;
      this.look.pitch = THREE.MathUtils.lerp(f.startPitch, f.endPitch, THREE.MathUtils.smoothstep(f.t, 0, 0.7));
    }
    // A slight FOV widening at cruise speed conveys forward motion.
    this.look.fovKick = Math.sin(Math.PI * f.t) * Math.min(6, 2 + f.length * 1.2);

    if (f.t >= 1) {
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
