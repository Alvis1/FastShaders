/**
 * THE BOOT WINDOW IN WHICH A CACHED MESH IS STILL IN FLIGHT — and why the
 * preview must not attach a document inside it.
 *
 * A LEAF (no imports at all), so the rule is node-testable, for the reason
 * `previewGeometryPref.ts` states: ShaderPreview is a ~3000-line .tsx with an
 * iframe, postMessage and localStorage in it and has never been rendered in a
 * test, so the rule has to live somewhere a test can reach it.
 *
 * WHAT IT FIXES. On a reload with a dropped model the preview used to build
 * and attach TWO documents:
 *
 *   1. `usePersistedState` seeds `fs:previewGeometry` SYNCHRONOUSLY, so render
 *      #1 already has the preference 'custom' — while `previewMesh` is still
 *      the store default null (it is never persisted, only mirrored to
 *      IndexedDB). `shownGeometry` therefore derives 'sphere',
 *      `geometryRebuildKey` is '__primitive__', and the document memo bakes a
 *      REAL `geometry="primitive: sphere"` document.
 *   2. `setContainerReady(true)` runs SYNCHRONOUSLY in that same first
 *      passive-effect flush (the pane already has size on a reload — SplitPane
 *      renders inline percentages on its first render), while the IndexedDB
 *      restore effect in the same flush has only STARTED its async read. No
 *      promise continuation can run before the flush ends, so the sphere
 *      document is always attached first — for every mesh, of every size and
 *      kind — and the iframe begins loading the ~1.65 MB A-Frame bundle plus a
 *      WebGPU pre-flight into it.
 *   3. Hundreds of ms later the mesh lands, `coldDocKey` moves to
 *      `custom:<id>`, and React rewrites the `srcdoc` ATTRIBUTE of that same,
 *      still-loading, never-keyed iframe.
 *
 * So the whole of "a dropped model survives a reload" rested on step 3's
 * navigation reliably superseding an in-flight one. Nothing detects it if it
 * does not: `coldDocKey` never moves again (geometry, mesh id, forceWebGL2 and
 * coldGen are all stable afterwards), every later shader edit travels down the
 * HOT `fs:shader` channel into whatever document is live, and the hot-swap ack
 * watchdog — the only other thing that can force a cold rebuild — is disarmed
 * by the rebuild effect. The preview keeps working, animating and accepting
 * edits AS A SPHERE, while every piece of React state is already correct: the
 * Model dropdown reads "Model: <file>" because it derives from the SAME
 * `previewMesh` the document memo read. That is the owner's report of
 * 2026-09-19 ("i dropped in a glb multimesh — after pressing refresh it is
 * replaced by a sphere, but the model selector at the top shows that it is the
 * dropped in model"), and picking another model and coming back cures it
 * precisely because that rewrite happens on an iframe that has long FINISHED
 * loading.
 *
 * THE RULE: when the boot preference says a dropped model is expected, hold
 * the document back until the cache read has SETTLED, so boot builds ONE
 * document and it is already the model's. This is not only the race fix — it
 * also stops a full throwaway bundle load and the sphere-then-model flash that
 * every such reload paid for.
 *
 * It is a HOLD, never a block: `BOOT_MESH_WAIT_MS` caps it, and on the cap the
 * preview attaches exactly what it attaches today. A read that is slow because
 * IndexedDB is blocked or absent (`idbSafe`'s own timeout is 5 s) must never
 * leave the pane empty for that long.
 */

/**
 * How long the preview holds its first document while the cached mesh is read.
 *
 * A budget, not a deadline: the common read is tens of ms, and the wait is
 * paid against a boot that then spends SECONDS on the bundle and the shader
 * compile, behind the compiling overlay that is already up. Past this the
 * document attaches anyway and the existing cold-rebuild path takes the mesh
 * if it still arrives — i.e. the cap degrades to exactly today's behaviour,
 * never to something worse.
 */
export const BOOT_MESH_WAIT_MS = 1500;

/**
 * Whether the preview should still hold its `srcDoc` back.
 *
 * `bootWasCustom` is the module-init snapshot of `fs:previewGeometry`
 * (`previewMeshCache.bootGeometryWasCustom`) — sampled before React mounts, so
 * nothing can have rewritten it yet. When it is false no model is expected and
 * there is NOTHING to wait for: a session that never dropped a model must not
 * pay a millisecond of this.
 *
 * `hasMesh` ends the wait the moment a mesh exists by any route — the cache
 * read, or a drop/zip/GLB import that landed first (all synchronous). Read per
 * render rather than captured, so the hold cannot outlive the reason for it.
 */
export function shouldWaitForBootMesh(
  bootWasCustom: boolean,
  hasMesh: boolean,
  settled: boolean,
): boolean {
  return bootWasCustom && !hasMesh && !settled;
}
