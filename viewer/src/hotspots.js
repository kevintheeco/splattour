// Floor markers for neighbouring viewpoints plus the Street View style
// cursor disc that follows the pointer across the floor.
import * as THREE from "three";

function ringTexture() {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  const r = s / 2;
  // soft shadow
  const grad = g.createRadialGradient(r, r, r * 0.55, r, r, r);
  grad.addColorStop(0, "rgba(0,0,0,0.0)");
  grad.addColorStop(0.7, "rgba(0,0,0,0.28)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  // ring
  g.lineWidth = s * 0.06;
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.beginPath();
  g.arc(r, r, r * 0.72, 0, Math.PI * 2);
  g.stroke();
  // inner fill
  g.fillStyle = "rgba(255,255,255,0.18)";
  g.beginPath();
  g.arc(r, r, r * 0.66, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function chevronTexture() {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.lineCap = "round";
  g.lineJoin = "round";
  g.shadowColor = "rgba(0,0,0,0.45)";
  g.shadowBlur = 14;
  g.strokeStyle = "rgba(255,255,255,0.96)";
  g.lineWidth = 26;
  g.beginPath();
  g.moveTo(s * 0.24, s * 0.66);
  g.lineTo(s * 0.5, s * 0.36);
  g.lineTo(s * 0.76, s * 0.66);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const flatMaterial = (map) =>
  new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

export class Hotspots {
  constructor({ scene, camera, rig, tour, labelLayer }) {
    this.scene = scene;
    this.camera = camera;
    this.rig = rig;
    this.tour = tour;
    this.labelLayer = labelLayer;
    this.group = new THREE.Group();
    this.group.renderOrder = 10;
    scene.add(this.group);
    this.ringTex = ringTexture();
    this.chevTex = chevronTexture();
    this.markers = [];
    this.hovered = null;
    this.visible = true;

    // Cursor disc
    this.cursor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flatMaterial(this.ringTex));
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.renderOrder = 12;
    this.cursor.visible = false;
    scene.add(this.cursor);
    this.cursorTarget = null; // { node | point }
  }

  // Rebuild markers for the neighbours of `node`.
  show(node) {
    this.clear();
    if (!node) return;
    for (const n of this.tour.neighbors(node)) {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flatMaterial(this.ringTex));
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 10;
      const chev = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flatMaterial(this.chevTex));
      chev.rotation.x = -Math.PI / 2;
      chev.renderOrder = 11;
      chev.scale.setScalar(0.62);
      g.add(ring, chev);
      g.position.set(n.position.x, n.floorY + 0.02, n.position.z);
      // Chevron points from here toward the neighbour.
      const dir = new THREE.Vector3().subVectors(n.position, node.position);
      chev.rotation.z = Math.atan2(-dir.x, -dir.z);
      g.userData.node = n;
      this.group.add(g);

      // Street View style arrow on the floor ring around the viewer.
      const arrow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flatMaterial(this.chevTex));
      arrow.rotation.x = -Math.PI / 2;
      arrow.rotation.z = chev.rotation.z;
      arrow.renderOrder = 11;
      arrow.userData.dir = dir.clone().setY(0).normalize();
      this.group.add(arrow);

      const label = document.createElement("button");
      label.className = "hs-label";
      label.textContent = n.name;
      label.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onPick?.(n);
      });
      this.labelLayer.appendChild(label);
      this.markers.push({ node: n, group: g, ring, chev, arrow, label, hover: 0 });
    }
  }

  clear() {
    for (const m of this.markers) {
      this.group.remove(m.group, m.arrow);
      m.arrow.geometry.dispose();
      m.arrow.material.dispose();
      m.ring.geometry.dispose();
      m.chev.geometry.dispose();
      m.ring.material.dispose();
      m.chev.material.dispose();
      m.label.remove();
    }
    this.markers = [];
    this.hovered = null;
  }

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
    for (const m of this.markers) m.label.style.display = v ? "" : "none";
    if (!v) this.cursor.visible = false;
  }

  // Returns the marker under the pointer (screen-space test against the ring).
  pickMarker(ndc) {
    let best = null;
    let bestD = Infinity;
    const v = new THREE.Vector3();
    for (const m of this.markers) {
      v.copy(m.group.position).project(this.camera);
      if (v.z > 1) continue;
      // approximate ring radius in NDC by projecting an edge point
      const edge = m.group.position.clone().add(new THREE.Vector3(m.group.scale.x * 0.36, 0, 0)).project(this.camera);
      const rad = Math.max(0.035, Math.hypot(edge.x - v.x, edge.y - v.y) * 1.25);
      const d = Math.hypot((v.x - ndc.x) * this.camera.aspect, v.y - ndc.y);
      if (d < rad * this.camera.aspect && d < bestD) {
        best = m;
        bestD = d;
      }
      const a = m.arrow.position.clone().project(this.camera);
      if (a.z < 1) {
        const da = Math.hypot((a.x - ndc.x) * this.camera.aspect, a.y - ndc.y);
        if (da < 0.09 && da < bestD) {
          best = m;
          bestD = da;
        }
      }
    }
    return best;
  }

  setCursor(hit) {
    this.cursorTarget = hit;
    if (!hit || !this.visible) {
      this.cursor.visible = false;
      return;
    }
    this.cursor.visible = true;
    this.cursor.position.copy(hit.point);
    this.cursor.position.y += 0.02;
    const d = hit.point.distanceTo(this.rig.position);
    this.cursor.scale.setScalar(THREE.MathUtils.clamp(0.28 + d * 0.06, 0.35, 0.9));
    this.cursor.material.opacity = hit.snapped || hit.free ? 0.95 : hit.none ? 0.25 : 0.6;
  }

  update(dt, hoveredMarker) {
    this.hovered = hoveredMarker;
    const v = new THREE.Vector3();
    const w = this.labelLayer.clientWidth;
    const h = this.labelLayer.clientHeight;
    for (const m of this.markers) {
      const target = m === hoveredMarker ? 1 : 0;
      m.hover += (target - m.hover) * Math.min(1, dt * 12);
      const d = m.group.position.distanceTo(this.rig.position);
      // Keep markers readable: grow slowly with distance, pulse on hover.
      const s = THREE.MathUtils.clamp(0.45 + d * 0.05, 0.5, 1.1) * (1 + m.hover * 0.18);
      m.group.scale.setScalar(s);
      // Arrow sits 2m ahead in the neighbour's direction, on the floor.
      m.arrow.position.set(
        this.rig.position.x + m.arrow.userData.dir.x * 2.0,
        m.group.position.y,
        this.rig.position.z + m.arrow.userData.dir.z * 2.0,
      );
      m.arrow.scale.setScalar(0.62 * (1 + m.hover * 0.25));
      m.arrow.material.opacity = 0.75 + m.hover * 0.25;
      const fade = THREE.MathUtils.clamp(1.3 - d / 14, 0.25, 1);
      m.ring.material.opacity = fade;
      m.chev.material.opacity = fade;

      v.copy(m.group.position).project(this.camera);
      const onScreen = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      m.label.style.display = onScreen && this.visible ? "" : "none";
      if (onScreen) {
        const x = (v.x * 0.5 + 0.5) * w;
        const y = (-v.y * 0.5 + 0.5) * h;
        m.label.style.transform = `translate(-50%, 14px) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        m.label.style.opacity = String(Math.min(1, fade + m.hover));
        m.label.classList.toggle("hover", m === hoveredMarker);
      }
    }
  }
}
