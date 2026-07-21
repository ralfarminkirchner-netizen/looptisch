#!/usr/bin/env bash
# LOOPTiSCH start — local demo-kit seeding + library scan, then server.
# Used by Railway (Procfile) and works locally too.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FLAG="$HERE/../flagship"
DOCS="$HERE/../docs"

# demo kit for fresh environments (Railway): real WAVs without the 2.5GB packs
if [ ! -d "$FLAG/library/packs/demo-kit" ] && [ -d "$DOCS/library/packs/demo-kit" ]; then
  mkdir -p "$FLAG/library/packs"
  cp -R "$DOCS/library/packs/demo-kit" "$FLAG/library/packs/demo-kit"
  echo "[start] demo-kit seeded"
fi

cd "$FLAG"
python library_scan.py || echo "[start] library_scan skipped (no packs)"
exec python server.py
