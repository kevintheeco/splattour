// Placing a room captured as its own 3DGS model into the space's world frame.
// nav.json gives the room a similarity transform (rooms[].sceneTransform:
// {scale, quaternion [x, y, z, w] | yawDeg, position}) that maps the room
// model's viewer world (its tour.json frame) onto the space's (e.g. 월하정
// 사랑방 -> the courtyard model), and the room's floor height in the space
// (rooms[].floorY). The scene files stay as published; the viewer applies it
// on load to the splat, the capture points and the walls grid (and
// scripts/space-from-scene.mjs, scripts/bake-plan.mjs do the same).
import * as THREE from "three";

export function placeMatrix(xf) {
  if (!xf) return null;
  const q = xf.quaternion
    ? new THREE.Quaternion().fromArray(xf.quaternion).normalize()
    : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((xf.yawDeg || 0) * Math.PI) / 180);
  const s = xf.scale ?? 1;
  return new THREE.Matrix4().compose(new THREE.Vector3().fromArray(xf.position || [0, 0, 0]), q, new THREE.Vector3(s, s, s));
}

// mesh (already carrying its own splatTransform) -> placed in the space
export function placeMesh(mesh, xf) {
  const M = placeMatrix(xf);
  if (!M) return;
  mesh.updateMatrix();
  M.multiply(mesh.matrix).decompose(mesh.position, mesh.quaternion, mesh.scale);
  mesh.updateMatrixWorld(true);
}

// capture points of the room's tour (viewer/src/tour.js nodes), in place; eyes at floorY + eye height
export function placeTour(tour, xf, floorY = null) {
  const M = placeMatrix(xf);
  if (!M) return;
  const yaw = xf.quaternion ? new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(xf.quaternion), "YXZ").y : ((xf.yawDeg || 0) * Math.PI) / 180;
  for (const n of tour.nodes) {
    n.position.applyMatrix4(M);
    if (Number.isFinite(floorY)) { n.floorY = floorY; n.position.y = floorY + tour.eyeHeight; }
    n.yaw = (n.yaw ?? 0) + yaw;
  }
}

// the room's walls grid seen in the space frame (read-only view for merging)
export function placeOccupancy(occ, xf) {
  const M = placeMatrix(xf);
  if (!M) return occ;
  const inv = M.clone().invert();
  const box = occ.box.clone().applyMatrix4(M);
  const q = new THREE.Vector3();
  return { voxel: occ.voxel * (xf.scale ?? 1), box, occupied: (p) => occ.occupied(q.copy(p).applyMatrix4(inv)) };
}
