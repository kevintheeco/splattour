"""Publish scenes/<name> to R2 scenes/<name>/ WITHOUT touching scenes/index.json (link-only scene:
/tour.html?scene=<name>&from=cloud). Photos are copied server-side from the source scene's R2 folder.
    python runner/aisr/publish.py wolhajeong-ai wolhajeong"""
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from splattour.inbox import BUCKET, _put, client, keys  # noqa: E402
from splattour.lod import publish as lod_publish  # noqa: E402

name, photos_from = sys.argv[1], sys.argv[2]
s3 = client(keys())
sdir = ROOT / "scenes" / name
keys_src = []
for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=f"scenes/{photos_from}/photos/"):
    keys_src += [o["Key"] for o in page.get("Contents", [])]


def cp(k):
    s3.copy_object(Bucket=BUCKET, Key=k.replace(f"scenes/{photos_from}/", f"scenes/{name}/", 1), CopySource={"Bucket": BUCKET, "Key": k},
                   MetadataDirective="COPY")


with ThreadPoolExecutor(16) as ex:
    list(ex.map(cp, keys_src))
print("photos copied", len(keys_src))
for f in ("scene.spz", "scene.mobile.spz", "capture_path.json"):
    _put(s3, sdir / f, f"scenes/{name}/{f}")
print("lod", lod_publish(name))
_put(s3, sdir / "tour.json", f"scenes/{name}/tour.json")  # last: the scene appears only when everything is up
print("published", f"scenes/{name}/")
