---
name: fs-run
description: Launch the FastShaders dev server and drive the real app in real Chrome (Playwright, channel 'chrome') — screenshots, console errors, and the SANDBOXED 3D preview frame's own DOM. Use to run, screenshot or browser-verify a change in this repo, instead of guessing from tests.
---

# Run and drive FastShaders

The vitest suite is node-only (no DOM). Anything visual, anything about drag and drop, and anything
inside the preview iframe needs the real app in a real browser.

## 1. Dev server

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/FastShaders/   # 200 = already up, reuse it
```
If it is not up, start `npm run dev -- --port 5173 --strictPort` with `run_in_background: true`, then poll
that curl until it returns 200. The base path is `/FastShaders/`, so `/` returns 404. A server started with a trailing `&` dies with its
shell, so always use the background flag. Stop it at the end only if you started it.

## 2. First look

```bash
node .claude/skills/fs-run/drive.mjs [url] --shot <scratchpad>/shot.png [--wait 5000] [--headed]
```
This prints JSON: version meta, node and edge counts, the preview's `#preview-entity` attributes,
and console errors. Then `Read` the PNG to see it. For a sanity check, the demo graph is 6 nodes and 6 edges, and a sphere
preview has a `geometry` attribute. A loaded model has `obj-model`/`gltf-model` plus `fit-bounds`.

## 3. Scripted checks

Write a throwaway `.mjs` in the scratchpad that reuses the driver:
```js
const { open } = await import('/abs/path/.claude/skills/fs-run/drive.mjs');
const { browser, page, preview, errors } = await open();
// …interact…
await browser.close();
```
Recipes that have worked here:
- **Read the preview**: use `preview.evaluate(...)` on the frame from `page.frames()`. The parent page cannot
  read the opaque-origin iframe. The `srcdoc` ATTRIBUTE can disagree with the rendered document, so trust the frame's DOM.
- **Drop a file** (a model, shader or image): build the `File` plus `DataTransfer` inside `page.evaluate` and dispatch
  `dragenter`/`dragover`/`drop` on the target (`.shader-preview__body` for models). This runs the real drop path,
  including IndexedDB. A synthetic DragEvent can never reproduce a browser's own unhandled drop (Chromium opens the file).
- **Node menus**: right-click `.react-flow__node` and pick rows by `label:has-text("…")`.
- **Generated code**: join `.view-lines .view-line` textContent (Monaco).
- **Count preview documents**: install a MutationObserver on the iframe's `srcdoc` in `addInitScript`, but attach it on
  `readystatechange`, because `document.documentElement` is null at init time.
- **Study mode**: open `/FastShaders/eval` (also `/evalpro`, `/evalp`). The flag lives in sessionStorage, so use a fresh context.
- **Reset state**: use a new browser context (the driver's default). To keep state across reloads, reuse `page`.

## Limits

- Chromium only. The Playwright cache has webkit/firefox builds, but Safari's WebGPU→WebGL2 forcing is decided by UA.
  Treat a Safari claim as unverified unless it was run in Safari.
- The desktop (Tauri) build cannot be driven this way, and `tauri dev` cannot test microphone permissions.
- Headless WebGPU may fall back to WebGL2. Read `fs:backend`/the WGSL toggle state before blaming a backend.
