"""Package the pipeline for the cloud GPU server and upload it to storage.

    pipeline/.venv/Scripts/python.exe runner/push.py

Bundle = pipeline/splattour (code), runner/boot.sh + panorama_sfm.py (COLMAP example,
BSD licence), and the compiled gsplat helper wheels (tools/wheels/pt24cu124). It is
stored under an unguessable key (the bucket is publicly readable by exact key); the
key goes to secrets/runner_bundle.txt and to the site's RUNNER_BUNDLE setting.
Run again after changing pipeline code.
"""
from __future__ import annotations

import io
import secrets
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from splattour.inbox import BUCKET, client, keys  # noqa: E402

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    for p in sorted((ROOT / "pipeline" / "splattour").rglob("*.py")):
        if "__pycache__" not in p.parts:
            tar.add(p, arcname=f"pipeline/{p.relative_to(ROOT / 'pipeline').as_posix()}")
    for name in ("boot.sh", "panorama_sfm.py"):
        tar.add(ROOT / "runner" / name, arcname=f"runner/{name}")
    for w in sorted((ROOT / "tools" / "wheels" / "pt24cu124").glob("*.whl")):
        tar.add(w, arcname=f"wheels/{w.name}")
data = buf.getvalue()
# The key stays the same across pushes (the site's RUNNER_BUNDLE setting points at it);
# delete secrets/runner_bundle.txt to rotate it, then update RUNNER_BUNDLE on Vercel.
ref = ROOT / "secrets" / "runner_bundle.txt"
key = ref.read_text().strip() if ref.exists() else f"_runner/{secrets.token_hex(16)}/bundle.tgz"
s3 = client(keys())
s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType="application/gzip", CacheControl="no-cache")
ref.write_text(key)
print(f"{key} {len(data) / 1e6:.1f} MB")
