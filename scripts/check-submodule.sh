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
# "Recorded" means the pointer COMMITTED in HEAD — not the index: a pointer
# bump that is only staged (`git add a-frame-shaderloader`) is in no commit and
# no tag, so it must not pass. And every exported shader loads the loader from
# jsdelivr's @master (CDN_BASE, src/engine/tslToShaderModule.ts), so the
# recorded commit must be ON the submodule's master: a pointer on a side branch
# ships an app whose exports run an older loader for every recipient while the
# author's own preview (the same-origin copy) works.
#
# Runs from `npm version` (the "preversion" script), `npm run deploy` and both
# scripts/deploy-*.sh before they build. Needs the network (it fetches the
# submodule's master), as every release and deploy does.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SUB=a-frame-shaderloader

case "$(git submodule status "$SUB")" in
  '-'*)
    echo "check-submodule: $SUB is not checked out — run: git submodule update --init" >&2
    exit 1 ;;
esac

recorded="$(git rev-parse "HEAD:$SUB")"
checked_out="$(git -C "$SUB" rev-parse HEAD)"
if [ "$recorded" != "$checked_out" ]; then
  echo "check-submodule: $SUB is at $checked_out, but HEAD records $recorded." >&2
  echo "  Push the submodule, then COMMIT the pointer bump (git add $SUB && git commit)." >&2
  exit 1
fi

if [ -n "$(git -C "$SUB" status --porcelain -- js)" ]; then
  echo "check-submodule: $SUB/js has uncommitted changes —" >&2
  echo "  commit and push them in the submodule, then commit the pointer bump." >&2
  exit 1
fi

# The URL .gitmodules records IS the repository jsdelivr serves (gh/Alvis1/a-frame-shaderloader) — never `origin`,
# which in a worktree's --shared submodule clone is the main checkout's submodule.
url="$(git config -f .gitmodules "submodule.$SUB.url")"
if ! git -C "$SUB" fetch --quiet "$url" master; then
  echo "check-submodule: could not fetch master from $url to check what jsdelivr serves (@master)." >&2
  exit 1
fi
if ! git -C "$SUB" merge-base --is-ancestor "$recorded" FETCH_HEAD; then
  echo "check-submodule: the recorded $SUB commit $recorded is not on its master branch —" >&2
  echo "  exported shaders load the loader from jsdelivr @master, so their recipients would run an older one." >&2
  echo "  Merge it into the submodule's master and push, purge jsdelivr for each changed file, then release." >&2
  exit 1
fi
