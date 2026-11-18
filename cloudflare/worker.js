// pochak.kr Worker. Static files are served by Workers static assets; this script
// runs only for /api/* (see run_worker_first in wrangler.jsonc).
//
// Port of web-api/api/web/[action].js (the Vercel function behind 3dgstour.com).
// Browsers upload straight to Cloudflare R2 with signed URLs; this only checks the
// password, signs, and writes the manifest the studio machine watches for
// (inbox/<id>/manifest.json).
//   GET  /api/web/config
//   POST /api/web/upload   {pw, title, quality, panorama, files:[{name,size}]}
//   POST /api/web/sign     {pw, id, items:[{key, uploadId|null, part|null}]}
//   POST /api/web/complete {pw, id, key, uploadId, parts:[{PartNumber, ETag}]}
//   POST /api/web/finish   {pw, id, title, quality, panorama, files:[{name,size,key}]}
import { AwsClient } from "aws4fetch";

const PART = 64 << 20; // multipart part size for large files
const BIG = 96 << 20; // files above this go multipart
const EXPIRES = 6 * 3600;
// Same numbers the live 3dgstour.com /api/web/config returned (2026-11-18).
const LIMITS = { maxFiles: 3000, maxFileGB: 30, maxTotalGB: 80, maxVideoMin: 30 };

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// trim: values pasted into the dashboard/CLI can carry stray spaces (caused a signature mismatch once)
const trimEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));

const safeName = (s) => String(s).normalize("NFC").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "file";
const okId = (id) => /^[0-9]{8}-[0-9a-f]{12}$/.test(id || "");
const inInbox = (id, key) => okId(id) && typeof key === "string" && key.startsWith(`inbox/${id}/files/`) && !key.includes("..");
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

function samePw(given, expected) {
  const enc = new TextEncoder();
  const x = enc.encode(String(given || "")), y = enc.encode(expected || "");
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

function storage(E) {
  const endpoint = `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${E.R2_BUCKET || "hanok360"}`;
  const client = new AwsClient({ accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const objUrl = (key) => `${endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async presign(key, query = {}) {
      const u = new URL(objUrl(key));
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      u.searchParams.set("X-Amz-Expires", String(EXPIRES));
      const signed = await client.sign(new Request(u, { method: "PUT" }), { aws: { signQuery: true } });
      return signed.url;
    },
    async s3(method, key, query = "", body) {
      const res = await client.fetch(objUrl(key) + query, { method, body });
      const text = await res.text();
      if (!res.ok) throw new Error(`storage ${method} ${res.status}: ${text.slice(0, 200)}`);
      return text;
    },
    async getJson(key) {
      const res = await client.fetch(objUrl(key));
      if (!res.ok) return null;
      try { return await res.json(); } catch { return null; }
    },
  };
}

// ---------- cloud runner (a RunPod GPU server that processes every pending upload, then removes itself) ----------
// Only used when RUNPOD_API_KEY and RUNNER_BUNDLE secrets are set. Without them uploads
// are stored and left for the studio machine ("laptop"), so no GPU money is spent.
const IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"; // same as pipeline/splattour/cloud.py
const GPU_TYPES = ["NVIDIA GeForce RTX 4090", "NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation", "NVIDIA RTX A6000",
  "NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB", "NVIDIA GeForce RTX 5090"];
const RUNNER_CMD = 'mkdir -p /workspace/st && curl -fsSL "$BUNDLE_URL" | tar xz -C /workspace/st && (bash /start.sh >/dev/null 2>&1 &) ; bash /workspace/st/runner/boot.sh';

async function setJob(st, id, fields) {
  const idx = (await st.getJson("jobs/index.json")) || { jobs: [] };
  const jobs = idx.jobs || [];
  let j = jobs.find((x) => x.id === id);
  if (!j) { j = { id }; jobs.unshift(j); }
  Object.assign(j, fields);
  await st.s3("PUT", "jobs/index.json", "", JSON.stringify({ jobs: jobs.slice(0, 40), at: Date.now() / 1000 }));
}

async function monthSpend(st) {
  const month = new Date().toISOString().slice(0, 7);
  const xml = await st.s3("GET", "", `?list-type=2&prefix=${encodeURIComponent(`cloud/ledger/${month}/`)}`).catch(() => "");
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  let sum = 0;
  for (const k of keys) sum += +((await st.getJson(k)) || {}).cost_usd || 0;
  return sum;
}

async function ensureRunner(E, st) {
  const hb = await st.getJson("cloud/active.json");
  if (hb && Date.now() / 1000 - hb.at < 300) return "running"; // a live server picks the new upload up
  const budget = +(E.BUDGET_USD || 100);
  if ((await monthSpend(st)) >= budget) return "over-budget";
  const pub = (E.R2_PUBLIC_URL || "").replace(/\/$/, "");
  const body = {
    name: "splattour-runner", imageName: IMAGE, gpuTypeIds: GPU_TYPES, gpuTypePriority: "custom", gpuCount: 1,
    containerDiskInGb: 150, volumeInGb: 0, ports: ["22/tcp"], supportPublicIp: true, cloudType: "SECURE",
    env: {
      R2_ACCOUNT_ID: E.R2_ACCOUNT_ID, R2_ACCESS_KEY_ID: E.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: E.R2_SECRET_ACCESS_KEY,
      BUNDLE_URL: `${pub}/${E.RUNNER_BUNDLE}`, MAX_HOURS: "5",
      ...(E.RUNNER_VOCAB ? { VOCAB_URL: `${pub}/${E.RUNNER_VOCAB}` } : {}),
      ...(E.RUNNER_PUBLIC_KEY ? { PUBLIC_KEY: E.RUNNER_PUBLIC_KEY } : {}),
    },
    dockerStartCmd: ["bash", "-c", RUNNER_CMD],
  };
  const res = await fetch("https://rest.runpod.io/v1/pods", { method: "POST", headers: { Authorization: `Bearer ${E.RUNPOD_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RunPod ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  // provisional heartbeat so a second upload a moment later doesn't start another server
  await st.s3("PUT", "cloud/active.json", "", JSON.stringify({ pod: j.id, at: Date.now() / 1000, starting: true }));
  return `started ${j.id}`;
}

async function webApi(request, E, action) {
  const configured = !!(E.R2_ACCOUNT_ID && E.R2_ACCESS_KEY_ID && E.R2_SECRET_ACCESS_KEY && E.UPLOAD_PASSWORD);
  if (action === "config") {
    return json(200, { uploads: configured, storage: (E.R2_PUBLIC_URL || "").replace(/\/$/, ""), limits: LIMITS });
  }
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!configured) return json(503, { error: "업로드 저장소가 아직 연결되지 않았어요" });
  let b;
  try { b = (await request.json()) || {}; } catch { return json(400, { error: "잘못된 요청" }); }
  if (!samePw(b.pw, E.UPLOAD_PASSWORD)) return json(401, { error: "비밀번호가 맞지 않아요" });
  const st = storage(E);

  if (action === "upload") {
    const files = Array.isArray(b.files) ? b.files : [];
    if (!files.length) return json(400, { error: "파일이 없어요" });
    const GB = 2 ** 30;
    if (files.length > LIMITS.maxFiles) return json(400, { error: `파일은 한 번에 ${LIMITS.maxFiles}개까지 올릴 수 있어요` });
    if (files.some((f) => +f.size > LIMITS.maxFileGB * GB)) return json(400, { error: `파일 하나는 ${LIMITS.maxFileGB} GB까지예요` });
    if (files.reduce((s, f) => s + (+f.size || 0), 0) > LIMITS.maxTotalGB * GB) return json(400, { error: `한 번에 ${LIMITS.maxTotalGB} GB까지 올릴 수 있어요` });
    const d = new Date();
    const id = `${d.toISOString().slice(0, 10).replace(/-/g, "")}-${hex(6)}`;
    const seen = new Set();
    const out = [];
    for (const [i, f] of files.entries()) {
      let name = safeName(f.name);
      while (seen.has(name)) name = `${i}_${name}`;
      seen.add(name);
      const key = `inbox/${id}/files/${name}`;
      let uploadId = null;
      if (+f.size > BIG) {
        const xml = await st.s3("POST", key, "?uploads");
        uploadId = (xml.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1];
        if (!uploadId) throw new Error("multipart start failed");
      }
      out.push({ key, uploadId, partSize: PART });
    }
    await st.s3("PUT", `inbox/${id}/started.json`, "", JSON.stringify({ title: String(b.title || "").slice(0, 120), files: files.length, at: d.toISOString() }));
    return json(200, { id, files: out });
  }

  if (action === "sign") {
    const items = Array.isArray(b.items) ? b.items.slice(0, 100) : [];
    const urls = [];
    for (const it of items) {
      if (!inInbox(b.id, it.key)) return json(400, { error: "잘못된 경로" });
      urls.push(it.uploadId ? await st.presign(it.key, { partNumber: String(+it.part), uploadId: it.uploadId }) : await st.presign(it.key));
    }
    return json(200, { urls });
  }

  if (action === "complete") {
    if (!inInbox(b.id, b.key) || !b.uploadId) return json(400, { error: "잘못된 경로" });
    const parts = (b.parts || []).map((p) => `<Part><PartNumber>${+p.PartNumber}</PartNumber><ETag>${String(p.ETag).replace(/[<>&]/g, "")}</ETag></Part>`).join("");
    await st.s3("POST", b.key, `?uploadId=${encodeURIComponent(b.uploadId)}`, `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`);
    return json(200, { ok: true });
  }

  if (action === "finish") {
    if (!okId(b.id)) return json(400, { error: "잘못된 작업" });
    const manifest = {
      id: b.id, title: String(b.title || "").slice(0, 120), quality: b.quality === "hold" ? "hold" : b.quality === "cloud-draft" ? "draft" : "standard",
      panorama: !!b.panorama, files: (b.files || []).filter((f) => inInbox(b.id, f.key)).map((f) => ({ name: String(f.name), size: +f.size, key: f.key })),
      finishedAt: new Date().toISOString(),
    };
    if (manifest.quality === "hold") {
      // Raw originals kept as-is (e.g. unstitched 360 video): no server is started;
      // processing is launched by hand (pipeline/splattour/pano360.py, maxq.py).
      manifest.runner = "hold";
      await st.s3("PUT", `inbox/${b.id}/manifest.json`, "", JSON.stringify(manifest));
      await setJob(st, b.id, { title: manifest.title, state: "held", label: "원본 보관됨 · 처리 대기", error: "" });
      return json(200, { ok: true, runner: "hold" });
    }
    const cloud = !!(E.RUNPOD_API_KEY && E.RUNNER_BUNDLE);
    if (cloud) manifest.runner = "cloud"; // processed by a cloud GPU server (pipeline/splattour/cloudjob.py)
    await st.s3("PUT", `inbox/${b.id}/manifest.json`, "", JSON.stringify(manifest));
    let runner = "laptop";
    if (cloud) {
      try { runner = await ensureRunner(E, st); } catch (e) { runner = `error: ${String(e.message || e).slice(0, 160)}`; }
      await setJob(st, b.id, runner.startsWith("error") || runner === "over-budget"
        ? { title: manifest.title, state: "error", error: runner === "over-budget" ? "이번 달 클라우드 한도를 넘어서 멈췄어요" : "GPU 서버를 켜지 못했어요", label: "" }
        : { title: manifest.title, state: "queued", label: "GPU 서버 준비 중", error: "" });
    }
    return json(200, { ok: true, runner });
  }
  return json(404, { error: "unknown action" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/web\/([^/]+)\/?$/);
    if (m) {
      try {
        return await webApi(request, trimEnv(env), decodeURIComponent(m[1]));
      } catch (e) {
        return json(500, { error: String(e.message || e) });
      }
    }
    if (url.pathname.startsWith("/api/")) {
      return new Response("The page could not be found\n\nNOT_FOUND\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    // html_handling is "none" so /tour.html stays /tour.html (as on Vercel); only "/" needs mapping.
    if (url.pathname === "/") return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    return env.ASSETS.fetch(request);
  },
};
