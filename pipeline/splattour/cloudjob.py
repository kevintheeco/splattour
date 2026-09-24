"""Runs ON the cloud GPU server: turns every pending web upload into a published tour,
then shuts the server down. The laptop is not involved.

Started by the site's upload API (web-api/api/web/[action].js → RunPod pod whose start
command fetches this code and runs `python -m splattour.cloudjob`).

Storage layout (R2 bucket):
    inbox/<id>/manifest.json        written when an upload finishes ("runner": "cloud")
    inbox/<id>/claim.json           this server took the job
    jobs/index.json                 progress for the home page
    scenes/<name>/...  scenes/index.json   published tours
    cloud/active.json               heartbeat: a server is running (the API won't start another)
    cloud/ledger/<YYYY-MM>/<pod>.json      what each server cost (monthly budget check)

Every step is the same code as on the laptop (run_job): ingest → SfM (pycolmap on the
GPU) → gsplat training on the GPU (every photo) → tour → web export → source photos.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .eval_views import ROOT
from .inbox import BUCKET, client, publish_scene

POD = os.environ.get("RUNPOD_POD_ID", "local")
RATE = float(os.environ.get("COST_PER_HR", "0") or 0)
T0 = time.time()
WORK = Path(os.environ.get("SPLATTOUR_WORK", "/workspace/jobs"))


def s3c():
    return client({"ACCOUNT_ID": os.environ["R2_ACCOUNT_ID"], "ACCESS_KEY_ID": os.environ["R2_ACCESS_KEY_ID"],
                   "SECRET_ACCESS_KEY": os.environ["R2_SECRET_ACCESS_KEY"]})


def get_json(s3, key, default=None):
    try:
        return json.loads(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())
    except Exception:  # noqa: BLE001 — missing object
        return default


def put_json(s3, key, obj):
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(obj, ensure_ascii=False).encode(), ContentType="application/json", CacheControl="no-cache")


_jobs_lock = threading.Lock()


def set_job(s3, jid, **kw):
    """Update one job in jobs/index.json (a single server runs at a time, so read-modify-write is safe)."""
    with _jobs_lock:
        idx = get_json(s3, "jobs/index.json", {"jobs": []})
        jobs = idx.get("jobs", [])
        j = next((x for x in jobs if x["id"] == jid), None)
        if not j:
            j = {"id": jid}
            jobs.insert(0, j)
        j.update(kw)
        idx["jobs"], idx["at"] = jobs[:40], time.time()
        put_json(s3, "jobs/index.json", idx)


BOOT_LOG = Path("/workspace/boot.log")


def push_log(s3) -> None:
    """Copy the server log to storage (cloud/logs/<pod>.log) so a failure can be read after the server is gone."""
    try:
        if BOOT_LOG.exists():
            s3.put_object(Bucket=BUCKET, Key=f"cloud/logs/{POD}.log", Body=BOOT_LOG.read_bytes()[-2_000_000:], ContentType="text/plain; charset=utf-8")
    except Exception:  # noqa: BLE001
        pass


def heartbeat(s3, stop: threading.Event):
    while not stop.is_set():
        try:
            put_json(s3, "cloud/active.json", {"pod": POD, "at": time.time(), "since": T0})
        except Exception:  # noqa: BLE001 — a missed beat is fine
            pass
        push_log(s3)
        stop.wait(60)


def pending(s3) -> list[str]:
    ids = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix="inbox/", Delimiter="/"):
        ids += [p["Prefix"].split("/")[1] for p in page.get("CommonPrefixes", [])]
    out = []
    for jid in sorted(ids):
        man = get_json(s3, f"inbox/{jid}/manifest.json")
        if not man or man.get("runner") != "cloud":
            continue
        claim = get_json(s3, f"inbox/{jid}/claim.json")
        if claim and (claim.get("done") or (claim.get("pod") != POD and time.time() - claim.get("at", 0) < 3 * 3600)):
            continue
        out.append(jid)
    return out


def slug(s: str, taken: set[str]) -> str:
    base = re.sub(r"[^\w가-힣-]+", "-", s.strip()).strip("-").lower() or "scene"
    name, k = base, 2
    while name in taken:
        name, k = f"{base}-{k}", k + 1
    return name


def process(s3, jid: str) -> None:
    from .run import run_job
    man = get_json(s3, f"inbox/{jid}/manifest.json")
    put_json(s3, f"inbox/{jid}/claim.json", {"pod": POD, "at": time.time()})
    title = man.get("title") or "새 공간"
    set_job(s3, jid, title=title, state="running", label="촬영 파일 받는 중", error="", scene=None)
    media = WORK / jid / "media"
    media.mkdir(parents=True, exist_ok=True)

    def get(f):
        dst = media / Path(f["key"]).name
        if not (dst.exists() and dst.stat().st_size == f["size"]):
            s3.download_file(BUCKET, f["key"], str(dst))
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(get, man["files"]))

    taken = {s["name"] for s in get_json(s3, "scenes/index.json", {"scenes": []}).get("scenes", [])}
    name = slug(title, taken)
    n_photos = len(man["files"])
    draft = man.get("quality") == "draft"
    # quality first (대표 지시 2026-09-25): big captures get more Gaussians
    cap = 1_500_000 if draft else (4_000_000 if n_photos > 600 else 3_000_000)
    steps = 15000 if draft else 30000

    status = ROOT / "data" / "jobs" / name / "status.json"
    stop = threading.Event()

    def watch():
        last = ""
        while not stop.is_set():
            try:
                st = json.loads(status.read_text(encoding="utf-8"))
                run = next((v for v in st["stages"].values() if v.get("status") == "running"), None)
                if run:
                    pr = run.get("progress") or {}
                    pct = f" {int(100 * pr['step'] / pr['steps'])}%" if pr.get("steps") and pr.get("step") else ""
                    label = f"{run.get('label', '')}{pct}"
                    if label != last:
                        set_job(s3, jid, label=label)
                        last = label
            except Exception:  # noqa: BLE001 — status not written yet
                pass
            stop.wait(15)
    threading.Thread(target=watch, daemon=True).start()
    try:
        run_job([media], name, title, panorama=bool(man.get("panorama")), steps=steps, max_splats=cap,
                backend="gpu-local", test_every=0)
    finally:
        stop.set()
    set_job(s3, jid, label="웹에 올리는 중")
    pub = publish_scene(s3, name)
    st = json.loads(status.read_text(encoding="utf-8"))
    tr = st["stages"]["train"].get("info", {})
    set_job(s3, jid, state="done", label="완성", scene=name, splats=tr.get("num_splats"), mb=pub["mb"])
    put_json(s3, f"inbox/{jid}/claim.json", {"pod": POD, "at": time.time(), "done": True, "scene": name})


def shutdown(s3) -> None:
    print(f"[cloudjob] shutting down after {round(time.time() - T0)} s", flush=True)
    push_log(s3)
    secs = time.time() - T0
    month = time.strftime("%Y-%m", time.gmtime())
    try:
        put_json(s3, f"cloud/ledger/{month}/{POD}.json", {"pod": POD, "seconds": round(secs), "cost_per_hr": RATE,
                                                            "cost_usd": round(RATE * secs / 3600, 3), "at": time.time()})
        s3.delete_object(Bucket=BUCKET, Key="cloud/active.json")
    except Exception:  # noqa: BLE001
        pass
    if POD != "local":
        subprocess.run(["runpodctl", "remove", "pod", POD], capture_output=True)
        key = os.environ.get("RUNPOD_API_KEY")
        if key:  # fallback if runpodctl is missing
            subprocess.run(["curl", "-s", "-X", "DELETE", "-H", f"Authorization: Bearer {key}", f"https://rest.runpod.io/v1/pods/{POD}"], capture_output=True)


def own_rate() -> float:
    """This server's price, for the monthly ledger (RunPod gives pods a scoped RUNPOD_API_KEY)."""
    key = os.environ.get("RUNPOD_API_KEY")
    if RATE or not key or POD == "local":
        return RATE or 1.0
    try:
        import requests
        r = requests.get(f"https://rest.runpod.io/v1/pods/{POD}", headers={"Authorization": f"Bearer {key}"}, timeout=20)
        return float(r.json().get("costPerHr") or 1.0)
    except Exception:  # noqa: BLE001 — err on the high side
        return 1.0


def main() -> None:
    global RATE
    RATE = own_rate()
    print(f"[cloudjob] pod {POD} at ${RATE}/h", flush=True)
    s3 = s3c()
    stop = threading.Event()
    threading.Thread(target=heartbeat, args=(s3, stop), daemon=True).start()
    try:
        idle_checks = 0
        while idle_checks < 2:  # after the queue empties, look once more (an upload may have just finished)
            todo = pending(s3)
            if not todo:
                idle_checks += 1
                time.sleep(20)
                continue
            idle_checks = 0
            for jid in todo:
                try:
                    process(s3, jid)
                except BaseException as e:  # noqa: BLE001 — record (even exits/kills of children) and go on
                    msg = str(e).splitlines()[0][:200] if str(e) else type(e).__name__
                    print(traceback.format_exc(), flush=True)
                    set_job(s3, jid, state="error", error=msg)
                    put_json(s3, f"inbox/{jid}/claim.json", {"pod": POD, "at": time.time(), "done": True, "error": msg})
    except BaseException:
        print(traceback.format_exc(), flush=True)
        raise
    finally:
        stop.set()
        shutdown(s3)


if __name__ == "__main__":
    main()
