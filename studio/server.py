"""SplatTour Studio: upload captures, watch processing, open and edit tours.

    pipeline/.venv/Scripts/python.exe studio/server.py      → http://localhost:5200

Jobs run one at a time in a worker thread (the laptop GPU can only train one
scene at once). Progress comes from each job's status.json.
"""
from __future__ import annotations

import hashlib
import json
import queue
import re
import shutil
import sys
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from splattour.run import STAGES, run_job  # noqa: E402

JOBS = ROOT / "data" / "jobs"
UPLOADS = ROOT / "data" / "uploads"
SCENES = ROOT / "scenes"
VIEWER_URL = "http://localhost:5190"

app = FastAPI(title="SplatTour Studio")
work: queue.Queue = queue.Queue()


def worker():
    while True:
        spec = work.get()
        try:
            run_job(**spec)
        except Exception as e:  # status.json already records the failure
            print("job failed:", e, file=sys.stderr)
        finally:
            work.task_done()


threading.Thread(target=worker, daemon=True).start()


def slug(s: str) -> str:
    s = re.sub(r"[^\w가-힣-]+", "-", s.strip()).strip("-").lower()
    return s or f"scene-{int(time.time())}"


@app.get("/")
def index():
    return FileResponse(Path(__file__).with_name("index.html"))


@app.get("/guide")
def guide():
    """The full capture guide (docs/CAPTURE_GUIDE.md) rendered as a simple page."""
    import markdown
    body = markdown.markdown((ROOT / "docs" / "CAPTURE_GUIDE.md").read_text(encoding="utf-8"), extensions=["tables", "fenced_code"])
    body = body.replace("[ ]", "<input type=checkbox>")
    return HTMLResponse(f"""<!doctype html><html lang=ko><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>촬영 가이드 · SplatTour</title>
<link rel=stylesheet href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
body{{margin:0;background:#f6f4f0;color:#1b1a18;font-family:"Pretendard Variable",system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
main{{max-width:780px;margin:0 auto;padding:48px 20px 96px;line-height:1.75;font-size:16px}}
h1{{font-size:32px;letter-spacing:-.03em;margin:0 0 12px}} h2{{font-size:21px;letter-spacing:-.02em;margin:44px 0 12px}} h3{{font-size:17px;margin:26px 0 8px}}
p,li{{color:#3b3833}} b,strong{{color:#1b1a18}}
blockquote{{margin:18px 0;padding:14px 18px;background:#fff;border-left:4px solid #c8793a;border-radius:10px;font-size:17px}}
blockquote p{{margin:0;color:#1b1a18}}
table{{width:100%;border-collapse:collapse;margin:12px 0;background:#fff;border-radius:12px;overflow:hidden;font-size:14.5px}}
th,td{{text-align:left;padding:10px 12px;border-bottom:1px solid #e7e2da;vertical-align:top}} th{{background:#f1ece6}}
pre{{background:#fff;border:1px solid #e7e2da;border-radius:12px;padding:14px;overflow:auto;font-size:13.5px;line-height:1.5}}
code{{font-family:"Cascadia Mono",Consolas,monospace}} hr{{border:0;border-top:1px solid #e7e2da;margin:36px 0}}
input[type=checkbox]{{width:17px;height:17px;vertical-align:-3px;margin-right:6px;accent-color:#c8793a}}
ul{{padding-left:22px}} li{{margin:4px 0}}
@media print{{body{{background:#fff}}}}
</style>
<main>{body}</main></html>""")


@app.get("/api/config")
def config():
    return {"viewer": VIEWER_URL, "stages": [{"key": k, "label": v} for k, v in STAGES]}


@app.post("/api/jobs")
async def create_job(title: str = Form(...), panorama: bool = Form(False), quality: str = Form("standard"), files: list[UploadFile] = File(...)):
    name = slug(title)
    if (JOBS / name).exists() or (SCENES / name).exists():
        name = f"{name}-{int(time.time()) % 100000}"
    up = UPLOADS / name
    up.mkdir(parents=True, exist_ok=True)
    for f in files:
        dst = up / Path(f.filename).name
        with open(dst, "wb") as out:
            shutil.copyfileobj(f.file, out, 8 << 20)
    steps = {"draft": 7000, "standard": 30000}.get(quality, 30000)
    work.put(dict(inputs=[up], name=name, title=title, panorama=panorama, steps=steps))
    (JOBS / name).mkdir(parents=True, exist_ok=True)
    status = JOBS / name / "status.json"
    if not status.exists():
        status.write_text(json.dumps({"name": name, "title": title, "queued": True, "stages": {k: {"label": v, "status": "pending"} for k, v in STAGES}},
                                     ensure_ascii=False), encoding="utf-8")
    return {"name": name}


# ---------------------------------------------------------------------------
# Resumable chunked uploads. Captures for a thesis-grade scene are tens of GB
# (4K video, 24 MP photos), so a single multipart POST is not an option: one
# dropped Wi-Fi packet would restart everything. The browser sends 16 MB
# chunks with an explicit offset; the server appends only at the current size,
# so a retried chunk is idempotent and a reload continues where it stopped.

MEDIA_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".insv", ".webm", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff"}


def _safe(name: str) -> str:
    return re.sub(r"[^\w.가-힣-]+", "_", Path(name).name)[-120:] or "file"


def _manifest(uid: str) -> tuple[Path, dict]:
    d = UPLOADS / uid
    m = d / "_manifest.json"
    if not m.exists():
        raise HTTPException(404, "upload not found")
    return d, json.loads(m.read_text(encoding="utf-8"))


def _received(d: Path, f: dict) -> int:
    done, part = d / f["stored"], d / (f["stored"] + ".part")
    return done.stat().st_size if done.exists() else part.stat().st_size if part.exists() else 0


@app.post("/api/uploads")
async def start_upload(spec: dict):
    files = spec.get("files") or []
    title = (spec.get("title") or "").strip()
    if not files or not title:
        raise HTTPException(400, "title and files required")
    bad = [f["name"] for f in files if Path(f["name"]).suffix.lower() not in MEDIA_EXT]
    if bad:
        raise HTTPException(400, f"지원하지 않는 파일: {', '.join(bad[:5])}")
    fp = hashlib.sha1(json.dumps([[f["name"], f["size"], f.get("mtime")] for f in files]).encode()).hexdigest()[:10]
    uid = f"{slug(title)}-{fp}"
    d = UPLOADS / uid
    total = sum(int(f["size"]) for f in files)
    if not (d / "_manifest.json").exists():
        free = shutil.disk_usage(UPLOADS.parent if UPLOADS.parent.exists() else ROOT).free
        # originals + extracted frames + SfM/training workspace
        if free < total * 1.6 + (5 << 30):
            raise HTTPException(507, f"저장 공간이 부족합니다: {total / 2**30:.1f} GB를 올리려면 {total * 1.6 / 2**30 + 5:.0f} GB가 필요하고 {free / 2**30:.0f} GB 남아 있습니다")
        d.mkdir(parents=True, exist_ok=True)
        man = {"id": uid, "title": title, "panorama": bool(spec.get("panorama")), "created": time.time(), "total": total,
               "files": [{"name": f["name"], "size": int(f["size"]), "stored": f"{i:05d}_{_safe(f['name'])}"} for i, f in enumerate(files)]}
        (d / "_manifest.json").write_text(json.dumps(man, ensure_ascii=False), encoding="utf-8")
    d, man = _manifest(uid)
    return {"id": uid, "received": [_received(d, f) for f in man["files"]]}


@app.put("/api/uploads/{uid}/{idx}")
async def put_chunk(uid: str, idx: int, offset: int, request: Request):
    d, man = _manifest(uid)
    if not 0 <= idx < len(man["files"]):
        raise HTTPException(404)
    f = man["files"][idx]
    if (d / f["stored"]).exists():
        return {"received": f["size"]}
    part = d / (f["stored"] + ".part")
    cur = part.stat().st_size if part.exists() else 0
    if offset > cur:
        raise HTTPException(409, detail={"received": cur})
    with open(part, "r+b" if part.exists() else "wb") as out:
        out.truncate(offset)
        out.seek(offset)
        async for chunk in request.stream():
            out.write(chunk)
        n = out.tell()
    if n > f["size"]:
        part.unlink()
        raise HTTPException(400, "file larger than announced")
    if n == f["size"]:
        part.rename(d / f["stored"])
    return {"received": n}


@app.get("/api/uploads/{uid}")
def upload_status(uid: str):
    d, man = _manifest(uid)
    return {"id": uid, "received": [_received(d, f) for f in man["files"]], "total": man["total"]}


@app.post("/api/uploads/{uid}/finish")
async def finish_upload(uid: str, spec: dict):
    d, man = _manifest(uid)
    missing = [f["name"] for f in man["files"] if not (d / f["stored"]).exists()]
    if missing:
        raise HTTPException(409, f"아직 다 올라가지 않은 파일 {len(missing)}개")
    name = slug(man["title"])
    if (JOBS / name).exists() or (SCENES / name).exists():
        name = f"{name}-{int(time.time()) % 100000}"
    backend = spec.get("backend", "cloud")
    steps = {"draft": 7000, "standard": 30000}.get(spec.get("quality", "standard"), 30000)
    media = d / "media"
    media.mkdir(exist_ok=True)
    for f in man["files"]:
        src = d / f["stored"]
        if src.exists():
            src.rename(media / f["stored"])
    work.put(dict(inputs=[media], name=name, title=man["title"], panorama=man["panorama"], steps=steps, backend=backend))
    (JOBS / name).mkdir(parents=True, exist_ok=True)
    status = JOBS / name / "status.json"
    if not status.exists():
        status.write_text(json.dumps({"name": name, "title": man["title"], "queued": True, "backend": backend,
                                      "stages": {k: {"label": v, "status": "pending"} for k, v in STAGES}}, ensure_ascii=False), encoding="utf-8")
    return {"name": name}


@app.get("/api/jobs")
def list_jobs():
    out = []
    for d in sorted(JOBS.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True):
        s = d / "status.json"
        if s.exists():
            out.append(json.loads(s.read_text(encoding="utf-8")))
    return out


@app.get("/api/scenes")
def list_scenes():
    out = []
    for d in sorted(SCENES.glob("*/tour.json")):
        t = json.loads(d.read_text(encoding="utf-8"))
        out.append({"name": d.parent.name, "title": t.get("title"), "subtitle": t.get("subtitle", ""), "nodes": len(t.get("nodes", [])),
                    "lights": len(t.get("lights", [])), "updated": d.stat().st_mtime})
    return out


@app.get("/api/scenes/{name}/tour")
def get_tour(name: str):
    p = SCENES / name / "tour.json"
    if not p.exists():
        raise HTTPException(404)
    return JSONResponse(json.loads(p.read_text(encoding="utf-8")))


@app.put("/api/scenes/{name}/tour")
async def put_tour(name: str, tour: dict):
    """Save edits from the viewer's edit mode (names, lights, sounds…).
    Keeps a timestamped backup so no edit is ever lost."""
    p = SCENES / name / "tour.json"
    if not p.exists():
        raise HTTPException(404)
    if not isinstance(tour.get("nodes"), list) or not tour.get("splat"):
        raise HTTPException(400, "invalid tour")
    bak = p.parent / "history"
    bak.mkdir(exist_ok=True)
    shutil.copyfile(p, bak / f"tour-{time.strftime('%Y%m%d-%H%M%S')}.json")
    p.write_text(json.dumps(tour, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


@app.post("/api/scenes/{name}/media")
async def upload_media(name: str, file: UploadFile = File(...)):
    """Music / ambience files for a scene."""
    d = SCENES / name / "media"
    d.mkdir(parents=True, exist_ok=True)
    fn = re.sub(r"[^\w.가-힣-]+", "_", Path(file.filename).name)
    with open(d / fn, "wb") as out:
        shutil.copyfileobj(file.file, out)
    return {"src": f"media/{fn}"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5200)
