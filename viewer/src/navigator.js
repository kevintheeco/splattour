// Moves the viewer between viewpoints. In "splat" mode the viewer walks
// through the reconstructed space at eye height and walking pace, around
// furniture (see walk.js), or flies along the tour graph (?move=fly); in
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
    this.speed = 2.3; // flight cruise, m/s (?speed= overrides, for the user study)
    this.walkSpeed = 1.2; // an unhurried adult walk (museum pace), m/s (?walk= overrides)
    this.planner = null; // (from, to) => walking waypoints or null; set when walking is on
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
    const walk = this.planner?.(this.rig.position, target.position);
    if (walk) return this._fly(walk, target, { ...opts, walk: true });
    let route = from ? this.tour.path(from, target) : null;
    if (!route) route = [from, target].filter(Boolean);
    const points = route.map((n) => n.position.clone());
    points[0] = this.rig.position.clone();
    return this._fly(points, target, opts);
  }

  // Free move to an arbitrary point (novel viewpoint, 3DGS only). Walks when
  // a planner is set, unless `fly` (e.g. matching a photo's exact pose).
  goToPoint(point, opts = {}) {
    if (this.flight) this._settle();
    if (this.planner && !opts.fly) {
      const walk = this.planner(this.rig.position, point);
      if (!walk) return false;
      return this._fly(walk, null, { ...opts, walk: true, duration: undefined });
    }
    return this._fly([this.rig.position.clone(), point.clone()], null, opts);
  }

  // Stop wherever we are (the user took over with the keyboard).
  stop() {
    this._settle();
    this.settle = null;
    this.speedNow = 0;
    this.current = null;
  }

  _fly(points, targetNode, { duration, keepHeading = false, lookAt = null, yaw = null, pitch = null, walk = false } = {}) {
    const length = points.reduce((s, p, i) => (i ? s + p.distanceTo(points[i - 1]) : 0), 0);
    if (length < 0.05) {
      if (targetNode) this._arrive(targetNode);
      return false;
    }
    const curve =
      points.length > 2
        ? new THREE.CatmullRomCurve3(points, false, "centripetal", walk ? 0.25 : 0.5)
        : new THREE.LineCurve3(points[0], points[1]);
    // Walking: constant pace with a short start and stop, like a person
    // (trapezoid speed profile). Flying: cruise at `speed`, but keep short hops
    // from feeling abrupt and long routes from dragging on.
    let profile = null;
    let T;
    if (walk) {
      profile = walkProfile(length, this.walkSpeed, 1.2);
      T = profile.T;
    } else T = duration ?? THREE.MathUtils.clamp(0.55 + length / this.speed, 0.9, 5.5);

    const startYaw = this.look.yaw;
    const startPitch = this.look.pitch;
    const endTangent = curve.getTangentAt(1);
    let endYaw = yawOf(endTangent);
    // If the move is mostly sideways/backwards relative to where we look,
    // keep the current heading instead of spinning the view around.
    // (A walker simply turns around, so this applies to flights only.)
    const turn = walk ? 0 : Math.abs(wrapAngle(endYaw - startYaw));
    if (keepHeading || turn > (110 * Math.PI) / 180) endYaw = startYaw;
    // Don't arrive staring into a wall: turn toward open space if needed.
    // If the travel direction is blocked, look where the photographer looked
    // at that spot: the capture view is guaranteed to face real content.
    // (A walker keeps facing the way they walked: no automatic turn.)
    if (this.headingFn && !walk && !keepHeading && !lookAt && yaw === null) {
      const end = points[points.length - 1];
      let h = this.headingFn(end, endYaw);
      if (targetNode && targetNode.yaw !== undefined && Math.abs(wrapAngle(h - endYaw)) > 0.3) h = this.headingFn(end, targetNode.yaw);
      endYaw = startYaw + wrapAngle(h - startYaw);
    }
    // A walker looks roughly ahead, slightly down.
    let endPitch = walk ? THREE.MathUtils.clamp(startPitch * 0.3 - 0.05, -0.2, 0.05) : THREE.MathUtils.clamp(startPitch * 0.5 - 0.1, -0.3, 0.1);
    // "다가가 보기": arrive facing the object that was double-clicked.
    if (lookAt) {
      const d = new THREE.Vector3().subVectors(lookAt, points[points.length - 1]);
      endYaw = startYaw + wrapAngle(yawOf(d) - startYaw);
      endPitch = THREE.MathUtils.clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), walk ? -0.5 : -1.2, walk ? 0.5 : 1.2);
    }

    // Exact arrival view (e.g. the pose a source photo was taken from).
    if (yaw !== null) endYaw = startYaw + wrapAngle(yaw - startYaw);
    if (pitch !== null) endPitch = pitch;

    this.settle = null;
    this.flight = { curve, T, t: 0, startYaw, startPitch, endYaw, endPitch, turn, targetNode, length, profile };
    this.look.velYaw = this.look.velPitch = 0;
    this.dispatchEvent(new CustomEvent("depart", { detail: { target: targetNode, length, duration: T } }));
    return true;
  }

  update(dt) {
    const st = this.settle;
    if (st && !this.flight) {
      // finish the turn onto the arrival heading smoothly (same spring and cap as in flight)
      if (this.look.dragging) { this.settle = null; return; }
      const w = st.walk ? 3.5 : 5.5, cap = ((st.walk ? 70 : 110) * Math.PI) / 180;
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
    // held at a closed door whose other side is still loading (app/portals.js)
    if (this.hold) { this.speedNow = 0; return; }
    f.lastDt = dt;
    f.t = Math.min(f.t + dt / f.T, 1);
    let u;
    if (f.profile) {
      const [s, v] = f.profile.at(f.t * f.T);
      u = Math.min(1, s / f.length);
      this.speedNow = v;
    } else {
      u = smootherstep(f.t);
      // metres per second right now (derivative of smootherstep), for the comfort vignette
      this.speedNow = (30 * f.t * f.t * (1 - f.t) * (1 - f.t) * f.length) / f.T;
    }
    f.u = u; // progress along the route (doors ahead, see app/appmode.js)
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
        const ahead = Math.min(1, u + (f.profile ? 2.2 : 1.6) / Math.max(f.length, 0.01));
        const d = f.curve.getPointAt(ahead).sub(this.rig.position);
        if (d.x * d.x + d.z * d.z > 1e-4) target = yawOf(d);
      }
      // lean toward the final heading as the flight goes on (no snap at the end)
      target = target + wrapAngle(f.endYaw - target) * THREE.MathUtils.smoothstep(f.t, 0.25, 0.85);
      target = f.hy + wrapAngle(target - f.hy);
      // spring stiffness (rad/s), critically damped; a walker turns more calmly
      const w = f.profile ? 3.5 : 5.5;
      f.hv += (w * w * (target - f.hy) - 2 * w * f.hv) * dt;
      const cap = ((f.profile ? 70 : 110) * Math.PI) / 180; // max turn rate while moving
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
    // Walking has none: eyes don't zoom when you walk.
    this.look.fovKick = f.profile ? 0 : Math.sin(Math.PI * f.t) * Math.min(1.5, 0.5 + f.length * 0.3);

    if (f.t >= 1) {
      if (f.hy !== undefined && !this.look.dragging) this.settle = { hy: f.hy, hv: f.hv, endYaw: f.endYaw, t: 0, walk: !!f.profile };
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

// Distance and speed over time for a walk of `L` metres at pace `v`. Speed
// eases up and down along a half cosine over `ta` seconds (no jolt at the
// start or end; peak acceleration v·π/2ta). Short walks never reach full pace.
function walkProfile(L, v, ta) {
  v = Math.min(v, L / ta);
  const ramp = (t) => [v * (t - (ta / Math.PI) * Math.sin((Math.PI * t) / ta)) / 2, (v * (1 - Math.cos((Math.PI * t) / ta))) / 2];
  const T = L / v + ta;
  return {
    T,
    at(t) {
      if (t < ta) return ramp(t);
      if (t < T - ta) return [(v * ta) / 2 + v * (t - ta), v];
      const [s, sp] = ramp(Math.max(0, T - t));
      return [L - s, sp];
    },
  };
}
