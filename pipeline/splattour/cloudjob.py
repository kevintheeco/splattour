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

Max quality (maxq.py, opt-in): a server started by `python -m splattour.maxq launch <id>` has
SPLATTOUR_ONLY_JOB=<id> and SPLATTOUR_QUALITY=max. It processes that one upload only, does not
announce itself in cloud/active.json (the site keeps starting ordinary servers for new uploads),
shows progress as a separate "<title> (최고 화질)" entry and archives results in cloud/max/<id>/.
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
ONLY = os.environ.get("SPLATTOUR_ONLY_JOB", "")  # maxq.launch: this server handles one upload only


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


def heartbeat(s3, stop: threading.Event, active: bool = True):
    while not stop.is_set():
        try:
            if active:
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
    if man and man.get("quality") == "max":  # not sent by the site today; see process_max
        return process_max(s3, jid, man, targeted=False)
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


def _gpu_mem_gb() -> float:
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=30)
        return round(float(r.stdout.split()[0]) / 1024, 1)
    except Exception:  # noqa: BLE001
        return 0.0


def process_max(s3, jid: str, man: dict, targeted: bool = True) -> None:
    """Max-quality job (maxq.run_job_max). Parameters come from the launcher's environment."""
    from .maxq import DEFAULTS, run_job_max
    env = os.environ.get
    publish = env("SPLATTOUR_PUBLISH", "1") != "0"
    arch = f"cloud/max/{jid}/"
    key = f"{jid}-max" if targeted else jid  # own entry on the home page, next to the automatic run's
    title = env("SPLATTOUR_TITLE") or f"{man.get('title') or '새 공간'} (최고 화질)"

    def job(**kw):
        if publish:
            set_job(s3, key, **kw)
    if not targeted:
        put_json(s3, f"inbox/{jid}/claim.json", {"pod": POD, "at": time.time()})
    job(title=title, state="running", label="촬영 파일 받는 중", error="", scene=None)
    media = WORK / jid / "media"
    media.mkdir(parents=True, exist_ok=True)

    def get(f):
        dst = media / Path(f["key"]).name
        if not (dst.exists() and dst.stat().st_size == f["size"]):
            s3.download_file(BUCKET, f["key"], str(dst))
    with ThreadPoolExecutor(32) as ex:
        list(ex.map(get, man["files"]))

    taken = {s["name"] for s in get_json(s3, "scenes/index.json", {"scenes": []}).get("scenes", [])}
    name = env("SPLATTOUR_SCENE") or slug(title, taken)
    side = int(env("SPLATTOUR_MAX_SIDE") or DEFAULTS["side"])
    cap = int(env("SPLATTOUR_MAX_CAP") or DEFAULTS["cap"])
    steps = int(env("SPLATTOUR_MAX_STEPS") or DEFAULTS["steps"])
    final = (env("SPLATTOUR_MAX_FINAL") or "1") != "0"
    mobile_cap = int(env("SPLATTOUR_MAX_MOBILE_CAP") or DEFAULTS["mobile_cap"])
    notes = []
    gpu_gb = _gpu_mem_gb()
    if gpu_gb and gpu_gb < 40:  # e.g. an ordinary 24 GB server picked this up: stay inside its memory
        side, cap = min(side, 2400), min(cap, 4_000_000)
        notes.append(f"{gpu_gb} GB GPU: side {side}, cap {cap}")
    if not targeted and float(env("MAX_HOURS") or 5) < 10 and final:  # an ordinary server's watchdog would cut the second run short
        final = False
        notes.append("MAX_HOURS < 10: no all-photos run")
    params = {"side": side, "cap": cap, "steps": steps, "final": final, "mobile_cap": mobile_cap, "gpu_gb": gpu_gb, "notes": notes,
              "pod": POD, "cost_per_hr": RATE}
    put_json(s3, arch + "params.json", params)
    print(f"[cloudjob] max job {jid} -> {name}: {params}", flush=True)

    status = ROOT / "data" / "jobs" / name / "status.json"
    stop = threading.Event()

    def watch():
        last, last_put = "", 0.0
        while not stop.is_set():
            try:
                st = json.loads(status.read_text(encoding="utf-8"))
                run = next((v for v in st["stages"].values() if v.get("status") == "running"), None)
                if run:
                    pr = run.get("progress") or {}
                    pct = f" {int(100 * pr['step'] / pr['steps'])}%" if pr.get("steps") and pr.get("step") else ""
                    label = f"{run.get('label', '')}{pct}"
                    if label != last:
                        job(label=label)
                        last = label
                if time.time() - last_put > 60:
                    put_json(s3, arch + "status.json", st)
                    last_put = time.time()
            except Exception:  # noqa: BLE001 — status not written yet
                pass
            stop.wait(15)
    threading.Thread(target=watch, daemon=True).start()

    sdir = ROOT / "scenes" / name
    results: dict = {"scene": name, "title": title, "published": publish, "params": params}

    def upload(path: Path, k: str):
        if path.exists():
            s3.upload_file(str(path), BUCKET, arch + k)

    def on_model(kind: str, info: dict):
        results[kind] = {k: info.get(k) for k in ("eval_psnr", "eval_ssim", "eval_lpips", "num_splats", "gpu_mem_gb", "train_seconds",
                                                  "setup_seconds", "command")}
        if publish:
            job(label="웹에 올리는 중")
            results[f"{kind}_web"] = publish_scene(s3, name)
            more = kind == "eval" and final
            job(label="점수용 모델 게시됨 · 최종 학습 중" if more else "완성", scene=name, state="running" if more else "done",
                splats=info.get("num_splats"), mb=results[f"{kind}_web"]["mb"])
        for f in ("tour.json", "scene.spz", "scene.mobile.spz", "build_report.json"):
            upload(sdir / f, f)
        put_json(s3, arch + "result.json", results)
    try:
        run_job_max([media], name, title, hi_side=side, steps=steps, max_splats=cap, final=final, mobile_max_splats=mobile_cap,
                    on_model=on_model)
    finally:
        stop.set()
        try:
            put_json(s3, arch + "status.json", json.loads(status.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            pass
    # the full model (the viewer's LoD build starts from it), the cameras, and gsplat's own numbers
    jdir = status.parent
    upload(sdir / "scene.ply", "scene.ply")
    for sub in ("sfm/dense/sparse/0", "sfm/dense_hi/sparse/0"):
        for f in (jdir / sub).glob("*.bin"):
            upload(f, f"{sub.replace('/', '_')}/{f.name}")
    for run in ("train", "train_final"):
        for f in (jdir / run / "result" / "stats").glob("*.json"):
            upload(f, f"{run}_stats/{f.name}")
        upload(jdir / run / "train.log", f"{run}.log")
    results["seconds"] = round(time.time() - T0)
    results["done"] = True
    put_json(s3, arch + "result.json", results)
    if not targeted:
        put_json(s3, f"inbox/{jid}/claim.json", {"pod": POD, "at": time.time(), "done": True, "scene": name})


def _arch(jid: str) -> str:
    v = os.environ.get("SPLATTOUR_VARIANT", "")
    return f"cloud/max/{jid}/{v}/" if v else f"cloud/max/{jid}/"


def process_max_stage(s3, jid: str, man: dict, stage: str) -> None:
    """Experiment servers of a max-quality campaign (maxq.launch --stage):
      sfm    photos -> ingest (normalised blur rule, CLAHE SfM copies) -> SfM with
             SPLATTOUR_CAMERA_MODEL -> full-resolution dataset, uploaded as <arch>dataset.tar
      train  <SPLATTOUR_DATASET_KEY> -> one gsplat run (SPLATTOUR_MAX_* and SPLATTOUR_MAX_FLAGS);
             scored runs keep stats / renders / spz in <arch>, SPLATTOUR_PUBLISH=1 publishes the tour."""
    import tarfile

    from .maxq import DEFAULTS
    env = os.environ.get
    arch = _arch(jid)
    work = WORK / jid
    work.mkdir(parents=True, exist_ok=True)
    res: dict = {"stage": stage, "variant": env("SPLATTOUR_VARIANT", ""), "pod": POD, "gpu_gb": _gpu_mem_gb(), "started": time.time()}

    def up(path: Path, k: str):
        if path.exists():
            s3.upload_file(str(path), BUCKET, arch + k)

    def put_status(**kw):
        res.update(kw)
        put_json(s3, arch + "result.json", res)

    if stage == "sfm":
        from .frames import ingest_hires
        from .sfm import hires_dataset, run_sfm
        media = work / "media"
        media.mkdir(parents=True, exist_ok=True)

        def get(f):
            dst = media / Path(f["key"]).name
            if not (dst.exists() and dst.stat().st_size == f["size"]):
                s3.download_file(BUCKET, f["key"], str(dst))
        put_status(label="downloading")
        with ThreadPoolExecutor(32) as ex:
            list(ex.map(get, man["files"]))
        put_status(label="ingest")
        res["ingest"] = ingest_hires([media], work / "images_hi", work / "images", hi_side=int(env("SPLATTOUR_MAX_SIDE") or 3200),
                                     sfm_clahe=(env("SPLATTOUR_SFM_CLAHE") or "1") != "0", blur=env("SPLATTOUR_BLUR") or "normalized")
        put_status(label="sfm")
        t = time.time()
        res["sfm"] = run_sfm(work / "images", work / "sfm", camera_model=env("SPLATTOUR_CAMERA_MODEL") or "OPENCV",
                             mapper=env("SPLATTOUR_MAPPER") or "global")
        res["sfm"]["wall_seconds"] = round(time.time() - t)
        put_status(label="hires")
        res["hires"] = hires_dataset(work / "sfm", work / "images_hi", work / "sfm" / "dense_hi")
        put_status(label="upload")
        tar = work / "dataset.tar"
        with tarfile.open(tar, "w") as tf:
            tf.add(work / "sfm" / "dense_hi" / "images", arcname="images")
            tf.add(work / "sfm" / "dense_hi" / "sparse" / "0", arcname="sparse/0")
        up(tar, "dataset.tar")
        for sub in ("sfm/dense/sparse/0", "sfm/dense_hi/sparse/0"):
            for f in (work / sub).glob("*.bin"):
                up(f, f"{sub.replace('/', '_')}/{f.name}")
        up(work / "sfm" / "sfm_stdout.log", "sfm_stdout.log")
        put_status(label="done", done=True, seconds=round(time.time() - T0))
        return

    # ---- train
    from .cloud import train_gsplat_local
    from .spz import ply_to_spz
    dkey = env("SPLATTOUR_DATASET_KEY")
    put_status(label="downloading dataset", dataset=dkey)
    ds = work / "dataset"
    if not (ds / "sparse" / "0" / "images.bin").exists():
        ds.mkdir(parents=True, exist_ok=True)
        s3.download_file(BUCKET, dkey, str(work / "dataset.tar"))
        with tarfile.open(work / "dataset.tar") as tf:
            tf.extractall(ds)
    steps = int(env("SPLATTOUR_MAX_STEPS") or DEFAULTS["steps"])
    cap = int(env("SPLATTOUR_MAX_CAP") or DEFAULTS["cap"])
    test_every = int(env("SPLATTOUR_TEST_EVERY") or 8)
    scaler = int(env("SPLATTOUR_MAX_SCALER") or (steps // 30000 if steps > 30000 and steps % 30000 == 0 else 1))
    flags = (env("SPLATTOUR_MAX_FLAGS") or "").split()
    publish = (env("SPLATTOUR_PUBLISH") or "0") != "0"
    res.update(steps=steps, cap=cap, test_every=test_every, steps_scaler=scaler, flags=flags, publish=publish)
    out = work / "train"

    def progress(d):
        if d.get("step") and d["step"] % max(1, steps // 20) < steps // 100 + 1:
            put_status(label="training", progress=d)
    put_status(label="training")
    info = train_gsplat_local(ds, out, steps=steps, cap_max=cap, test_every=test_every, progress=progress, steps_scaler=scaler, extra=flags)
    res["train"] = {k: v for k, v in info.items() if k != "ply"}
    put_status(label="archiving")
    for f in (out / "result" / "stats").glob("*.json"):
        up(f, f"stats/{f.name}")
    up(out / "train.log", "train.log")
    renders = sorted((out / "result" / "renders").glob("val_*.png"))
    for f in renders[::4]:
        up(f, f"renders/{f.name}")
    ply = Path(info["ply"])
    if publish:
        from .build_tour import build_tour
        from .photos import export_photos
        from .run import export_web
        name = env("SPLATTOUR_SCENE") or slug(env("SPLATTOUR_TITLE") or "scene", set())
        title = env("SPLATTOUR_TITLE") or name
        sdir = ROOT / "scenes" / name
        key = f"{jid}-max"
        set_job(s3, key, title=title, state="running", label="웹에 올리는 중", error="", scene=None)
        build_tour(ds / "sparse" / "0", ply, sdir, title=title)
        res["web"] = export_web(sdir, mobile_max_splats=int(env("SPLATTOUR_MAX_MOBILE_CAP") or DEFAULTS["mobile_cap"]))
        res["photos"] = export_photos(name, ds / "sparse" / "0", ds / "images")
        res["published"] = publish_scene(s3, name)
        res["scene"] = name
        set_job(s3, key, state="done", label="완성", scene=name, splats=info.get("num_splats"), mb=res["published"]["mb"])
        for f in ("tour.json", "scene.spz", "scene.mobile.spz", "build_report.json"):
            up(sdir / f, f)
    else:
        res["spz"] = ply_to_spz(ply, out / "scene.spz")
        up(out / "scene.spz", "scene.spz")
    up(ply, "scene.ply")
    put_status(label="done", done=True, seconds=round(time.time() - T0))


def main_targeted() -> None:
    """One max-quality upload (maxq.launch), then remove this server."""
    global RATE
    RATE = own_rate()
    print(f"[cloudjob] pod {POD} at ${RATE}/h, max-quality job {ONLY}", flush=True)
    s3 = s3c()
    stop = threading.Event()
    threading.Thread(target=heartbeat, args=(s3, stop, False), daemon=True).start()
    try:
        man = get_json(s3, os.environ.get("SPLATTOUR_MANIFEST") or f"inbox/{ONLY}/manifest.json")
        if not man:
            raise RuntimeError(f"no manifest for {ONLY}")
        stage = os.environ.get("SPLATTOUR_STAGE") or "full"
        if stage == "full":
            process_max(s3, ONLY, man, targeted=True)
        else:
            process_max_stage(s3, ONLY, man, stage)
    except BaseException as e:  # noqa: BLE001 — record, then shut down
        msg = str(e).splitlines()[0][:300] if str(e) else type(e).__name__
        print(traceback.format_exc(), flush=True)
        try:
            put_json(s3, _arch(ONLY) + "error.json", {"error": msg, "trace": traceback.format_exc()[-3000:], "at": time.time()})
            if os.environ.get("SPLATTOUR_PUBLISH", "1") != "0":
                set_job(s3, f"{ONLY}-max", state="error", error=msg)
        except Exception:  # noqa: BLE001
            pass
    finally:
        stop.set()
        shutdown(s3, clear_active=False)


def shutdown(s3, clear_active: bool = True) -> None:
    print(f"[cloudjob] shutting down after {round(time.time() - T0)} s", flush=True)
    push_log(s3)
    secs = time.time() - T0
    month = time.strftime("%Y-%m", time.gmtime())
    try:
        put_json(s3, f"cloud/ledger/{month}/{POD}.json", {"pod": POD, "seconds": round(secs), "cost_per_hr": RATE,
                                                            "cost_usd": round(RATE * secs / 3600, 3), "at": time.time(),
                                                            **({"job": ONLY, "quality": "max"} if ONLY else {})})
        if clear_active:
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
    if ONLY:
        return main_targeted()
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
