---
name: deploy
description: Ship FastShaders to ALL THREE targets — GitHub Pages + desktop binaries (release tag), alvismisjuns.lv, fs.sferas.lv (the study host) — in the one order that keeps exported shaders and the hosts in lockstep. Use whenever the user says "deploy", "deploy to all", "release", "ship it" or "push a new version" in this repo.
---

# Deploy FastShaders

"Deploy" is **standing authorization** to commit, push, tag and upload — do not ask again.
It ALWAYS means all three targets. Stopping after the tag leaves two hosts silently on an
older build (measured 2026-09-09: Pages 0.3.31, sferas 0.3.28). Reasoning behind every step:
`docs/dev/platform-and-release.md` (last section).

Work from the repo root. Run each step, check its result, and stop and report on the first failure. Never skip a step silently.

## 0. Gate

```bash
git status --short && git -C a-frame-shaderloader status --short
npx tsc --noEmit && npm test
```
Red → stop. Fix the failure, or report it if it lives in another session's work.

If another session is visibly mid-edit in this tree (files you did not touch that fail the
gate or look half-done), do NOT sweep them into the release. Commit only what is tested. For a version-only
bump use `npm version patch --no-git-tag-version`, commit `package.json` + `package-lock.json`,
then tag with `git tag -a vX.Y.Z -m vX.Y.Z` (a lightweight `git tag` is SKIPPED by `--follow-tags`).

## 1. Submodule first (only if `a-frame-shaderloader/` changed)

Exported `.js` load the loader from `cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master`.
Pushed after the app, it 404s for every recipient while working for the author, and jsdelivr
caches the 404.

1. Commit inside `a-frame-shaderloader/` and push `master` **from the MAIN checkout's submodule**.
   A worktree's `--shared` submodule has the main checkout as `origin`, so its push is refused.
2. Loaders 0.4/0.5/0.6 are FROZEN. The only change allowed to 0.8.x after its first push is an additive one.
3. Purge **every changed file** under `js/` and verify each one:
   ```bash
   f=js/a-frame-shaderloader-0.8.js   # repeat per changed file (decoders/ too)
   curl -s "https://purge.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/$f"
   curl -sL "https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/$f" | shasum -a 256
   shasum -a 256 "a-frame-shaderloader/$f"      # must match
   ```
4. Start vite once (or `npx vite build`) so `fs-vendor-sync` refreshes `public/js/`. Never hand-edit the copies.

## 2. Commit the parent

Stage what belongs to the release, including the submodule pointer bump and the synced `public/js/`.
Run `npm test` again. `release.yml` checks out the RECORDED pointer, and `vendorSync.test.ts` fails
before any binary builds if the pointer and the copies disagree. Commit and end the message
with the attribution trailer.

## 3. Release pipeline (Pages + macOS/Windows binaries)

```bash
npm version patch && git push --follow-tags
git ls-remote --tags origin "v$(node -p 'require("./package.json").version')"   # tag must be on the remote
gh run list --workflow release.yml -L 1        # a run for the tag must appear
gh run watch "$(gh run list --workflow release.yml -L 1 --json databaseId -q '.[0].databaseId')" --exit-status
```
- No run appeared (a GitHub webhook outage has already happened once): `gh workflow run release.yml --ref vX.Y.Z`.
- Never hand-upload a single-platform asset. The workflow publishes only when ALL assets land,
  so `/releases/latest` is never half-populated.
- Never force-push a tag. The fix is a fresh `npm version patch`.

## 4. alvismisjuns.lv

```bash
npm run deploy:alvismisjuns
```
Run it from the SAME tagged state: it deploys the working tree. Do not run `tauri build` between steps 3 and 4,
because a desktop build overwrites `dist/` with the desktop profile. The script checks the served
version meta with curl. Requires `psftp` (`brew install putty`) and the gitignored `.vscode/sftp.json`.

## 5. fs.sferas.lv — the STUDY host

```bash
npm run deploy:sferas
```
Base `/`, target `/var/www/fs/src`. NEVER use `/var/www/sferas/src`, which is shared with a dozen unrelated
projects. The script checks the version meta AND that `/evalp/` returns 200. If the user
has said a study cohort is currently running, HOLD this step: a participant's preview would
change loader mid-study. Say that you held it.

## 6. Verify and report

```bash
v=$(node -p 'require("./package.json").version')
for u in https://alvis1.github.io/FastShaders/ https://alvismisjuns.lv/fastshaders/ https://fs.sferas.lv/; do
  printf '%-40s ' "$u"; curl -sS -H 'Cache-Control: no-cache' "${u}index.html?cb=$(date +%s)" | grep -o 'name="version" content="[^"]*"'
done
```
Pages can lag a few minutes after the workflow finishes, so re-check before calling it behind.
Report one table: target, served version, status. Include the three `/releases/latest/download/`
assets (`FastShaders-macOS.dmg`, `FastShaders-Windows-Setup.exe`, `FastShaders-Windows-Portable.zip`)
checked with `curl -sIL -o /dev/null -w '%{http_code}'`.
