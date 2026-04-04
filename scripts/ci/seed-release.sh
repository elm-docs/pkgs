#!/usr/bin/env bash
#
# Seed the GitHub release with a full database built locally.
#
# Prerequisites:
#   - Run inside `nix develop`
#   - npm ci already done
#   - GITHUB_TOKEN set in env (needs contents:write on elm-docs/pkgs)
#
# Usage:
#   GITHUB_TOKEN=ghp_... bash scripts/ci/seed-release.sh
#
set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "Error: GITHUB_TOKEN is not set"
  exit 1
fi

export GH_TOKEN="$GITHUB_TOKEN"

DB="elm-packages.db"
ARTIFACTS="artifacts"

echo "==> Step 1: Sync Elm packages (full, from scratch)"
npm run sync-elm-packages -- --db "./$DB" --concurrency 4 --delay 500

echo ""
echo "==> Step 2: Sync GitHub metadata"
npm run sync-github -- --db "./$DB" --force

echo ""
echo "==> Step 3: Generate release artifacts"
node scripts/ci/generate-artifacts.mjs \
  --db "./$DB" \
  --out "./$ARTIFACTS"

echo ""
echo "==> Step 4: Create release (if it doesn't exist)"
gh release create packages \
  --title "Package Database" \
  --notes "Pre-built Elm package database" 2>/dev/null || echo "Release already exists"

echo ""
echo "==> Step 5: Upload artifacts"
gh release upload packages \
  "$ARTIFACTS/elm-packages.db.zst" \
  "$ARTIFACTS/elm-packages-delta.json.zst" \
  "$ARTIFACTS/metadata.json" \
  "$ARTIFACTS/manifest.json" \
  --clobber

echo ""
echo "Done! Release seeded at:"
echo "  https://github.com/elm-docs/pkgs/releases/tag/packages"
