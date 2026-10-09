#!/usr/bin/env bash
# Release guard for the generated public/js copies.
#
# The repository does not track public/js/ (scripts/sync-generated.mjs writes
# it from the a-frame-shaderloader submodule at every dev/build/test start), so
# CI, the release pipeline and gh-pages serve the loader at the RECORDED
# submodule pointer — while a local host deploy builds from the WORKING TREE.
# A loader edited in the submodule but never committed as a pointer bump would
# therefore ship NEW bytes to alvismisjuns/sferas and OLD bytes everywhere else,
# with every test green. This stops that before a release or a host build.
#
# Runs from `npm version` (the "preversion" script) and from both
# scripts/deploy-*.sh before they build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

status="$(git submodule status a-frame-shaderloader)"
case "$status" in
  ' '*) ;;
  '-'*)
    echo "check-submodule: a-frame-shaderloader is not checked out — run: git submodule update --init" >&2
    exit 1 ;;
  *)
    echo "check-submodule: a-frame-shaderloader is not at the commit this repository records:" >&2
    echo "  $status" >&2
    echo "  Push the submodule, then commit the pointer bump (git add a-frame-shaderloader)." >&2
    exit 1 ;;
esac

if [ -n "$(git -C a-frame-shaderloader status --porcelain -- js)" ]; then
  echo "check-submodule: a-frame-shaderloader/js has uncommitted changes —" >&2
  echo "  commit and push them in the submodule, then commit the pointer bump." >&2
  exit 1
fi
