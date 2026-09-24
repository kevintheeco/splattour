// Home: upload a capture (straight to cloud storage, resumable) and list the
// finished tours. Upload API: /api/web/* (Vercel functions, see web-api/).
// Processing runs on the studio machine, which picks new uploads up from
// storage and publishes status to jobs/index.json there.
const $ = (s) => document.querySelector(s);
const MEDIA = /\.(mp4|mov|m4v|avi|mkv|insv|webm|jpe?g|png|heic|heif|webp|tiff?)$/i;
const VIDEO = /\.(mp4|mov|m4v|avi|mkv|insv|webm)$/i;
const PARALLEL = 4;

let cfg = { uploads: false, storage: "" };
// Published site: home is "/", the viewer is /tour.html (old "/?scene=" links are forwarded).
const TOUR = import.meta.env.PROD ? "/tour.html" : "/";
if (new URLSearchParams(location.search).has("scene")) location.replace(TOUR + location.search);
let picked = [];
let uploading = null;

const gb = (b) => (b >= 1 << 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 2 ** 20))} MB`);
const dur = (s) => (s > 5400 ? `${Math.round(s / 3600)}시간` : s > 90 ? `${Math.round(s / 60)}분` : `${Math.round(s)}초`);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

async function init() {
  try {
    const r = await fetch("/api/web/config");
    if (r.ok) cfg = await r.json();
  } catch {}
  $("#uploadNote").textContent = cfg.uploads ? "" : "업로드 저장소를 연결하는 중이에요. 곧 열려요.";
  const pw = store.get("st-pw");
  if (pw) $("#pw").value = pw;
  validate();
  refresh();
  setInterval(refresh, 10000);
}

// ---------- file picking ----------
const drop = $("#drop");
drop.addEventListener("click", () => $("#picker").click());
$("#picker").addEventListener("change", (e) => setFiles([...e.target.files]));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return setFiles([...e.dataTransfer.files]);
  const out = [];
  const walk = async (en) => {
    if (en.isFile) return out.push(await new Promise((ok, no) => en.file(ok, no)));
    const rd = en.createReader();
    for (;;) {
      const batch = await new Promise((ok, no) => rd.readEntries(ok, no));
      if (!batch.length) break;
      for (const c of batch) await walk(c);
    }
  };
  for (const en of entries) await walk(en);
  setFiles(out);
});
for (const id of ["#title", "#pw"]) $(id).addEventListener("input", validate);

function setFiles(fs) {
  const media = fs.filter((f) => MEDIA.test(f.name));
  const skipped = fs.length - media.length;
  picked = media.sort((a, b) => a.name.localeCompare(b.name));
  const v = picked.filter((f) => VIDEO.test(f.name)).length;
  const parts = [];
  if (picked.length - v) parts.push(`사진 ${picked.length - v}장`);
  if (v) parts.push(`영상 ${v}개`);
  $("#files").innerHTML = picked.length
    ? `${parts.join(" · ")} · ${gb(picked.reduce((s, f) => s + f.size, 0))}` + (skipped ? `<div class="note">촬영 파일이 아닌 ${skipped}개는 뺐어요</div>` : "")
    : "";
  validate();
}
function validate() {
  $("#go").disabled = !cfg.uploads || !picked.length || !$("#title").value.trim() || !$("#pw").value || !!uploading;
}

// ---------- upload ----------
async function api(path, body) {
  const res = await fetch(`/api/web/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, pw: $("#pw").value }) });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(r.error || `요청 실패 (${res.status})`), { status: res.status });
  return r;
}

$("#upPause").addEventListener("click", () => {
  if (!uploading) return;
  uploading.paused = !uploading.paused;
  $("#upPause").textContent = uploading.paused ? "이어서 올리기" : "일시정지";
  if (!uploading.paused) uploading.kick();
});

$("#go").addEventListener("click", async () => {
  const title = $("#title").value.trim();
  const files = picked;
  const sig = `st-up:${title}:${files.length}:${files.reduce((s, f) => s + f.size, 0)}`;
  $("#uploadNote").textContent = "";
  try {
    let sess = store.get(sig);
    if (!sess) {
      const r = await api("upload", { title, quality: $("#quality").value, panorama: $("#pano").checked, files: files.map((f) => ({ name: f.name, size: f.size })) });
      sess = { id: r.id, files: r.files.map((x) => ({ ...x, done: false, etags: {} })) };
      store.set(sig, sess);
    }
    store.set("st-pw", $("#pw").value);
    await upload(sess, sig, title, files);
    await api("finish", { id: sess.id, title, quality: $("#quality").value, panorama: $("#pano").checked, files: files.map((f, i) => ({ name: f.name, size: f.size, key: sess.files[i].key })) });
    store.del(sig);
    $("#upState").textContent = "다 올라갔어요. 아래 '만드는 중'에서 진행을 볼 수 있어요";
    setFiles([]);
    $("#title").value = "";
    refresh();
  } catch (e) {
    $("#uploadNote").innerHTML = `<span class="warn">${e.status === 401 ? "비밀번호가 맞지 않아요" : e.message}</span>`;
    uploading = null;
    validate();
  }
});

// Small files: one signed PUT each. Large files (videos): multipart, 64 MB
// parts. Finished parts are remembered in this browser, so choosing the same
// files again after a crash or a closed tab continues where it stopped.
function upload(sess, sig, title, files) {
  const total = files.reduce((s, f) => s + f.size, 0);
  const U = { paused: false, kick: () => {} };
  uploading = U;
  validate();
  const box = $("#up");
  box.className = "card up on";
  $("#upTitle").textContent = title;
  $("#upPause").style.display = "";
  $("#upPause").textContent = "일시정지";

  // work items: {i, part|null, start, end}
  const items = [];
  let doneBytes = 0;
  sess.files.forEach((sf, i) => {
    const f = files[i];
    if (sf.done) { doneBytes += f.size; return; }
    if (!sf.uploadId) { items.push({ i, part: null, start: 0, end: f.size }); return; }
    const n = Math.ceil(f.size / sf.partSize);
    for (let p = 1; p <= n; p++) {
      const start = (p - 1) * sf.partSize, end = Math.min(f.size, p * sf.partSize);
      if (sf.etags[p]) doneBytes += end - start;
      else items.push({ i, part: p, start, end });
    }
  });
  const inflight = new Map();
  const samples = [];
  let status = doneBytes ? "이어서 올리는 중" : "";
  const paint = () => {
    const done = doneBytes + [...inflight.values()].reduce((s, x) => s + x, 0);
    const now = performance.now();
    samples.push([now, done]);
    while (samples.length > 2 && now - samples[0][0] > 8000) samples.shift();
    const [ta, da] = samples[0];
    const bps = now - ta > 500 ? ((done - da) * 1000) / (now - ta) : 0;
    $("#upBar").style.width = `${(100 * done) / total}%`;
    $("#upBytes").textContent = `${gb(done)} / ${gb(total)} · ${Math.floor((100 * done) / total)}%`;
    $("#upSpeed").textContent = U.paused ? "멈춤" : bps > 0 ? `${(bps / 2 ** 20).toFixed(1)} MB/s · 약 ${dur((total - done) / bps)} 남음` : "";
    $("#upState").textContent = status;
  };
  const timer = setInterval(paint, 500);

  const put = (url, blob, key) => new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.upload.onprogress = (e) => inflight.set(key, e.loaded);
    x.onload = () => (x.status < 300 ? ok(x.getResponseHeader("ETag")) : no(new Error(`업로드 실패 ${x.status}`)));
    x.onerror = () => no(new Error("네트워크 오류"));
    x.send(blob);
  });

  return new Promise((resolve, reject) => {
    let active = 0, finished = false;
    const pending = new Map(); // multipart files waiting for their last part
    const finish = async () => {
      if (finished) return;
      finished = true;
      try {
        for (const [i, sf] of sess.files.entries()) {
          if (sf.done || !sf.uploadId) continue;
          const parts = Object.entries(sf.etags).map(([n, e]) => ({ PartNumber: +n, ETag: e })).sort((a, b) => a.PartNumber - b.PartNumber);
          await api("complete", { id: sess.id, key: sf.key, uploadId: sf.uploadId, parts });
          sf.done = true;
          store.set(sig, sess);
        }
      } catch (e) { clearInterval(timer); reject(e); return; }
      clearInterval(timer);
      status = "";
      paint();
      box.classList.add("done");
      $("#upPause").style.display = "none";
      uploading = null;
      validate();
      resolve();
    };
    // sign in batches so hundreds of photos cost a few requests
    let signed = [];
    const sign = async () => {
      const batch = items.splice(0, 50);
      if (!batch.length) return;
      const r = await api("sign", { id: sess.id, items: batch.map((it) => ({ key: sess.files[it.i].key, uploadId: sess.files[it.i].uploadId || null, part: it.part })) });
      batch.forEach((it, k) => signed.push({ ...it, url: r.urls[k] }));
    };
    const next = async () => {
      if (U.paused || finished) return;
      if (signed.length < PARALLEL && items.length) {
        try { await sign(); } catch (e) { if (e.status === 401) { clearInterval(timer); reject(e); return; } }
      }
      while (active < PARALLEL && signed.length) {
        const it = signed.shift();
        active++;
        send(it).then(() => { active--; next(); });
      }
      if (!items.length && !signed.length && !active) finish();
    };
    U.kick = next;
    async function send(it) {
      const f = files[it.i], sf = sess.files[it.i];
      const key = `${it.i}:${it.part}`;
      for (let tries = 0; ; tries++) {
        while (U.paused) await new Promise((ok) => setTimeout(ok, 400));
        try {
          const etag = await put(it.url, f.slice(it.start, it.end), key);
          inflight.delete(key);
          doneBytes += it.end - it.start;
          if (it.part) sf.etags[it.part] = etag;
          else sf.done = true;
          store.set(sig, sess);
          if (tries) status = "";
          return;
        } catch {
          inflight.delete(key);
          status = `연결이 불안정해서 다시 시도하는 중 (${tries + 1}번째)`;
          await new Promise((ok) => setTimeout(ok, Math.min(30000, 1000 * 2 ** Math.min(tries + 1, 5))));
          if (tries > 2) { // signed URL may have expired: sign this one again
            try {
              const r = await api("sign", { id: sess.id, items: [{ key: sf.key, uploadId: sf.uploadId || null, part: it.part }] });
              it.url = r.urls[0];
            } catch {}
          }
        }
      }
    }
    next();
  });
}

// ---------- lists ----------
async function getJson(url) {
  try { const r = await fetch(url, { cache: "no-cache" }); return r.ok ? await r.json() : null; } catch { return null; }
}

async function refresh() {
  const [local, remote, jobs] = await Promise.all([
    getJson("/scenes/index.json"),
    cfg.storage ? getJson(`${cfg.storage}/scenes/index.json`) : null,
    cfg.storage ? getJson(`${cfg.storage}/jobs/index.json`) : null,
  ]);
  const scenes = [
    ...(local?.scenes || []).map((s) => ({ ...s, href: `${TOUR}?scene=${encodeURIComponent(s.name)}`, base: `/scenes/${encodeURIComponent(s.name)}/` })),
    ...(remote?.scenes || []).map((s) => ({ ...s, href: `${TOUR}?scene=${encodeURIComponent(s.name)}&from=cloud`, base: `${cfg.storage}/scenes/${encodeURIComponent(s.name)}/` })),
  ];
  const G = $("#scenes");
  G.textContent = "";
  if (!scenes.length) G.innerHTML = `<div class="empty">아직 완성된 공간이 없어요.</div>`;
  for (const s of scenes) {
    const a = document.createElement("a");
    a.className = "card scene";
    a.href = s.href;
    a.innerHTML = `<div class="cover"></div><div class="body"><div class="t"></div><div class="s"></div><div class="meta"></div></div>`;
    if (s.cover) a.querySelector(".cover").style.backgroundImage = `url("${s.base}${s.cover}")`;
    a.querySelector(".t").textContent = s.title || s.name;
    a.querySelector(".s").textContent = s.subtitle || "";
    a.querySelector(".meta").textContent = [s.nodes && `시점 ${s.nodes}곳`, s.photos && `원본 사진 ${s.photos}장`].filter(Boolean).join(" · ");
    G.appendChild(a);
  }
  const list = (jobs?.jobs || []).filter((j) => j.state !== "done");
  $("#jobsWrap").hidden = !list.length;
  const J = $("#jobs");
  J.textContent = "";
  for (const j of list) {
    const el = document.createElement("div");
    el.className = "card job";
    el.innerHTML = `<div class="job-title"></div><div class="job-state"></div>`;
    el.querySelector(".job-title").textContent = j.title;
    const st = el.querySelector(".job-state");
    st.textContent = j.state === "error" ? `문제가 생겼어요: ${j.error || ""}` : j.label || "순서를 기다리는 중";
    st.classList.toggle("err", j.state === "error");
    J.appendChild(el);
  }
}

init();
