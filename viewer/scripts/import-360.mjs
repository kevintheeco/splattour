// Bring real 360° captures into a space: equirectangular images (or frames of a
// 360 video) + where each was taken + which points connect + room names.
// Writes public/spaces/<space>/pano/<id>.jpg and a new nav.json (the old one is
// kept as nav.before-import.json). The 360° viewer, the 3DGS room names, the
// plan, the exploration range and the tasks all read that file.
//
// 1) Make a template listing the files:
//      node scripts/import-360.mjs <space> <folder>
//    -> <folder>/nodes.csv  (one row per image; open it in Excel)
// 2) Fill in the rows (UTF-8 CSV):
//      id,file,time,room,x,z,yawDeg,neighbors
//      g1,IMG_0001.jpg,,대문,-3.5,5.0,0,g2
//      g2,VID_0002.mp4,00:00:12.5,진입로,-3.5,3.0,0,g1 y1
//    file     equirect image (2:1), or a 360 video + time (the frame to take)
//    room     room name (the same names are used in both conditions)
//    x, z     position in metres, in the 3DGS scene's coordinates (y up; a plan
//             drawn from the 3DGS scene: python -m splattour.floorplan <scene>)
//    yawDeg   direction the image centre faces (0 = scene -Z, + = turning left)
//    neighbors  ids reachable by a hotspot (space or ; separated; links are made both ways)
//    Empty x/z: points are laid on a line and flagged positionsApproximate.
// 3) Import:
//      node scripts/import-360.mjs <space> <folder> nodes.csv [--width 4096] [--start g1]
// Needs ffmpeg/ffprobe on PATH.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const width = +opt("--width", 4096);
const startOpt = opt("--start", "");
const [space, folder, csvName] = args;
if (!space || !folder) { console.log("usage: node scripts/import-360.mjs <space> <folder> [nodes.csv] [--width 4096] [--start <id>]"); process.exit(1); }
const spaceDir = path.resolve(import.meta.dirname, `../public/spaces/${space}`);
if (!fs.existsSync(spaceDir)) throw new Error(`no space ${spaceDir} (make listing.json first)`);
const MEDIA = /\.(jpe?g|png|webp|tiff?|mp4|mov|insv)$/i;
const VIDEO = /\.(mp4|mov|insv)$/i;

// ---------- 1) template ----------
if (!csvName) {
  const files = fs.readdirSync(folder).filter((f) => MEDIA.test(f)).sort();
  if (!files.length) throw new Error(`no images or videos in ${folder}`);
  const rows = ["id,file,time,room,x,z,yawDeg,neighbors", ...files.map((f, i) => `p${i + 1},${f},${VIDEO.test(f) ? "00:00:00" : ""},,,,0,${[i > 0 ? `p${i}` : "", i < files.length - 1 ? `p${i + 2}` : ""].join(" ").trim()}`)];
  const out = path.join(folder, "nodes.csv");
  if (fs.existsSync(out)) throw new Error(`${out} exists: fill it in and run again with it`);
  fs.writeFileSync(out, "﻿" + rows.join("\n") + "\n");
  console.log(`${files.length} files -> ${out}\nFill in room, x, z, yawDeg, neighbors, then:\n  node scripts/import-360.mjs ${space} "${folder}" nodes.csv`);
  process.exit(0);
}

// ---------- 2) read the table ----------
const text = fs.readFileSync(path.resolve(folder, csvName), "utf8").replace(/^﻿/, "");
const lines = text.split(/\r?\n/).filter((l) => l.trim());
const head = lines.shift().split(",").map((h) => h.trim());
const col = (r, k) => (r[head.indexOf(k)] ?? "").trim();
const rows = lines.map((l) => l.split(","));
const nodes = [];
const probs = [];
for (const [i, r] of rows.entries()) {
  const id = col(r, "id") || `p${i + 1}`;
  const file = col(r, "file");
  if (!/^[\w-]+$/.test(id)) probs.push(`row ${i + 2}: id "${id}" must be letters/digits/-/_`);
  if (!file || !fs.existsSync(path.join(folder, file))) probs.push(`row ${i + 2}: missing file "${file}"`);
  if (!col(r, "room")) probs.push(`row ${i + 2}: room is empty`);
  const x = col(r, "x"), z = col(r, "z");
  nodes.push({ id, file, time: col(r, "time"), roomName: col(r, "room"), x: x === "" ? null : +x, z: z === "" ? null : +z, yawDeg: +(col(r, "yawDeg") || 0), neighbors: col(r, "neighbors").split(/[\s;]+/).filter(Boolean) });
}
const ids = new Set(nodes.map((n) => n.id));
if (ids.size !== nodes.length) probs.push("duplicate ids");
for (const n of nodes) for (const m of n.neighbors) if (!ids.has(m)) probs.push(`${n.id}: neighbor "${m}" is not an id`);
if (probs.length) { console.error("Fix nodes.csv first:\n  " + probs.join("\n  ")); process.exit(1); }

// ---------- 3) images: resize to <width> x <width/2> (or take the video frame) ----------
const panoDir = path.join(spaceDir, "pano");
fs.mkdirSync(panoDir, { recursive: true });
for (const n of nodes) {
  const src = path.join(folder, n.file);
  const dst = path.join(panoDir, `${n.id}.jpg`);
  const pre = VIDEO.test(n.file) ? ["-ss", n.time || "0", "-i", src, "-frames:v", "1"] : ["-i", src];
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...pre, "-vf", `scale=${width}:${width / 2}:flags=lanczos`, "-q:v", "3", dst]);
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", VIDEO.test(n.file) ? dst : src]).toString().trim().split(",").map(Number);
  if (!VIDEO.test(n.file) && Math.abs(w / h - 2) > 0.02) console.warn(`  ! ${n.file} is ${w}x${h}, not 2:1 equirectangular`);
  process.stdout.write(`${n.id} `);
}
console.log();

// ---------- 4) nav.json ----------
const navPath = path.join(spaceDir, "nav.json");
const old = fs.existsSync(navPath) ? JSON.parse(fs.readFileSync(navPath, "utf8")) : {};
if (fs.existsSync(navPath)) fs.copyFileSync(navPath, path.join(spaceDir, "nav.before-import.json"));
// keep room ids that already exist (tasks.json refers to them), new names get new ids
const roomIds = new Map((old.rooms || []).map((r) => [r.name, r.id]));
let k = 1;
for (const n of nodes) if (!roomIds.has(n.roomName)) { while ([...roomIds.values()].includes(`room${k}`)) k++; roomIds.set(n.roomName, `room${k}`); }
const approx = nodes.some((n) => n.x === null || n.z === null);
nodes.forEach((n, i) => { if (n.x === null) n.x = i * 2; if (n.z === null) n.z = 0; });
const used = [...new Set(nodes.map((n) => n.roomName))];
const nav = {
  version: 1,
  about: old.about,
  status: {
    ready: true,
    devPlaceholder: false,
    source: `real 360 captures: ${path.basename(path.resolve(folder))}/${csvName}`,
    importedAt: new Date().toISOString(),
    ...(approx ? { positionsApproximate: true, note: "일부 지점에 위치(x, z)가 없어 일렬로 놓았다. 평면도·탐색 범위·방향 과제가 맞지 않으니 위치를 채워 다시 가져올 것." } : {}),
  },
  transition: old.transition || { style: "warp", duration: 0.8 },
  range: old.range || { radius: 2.0 },
  start: startOpt || (ids.has(old.start) ? old.start : nodes[0].id),
  rooms: used.map((name) => ({ id: roomIds.get(name), name })),
  nodes: nodes.map((n) => ({ id: n.id, room: roomIds.get(n.roomName), position: [n.x, 1.5, n.z], imageYawDeg: n.yawDeg, pano: `pano/${n.id}.jpg`, neighbors: n.neighbors })),
};
fs.writeFileSync(navPath, JSON.stringify(nav, null, 1));
const taskFile = path.join(spaceDir, "tasks.json");
if (fs.existsSync(taskFile)) {
  const t = JSON.parse(fs.readFileSync(taskFile, "utf8"));
  const roomSet = new Set(nav.rooms.map((r) => r.id));
  for (const task of t.tasks || []) {
    if (task.target && !roomSet.has(task.target)) console.warn(`  ! task ${task.id}: target room "${task.target}" is not in the new nav.json`);
    if (task.start && !ids.has(task.start)) console.warn(`  ! task ${task.id}: start point "${task.start}" is not in the new nav.json`);
  }
}
console.log(`nav.json: ${nodes.length} points, ${used.length} rooms (${used.join(", ")})${approx ? " — positions approximate" : ""}\nOpen /pano.html?space=${space} to check hotspot directions; fix yawDeg (or add "hotspots": [{"to": id, "yawDeg": .., "pitchDeg": ..}] to a node) where a disc points the wrong way.`);
