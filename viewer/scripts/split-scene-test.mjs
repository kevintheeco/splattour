// TEST DATA ONLY: cut one 3DGS scene into two "room models" along a door
// plane, so the portal path (a room captured as its own splat model) can be
// exercised before real per-room models exist. Both halves keep the source
// scene's frame (same splatTransform), so they line up in the space frame.
// Each half keeps `overlap` metres past the plane: the viewer must hide the
// doubled part itself (room regions in nav.json), which this makes visible.
//
//   node scripts/split-scene-test.mjs drjohnson 2.079,-2.868 -63.1 parlour dining [overlap=1]
//     -> scenes/drjohnson-split-parlour/ (behind the door), scenes/drjohnson-split-dining/ (in front)
// "in front" = the side the door yaw faces (yaw 0 = -Z, + = turning left).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [scene, center, yawDeg, backName, frontName, overlapArg = "1"] = process.argv.slice(2);
if (!frontName) { console.error("usage: split-scene-test.mjs <scene> x,z yawDeg backName frontName [overlap]"); process.exit(1); }
const root = path.resolve(import.meta.dirname, "../../scenes");
const src = path.join(root, scene);
const tour = JSON.parse(fs.readFileSync(path.join(src, "tour.json"), "utf8"));
const [cx, cz] = center.split(",").map(Number);
const yaw = (+yawDeg * Math.PI) / 180;
const nx = -Math.sin(yaw), nz = -Math.cos(yaw);
const overlap = +overlapArg;

// world = t + s * R(q) * local
const T = tour.splatTransform || {};
const [px, py, pz] = T.position || [0, 0, 0];
const [qx, qy, qz, qw] = T.quaternion || [0, 0, 0, 1];
const s = T.scale ?? 1;
const rot = (x, y, z) => {
  // v' = q v q*
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
};

const buf = fs.readFileSync(path.join(src, "scene.ply"));
const hEnd = buf.indexOf("end_header\n") + "end_header\n".length;
const header = buf.subarray(0, hEnd).toString("latin1");
const count = +header.match(/element vertex (\d+)/)[1];
const props = [...header.matchAll(/property float (\w+)/g)].map((m) => m[1]);
const stride = props.length * 4;
const [ix, iy, iz] = ["x", "y", "z"].map((p) => props.indexOf(p) * 4);
const sides = { back: [], front: [] };
for (let i = 0; i < count; i++) {
  const o = hEnd + i * stride;
  const [x, y, z] = rot(buf.readFloatLE(o + ix), buf.readFloatLE(o + iy), buf.readFloatLE(o + iz));
  const d = (px + s * x - cx) * nx + (pz + s * z - cz) * nz;
  if (d < overlap) sides.back.push(i);
  if (d > -overlap) sides.front.push(i);
}
for (const [side, name] of [["back", backName], ["front", frontName]]) {
  const idx = sides[side];
  const dir = path.join(root, `${scene}-split-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = Buffer.alloc(idx.length * stride);
  idx.forEach((i, k) => buf.copy(out, k * stride, hEnd + i * stride, hEnd + (i + 1) * stride));
  const ply = path.join(dir, "scene.ply");
  fs.writeFileSync(ply, Buffer.concat([Buffer.from(header.replace(/element vertex \d+/, `element vertex ${idx.length}`), "latin1"), out]));
  execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../node_modules/@playcanvas/splat-transform/bin/cli.mjs"), "-w", "-q", "--spz-version", "3", ply, path.join(dir, "scene.spz")], { stdio: "inherit" });
  fs.rmSync(ply);
  const t = { ...tour, title: `${tour.title} (분할 테스트: ${name})`, subtitle: "TEST: 방별 모델 포털 검증용으로 한 장면을 문에서 잘랐다", splat: "scene.spz", bytes: {}, testSplit: { from: scene, side, door: { center: [cx, cz], yawDeg: +yawDeg }, overlap } };
  delete t.splatMobile; delete t.lod;
  fs.writeFileSync(path.join(dir, "tour.json"), JSON.stringify(t, null, 1));
  console.log(`${dir}: ${idx.length} of ${count} splats`);
}
