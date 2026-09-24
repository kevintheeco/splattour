"""Follow a cloud runner from the laptop: job state changes, then the server log.
    pipeline/.venv/Scripts/python.exe runner/watch.py <pod_id> <job_id>"""
import json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from splattour.inbox import BUCKET, client, keys

POD, JID = sys.argv[1], sys.argv[2]
s3 = client(keys())
def g(k, raw=False):
    try:
        b = s3.get_object(Bucket=BUCKET, Key=k)["Body"].read()
        return b if raw else json.loads(b)
    except Exception:
        return None
t0, last, j = time.time(), None, None
while time.time() - t0 < 5 * 3600:
    claim = g(f"inbox/{JID}/claim.json") or {}
    jobs = (g("jobs/index.json") or {}).get("jobs", [])
    j = next((x for x in jobs if x["id"] == JID), None)
    mine = claim.get("pod") == POD
    cur = (mine, (j or {}).get("state"), (j or {}).get("label"), (j or {}).get("error"))
    if cur != last:
        print(round((time.time() - t0) / 60, 1), "min", cur, flush=True)
        last = cur
    if mine and j and j.get("state") in ("done", "error") and claim.get("done"):
        break
    if g(f"cloud/ledger/{time.strftime('%Y-%m', time.gmtime())}/{POD}.json"):
        print("server ended")
        break
    time.sleep(30)
time.sleep(60)
log = (g(f"cloud/logs/{POD}.log", raw=True) or b"").decode("utf-8", "replace")
print("---- log tail ----\n" + log[-3000:])
print("ledger", g(f"cloud/ledger/{time.strftime('%Y-%m', time.gmtime())}/{POD}.json"))
print("final", json.dumps(j, ensure_ascii=False))
