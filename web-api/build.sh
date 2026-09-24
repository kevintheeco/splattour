#!/usr/bin/env bash
# Assemble web-deploy/ (the public site): home + viewer build, bundled scenes,
# upload API. Deploy afterwards with tools/deploy-web (see docs/REMOTE_UPLOAD.md).
#   bash web-api/build.sh [scene ...]     (default: drjohnson)
set -euo pipefail
cd "$(dirname "$0")/.."  # repo root
SCENES=("${@:-drjohnson}")
STORAGE=$(grep -s '^PUBLIC_URL=' secrets/r2.txt | cut -d= -f2- | tr -d '\r' | sed 's:/*$::' || true)
( cd viewer && VITE_DEFAULT_SCENE="${SCENES[0]}" VITE_STORAGE_URL="$STORAGE" npm run build >/dev/null )
pipeline/.venv/Scripts/python.exe -c "import sys; sys.path.insert(0,'pipeline'); from splattour.catalog import build; build(sys.argv[1:])" "${SCENES[@]}" >/dev/null
find web-deploy -mindepth 1 -maxdepth 1 ! -name .vercel -exec rm -rf {} +
cp -r viewer/dist/* web-deploy/
mv web-deploy/index.html web-deploy/tour.html && mv web-deploy/home.html web-deploy/index.html
cp -r web-api/api web-api/package.json web-api/vercel.json web-deploy/
mkdir -p web-deploy/scenes
cp scenes/index.json web-deploy/scenes/
for s in "${SCENES[@]}"; do
  mkdir -p "web-deploy/scenes/$s"
  cp "scenes/$s/tour.json" "scenes/$s"/scene*.spz "web-deploy/scenes/$s/"
  [ -d "scenes/$s/photos" ] && cp -r "scenes/$s/photos" "web-deploy/scenes/$s/"
done
du -sh --exclude=.vercel web-deploy
