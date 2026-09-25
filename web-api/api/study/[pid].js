// Study log for the published site (same URL as the studio's /api/study/<pid>,
// see viewer/src/app/studylog.js). R2 has no append: each batch is one object
//   study/<pid>/<session>/<unix ms>-<rand>.json   {session, events}
// Collect with: python -m splattour.inbox (or any S3 client) → merge per session.
import { AwsClient } from "aws4fetch";
import crypto from "node:crypto";

const E = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
const BUCKET = E.R2_BUCKET || "hanok360";
const ENDPOINT = `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}`;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!(E.R2_ACCOUNT_ID && E.R2_ACCESS_KEY_ID && E.R2_SECRET_ACCESS_KEY)) return res.status(503).json({ error: "storage not configured" });
  const pid = String(req.query.pid || "").replace(/[^\w-]/g, "").slice(0, 40) || "anon";
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const events = Array.isArray(body?.events) ? body.events.slice(0, 5000) : null;
  if (!events) return res.status(400).json({ error: "no events" });
  const session = String(body.session || "session").replace(/[^\w-]/g, "").slice(0, 80) || "session";
  const text = JSON.stringify({ session, events });
  if (text.length > 2_000_000) return res.status(413).json({ error: "too large" });
  const key = `study/${pid}/${session}/${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`;
  const r2 = new AwsClient({ accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const put = await r2.fetch(`${ENDPOINT}/${key.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", body: text, headers: { "Content-Type": "application/json" } });
  if (!put.ok) return res.status(502).json({ error: `storage ${put.status}` });
  return res.status(200).json({ ok: true, n: events.length });
}
