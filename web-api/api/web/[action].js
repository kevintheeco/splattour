// Upload API for the public site (Vercel function). Browsers upload straight to
// Cloudflare R2 with signed URLs; this only checks the password, signs, and
// writes the manifest the studio machine watches for (inbox/<id>/manifest.json).
//   GET  /api/web/config
//   POST /api/web/upload   {pw, title, quality, panorama, files:[{name,size}]}
//   POST /api/web/sign     {pw, id, items:[{key, uploadId|null, part|null}]}
//   POST /api/web/complete {pw, id, key, uploadId, parts:[{PartNumber, ETag}]}
//   POST /api/web/finish   {pw, id, title, quality, panorama, files:[{name,size,key}]}
import { AwsClient } from "aws4fetch";
import crypto from "node:crypto";

// trim: values pasted into the dashboard/CLI can carry stray spaces (caused a signature mismatch once)
const E = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
const BUCKET = E.R2_BUCKET || "hanok360";
const ENDPOINT = `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}`;
const PART = 64 << 20; // multipart part size for large files
const BIG = 96 << 20; // files above this go multipart
const EXPIRES = 6 * 3600;
const r2 = () => new AwsClient({ accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
const configured = () => !!(E.R2_ACCOUNT_ID && E.R2_ACCESS_KEY_ID && E.R2_SECRET_ACCESS_KEY && E.UPLOAD_PASSWORD);

const safeName = (s) => String(s).normalize("NFC").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "file";
const objUrl = (key) => `${ENDPOINT}/${key.split("/").map(encodeURIComponent).join("/")}`;
const okId = (id) => /^[0-9]{8}-[0-9a-f]{12}$/.test(id || "");
const inInbox = (id, key) => okId(id) && typeof key === "string" && key.startsWith(`inbox/${id}/files/`) && !key.includes("..");

function samePw(a) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(E.UPLOAD_PASSWORD || "");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function presign(key, query = {}) {
  const u = new URL(objUrl(key));
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  u.searchParams.set("X-Amz-Expires", String(EXPIRES));
  const signed = await r2().sign(new Request(u, { method: "PUT" }), { aws: { signQuery: true } });
  return signed.url;
}

async function s3(method, key, query = "", body) {
  const res = await r2().fetch(objUrl(key) + query, { method, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`storage ${method} ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

export default async function handler(req, res) {
  const action = req.query.action;
  res.setHeader("Cache-Control", "no-store");
  try {
    if (action === "config") {
      return res.status(200).json({ uploads: configured(), storage: (E.R2_PUBLIC_URL || "").replace(/\/$/, "") });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    if (!configured()) return res.status(503).json({ error: "업로드 저장소가 아직 연결되지 않았어요" });
    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (!samePw(b.pw)) return res.status(401).json({ error: "비밀번호가 맞지 않아요" });

    if (action === "upload") {
      const files = Array.isArray(b.files) ? b.files.slice(0, 20000) : [];
      if (!files.length) return res.status(400).json({ error: "파일이 없어요" });
      const d = new Date();
      const id = `${d.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(6).toString("hex")}`;
      const seen = new Set();
      const out = [];
      for (const [i, f] of files.entries()) {
        let name = safeName(f.name);
        while (seen.has(name)) name = `${i}_${name}`;
        seen.add(name);
        const key = `inbox/${id}/files/${name}`;
        let uploadId = null;
        if (+f.size > BIG) {
          const xml = await s3("POST", key, "?uploads");
          uploadId = (xml.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1];
          if (!uploadId) throw new Error("multipart start failed");
        }
        out.push({ key, uploadId, partSize: PART });
      }
      await s3("PUT", `inbox/${id}/started.json`, "", JSON.stringify({ title: String(b.title || "").slice(0, 120), files: files.length, at: d.toISOString() }));
      return res.status(200).json({ id, files: out });
    }

    if (action === "sign") {
      const items = Array.isArray(b.items) ? b.items.slice(0, 100) : [];
      const urls = [];
      for (const it of items) {
        if (!inInbox(b.id, it.key)) return res.status(400).json({ error: "잘못된 경로" });
        urls.push(it.uploadId ? await presign(it.key, { partNumber: String(+it.part), uploadId: it.uploadId }) : await presign(it.key));
      }
      return res.status(200).json({ urls });
    }

    if (action === "complete") {
      if (!inInbox(b.id, b.key) || !b.uploadId) return res.status(400).json({ error: "잘못된 경로" });
      const parts = (b.parts || []).map((p) => `<Part><PartNumber>${+p.PartNumber}</PartNumber><ETag>${String(p.ETag).replace(/[<>&]/g, "")}</ETag></Part>`).join("");
      await s3("POST", b.key, `?uploadId=${encodeURIComponent(b.uploadId)}`, `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`);
      return res.status(200).json({ ok: true });
    }

    if (action === "finish") {
      if (!okId(b.id)) return res.status(400).json({ error: "잘못된 작업" });
      const manifest = {
        id: b.id, title: String(b.title || "").slice(0, 120), quality: b.quality === "cloud-draft" ? "draft" : "standard",
        panorama: !!b.panorama, files: (b.files || []).filter((f) => inInbox(b.id, f.key)).map((f) => ({ name: String(f.name), size: +f.size, key: f.key })),
        finishedAt: new Date().toISOString(),
      };
      await s3("PUT", `inbox/${b.id}/manifest.json`, "", JSON.stringify(manifest));
      return res.status(200).json({ ok: true });
    }
    return res.status(404).json({ error: "unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
