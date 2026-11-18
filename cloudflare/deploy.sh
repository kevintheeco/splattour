#!/usr/bin/env bash
# Build the viewer and deploy pochak.kr (Cloudflare Worker "pochak").
#   bash cloudflare/deploy.sh            build + deploy
#   bash cloudflare/deploy.sh --dry-run  build + show what would be uploaded
# Needs: npx wrangler login (Cloudflare account tinydots Inc.).
set -euo pipefail
cd "$(dirname "$0")/.."  # repo root
STORAGE=https://media.pochak.kr

( cd viewer && npm ci && VITE_STORAGE_URL="$STORAGE" npm run build )
# Same page layout as the old Vercel build: home is /, the tour is /tour.html.
mv viewer/dist/index.html viewer/dist/tour.html
mv viewer/dist/home.html viewer/dist/index.html
cp cloudflare/_headers cloudflare/_redirects viewer/dist/

cd cloudflare
npm ci
if [ "${1:-}" = "--dry-run" ]; then
  npx wrangler@4 deploy --dry-run
else
  npx wrangler@4 deploy
fi
