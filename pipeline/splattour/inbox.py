"""Bridge between the public site and this machine, through Cloudflare R2.

The site uploads captures to  inbox/<id>/files/*  and writes  inbox/<id>/manifest.json
(see web-api/). The studio runs `Bridge.loop()`: it downloads new uploads,
queues them like a local upload, and publishes back

    jobs/index.json               progress of web jobs (the home page shows it)
    scenes/<name>/...             finished tour (tour.json, spz, photos)
    scenes/index.json             list of cloud scenes (the home page shows it)

Keys: secrets/r2.txt (ACCOUNT_ID, ACCESS_KEY_ID, SECRET_ACCESS_KEY, PUBLIC_URL).

    python -m splattour.inbox check        # connection test, bucket CORS setup
    python -m splattour.inbox publish <scene>
"""
from __future__ import annotations

import json
import mimetypes
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

from .eval_views import ROOT

SECRETS = ROOT / "secrets" / "r2.txt"
STATE = ROOT / "data" / "inbox_state.json"
BUCKET = "hanok360"


def keys() -> dict | None:
    if not SECRETS.exists():
        return None
    kv = dict(line.split("=", 1) for line in SECRETS.read_text(encoding="utf-8").splitlines() if "=" in line)
    kv = {k.strip(): v.strip() for k, v in kv.items()}
    return kv if all(kv.get(k) for k in ("ACCOUNT_ID", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY")) else None


def client(k: dict):
    import boto3
    from botocore.config import Config
    return boto3.client("s3", endpoint_url=f"https://{k['ACCOUNT_ID']}.r2.cloudflarestorage.com",
                        aws_access_key_id=k["ACCESS_KEY_ID"], aws_secret_access_key=k["SECRET_ACCESS_KEY"],
                        region_name="auto", config=Config(retries={"max_attempts": 6, "mode": "adaptive"}, max_pool_connections=16))


CORS = {"CORSRules": [{
    "AllowedOrigins": ["https://splattour-rho.vercel.app", "http://localhost:5190", "http://localhost:5191"],
    "AllowedMethods": ["GET", "PUT", "HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600}]}


def setup(k: dict) -> dict:
    """Create the bucket if needed and allow the site to PUT/GET from browsers."""
    s3 = client(k)
    names = [b["Name"] for b in s3.list_buckets().get("Buckets", [])]
    if BUCKET not in names:
        s3.create_bucket(Bucket=BUCKET)
    s3.put_bucket_cors(Bucket=BUCKET, CORSConfiguration=CORS)
    s3.put_object(Bucket=BUCKET, Key="jobs/index.json", Body=b'{"jobs": []}', ContentType="application/json", CacheControl="no-cache")
    return {"bucket": BUCKET, "buckets": names, "cors": "ok"}


def _put(s3, path: Path, key: str) -> None:
    ctype = mimetypes.guess_type(path.name)[0] or ("application/json" if path.suffix == ".json" else "application/octet-stream")
    if path.suffix == ".webp":
        ctype = "image/webp"
    cache = "no-cache" if path.suffix == ".json" else "public, max-age=86400"
    s3.upload_file(str(path), BUCKET, key, ExtraArgs={"ContentType": ctype, "CacheControl": cache})


def publish_scene(s3, name: str) -> dict:
    """Upload a finished scene (viewer files only) and refresh scenes/index.json."""
    from .catalog import entry
    sdir = ROOT / "scenes" / name
    files = [p for p in [sdir / "tour.json", sdir / "scene.spz", sdir / "scene.mobile.spz"] if p.exists()]
    files += sorted((sdir / "photos").rglob("*")) if (sdir / "photos").exists() else []
    files = [p for p in files if p.is_file()]
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda p: _put(s3, p, f"scenes/{name}/{p.relative_to(sdir).as_posix()}"), files))
    try:
        cat = json.loads(s3.get_object(Bucket=BUCKET, Key="scenes/index.json")["Body"].read())
    except Exception:  # noqa: BLE001 — first scene
        cat = {"scenes": []}
    e = entry(sdir)
    cat["scenes"] = [s for s in cat["scenes"] if s["name"] != name] + [e]
    s3.put_object(Bucket=BUCKET, Key="scenes/index.json", Body=json.dumps(cat, ensure_ascii=False).encode(), ContentType="application/json", CacheControl="no-cache")
    return {"files": len(files), "mb": round(sum(p.stat().st_size for p in files) / 1e6, 1)}


class Bridge:
    """enqueue(media_dir, title, panorama, quality) -> job name, provided by the studio."""

    def __init__(self, enqueue: Callable[[Path, str, bool, str], str], every: float = 30.0):
        self.enqueue, self.every = enqueue, every
        self.state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {"web": {}}
        self.error = ""

    def save(self):
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")

    def start(self):
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            k = keys()
            if k:
                try:
                    self.tick(client(k))
                    self.error = ""
                except Exception as e:  # noqa: BLE001 — keep polling; shown in the studio
                    self.error = str(e)[:300]
                    print("[inbox]", self.error, file=sys.stderr)
            time.sleep(self.every)

    def tick(self, s3):
        web = self.state["web"]
        # 1) new uploads
        pages = s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix="inbox/", Delimiter="/")
        ids = [p["Prefix"].split("/")[1] for page in pages for p in page.get("CommonPrefixes", [])]
        for uid in ids:
            if uid in web:
                continue
            try:
                man = json.loads(s3.get_object(Bucket=BUCKET, Key=f"inbox/{uid}/manifest.json")["Body"].read())
            except s3.exceptions.NoSuchKey:
                continue  # still uploading
            web[uid] = {"title": man["title"], "state": "downloading", "label": "받는 중", "at": time.time()}
            self.save()
            self.publish_jobs(s3)
            media = ROOT / "data" / "uploads" / f"web-{uid}" / "media"
            media.mkdir(parents=True, exist_ok=True)

            def get(f):
                dst = media / Path(f["key"]).name
                if not (dst.exists() and dst.stat().st_size == f["size"]):
                    s3.download_file(BUCKET, f["key"], str(dst))
            with ThreadPoolExecutor(8) as ex:
                list(ex.map(get, man["files"]))
            web[uid].update(job=self.enqueue(media, man["title"], man.get("panorama", False), man.get("quality", "standard")),
                            state="queued", label="순서를 기다리는 중")
            self.save()
        # 2) progress of web jobs, publishing finished ones
        for uid, w in web.items():
            if w.get("state") in ("done", "error") or not w.get("job"):
                continue
            sp = ROOT / "data" / "jobs" / w["job"] / "status.json"
            if not sp.exists():
                continue
            st = json.loads(sp.read_text(encoding="utf-8"))
            stages = st.get("stages", {})
            err = next((v for v in stages.values() if v.get("status") == "error"), None)
            run = next((v for v in stages.values() if v.get("status") == "running"), None)
            if err:
                w.update(state="error", error=(err.get("error") or "").splitlines()[0][:160])
            elif st.get("scene"):
                w.update(state="publishing", label="웹에 올리는 중")
                self.publish_jobs(s3)
                w["published"] = publish_scene(s3, st["scene"])
                w.update(state="done", scene=st["scene"], label="완성")
            elif run:
                pr = run.get("progress") or {}
                pct = f" {int(100 * pr['step'] / pr['steps'])}%" if pr.get("steps") and pr.get("step") else ""
                w.update(state="running", label=f"{run.get('label', '')}{pct}")
        self.save()
        self.publish_jobs(s3)

    def publish_jobs(self, s3):
        jobs = [{"id": uid, "title": w["title"], "state": w["state"], "label": w.get("label", ""), "error": w.get("error", ""), "scene": w.get("scene")}
                for uid, w in sorted(self.state["web"].items(), key=lambda x: -x[1].get("at", 0))][:30]
        s3.put_object(Bucket=BUCKET, Key="jobs/index.json", Body=json.dumps({"jobs": jobs, "at": time.time()}, ensure_ascii=False).encode(),
                      ContentType="application/json", CacheControl="no-cache")


if __name__ == "__main__":
    k = keys()
    if not k:
        sys.exit("secrets/r2.txt 에 키가 아직 없어요")
    if sys.argv[1:2] == ["check"]:
        print(json.dumps(setup(k), ensure_ascii=False))
    elif sys.argv[1:2] == ["publish"]:
        print(json.dumps(publish_scene(client(k), sys.argv[2]), ensure_ascii=False))
