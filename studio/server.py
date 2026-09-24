"""SplatTour Studio: upload captures, watch processing, open and edit tours.

    pipeline/.venv/Scripts/python.exe studio/server.py      → http://localhost:5200

Jobs run one at a time in a worker thread (the laptop GPU can only train one
scene at once). Progress comes from each job's status.json.
"""
from __future__ import annotations

import json
import queue
import re
import shutil
import sys
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

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
