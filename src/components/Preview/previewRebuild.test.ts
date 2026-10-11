/**
 * WHAT REBUILDS THE PREVIEW DOCUMENT AND WHAT DOES NOT.
 *
 * Since the shader hot-swap landed, a change to the module text is delivered
 * to the LIVE iframe over `fs:shader` and only a few inputs still force a
 * fresh `srcDoc`. Getting that split wrong does not crash and does not fail a
 * render test: it leaves a STALE PICTURE THAT LOOKS RIGHT, which is the worst
 * failure this feature can produce. So the classification is pinned here.
 *
 * These are SOURCE pins, deliberately. The vitest env is `node` — ShaderPreview
 * is a large .tsx with an iframe, postMessage and localStorage in it and
 * has never had a rendering test — so what can be checked is that the code
 * still says what the design says. In particular "names every document-memo
 * dependency" is a real drift guard rather than a restatement: a dep added to
 * the document memo must also be named in the classification comment above
 * it, or it fails. (The hooks the cold rebuild runs through ARE mounted, with
 * the real renderer, in settledPreview.test.ts.)
 *
 * NOT covered here, and nothing in a `node` env could cover it: that a live
 * material swap survives the r184 renderer, and that a failed apply visibly
 * drops the mesh to its stored grey original. Those are the owner's to see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');

/** The `useMemo` dep array that decides when a fresh document is built. */
function documentMemoDeps(): string[] {
  // The third element is the boot asset-key set (GLB Phase 6 S3, previewAssetFeed).
  const at = SRC.indexOf('const [previewHtml, bakedModule, bootAssetKeys] = useMemo(');
  expect(at, 'the document memo was renamed').toBeGreaterThan(-1);
  const close = SRC.indexOf('}, [', at);
  expect(close).toBeGreaterThan(at);
  const end = SRC.indexOf(');', close);
  return SRC.slice(close + 3, end)
    .replace(/[[\]\s]/g, '')
    .split(',')
    .filter(Boolean);
}

/** The closing line of `postShaderSwap`: the end marker every slice of its body uses. */
const POST_SHADER_SWAP_DEPS = '}, [clearHotSwapWait, escalateUnackedSwap, chargeRetained]);';

/** ShaderPreview's code with its comments cut out, for counting identifier uses. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('preview rebuild policy: the cold key', () => {
  it('is built from exactly the four inputs a fresh document is needed for', () => {
    const at = SRC.indexOf('const coldInputsKey =');
    expect(at).toBeGreaterThan(-1);
    const decl = SRC.slice(at, SRC.indexOf(';', at));
    // geometry (model plumbing baked at emit time), the renderer backend
    // (chosen by the pre-flight before the scene exists), and the escalation
    // counter. Nothing else may join without a line in the comment above it.
    expect(decl).toContain('geometryRebuildKey');
    expect(decl).toContain('forceWebGL2');
    expect(decl).toContain('coldGen');
    // The module joins the key ONLY with the hot path switched off — that is
    // what makes HOT_SWAP_ENABLED a real fallback rather than a label.
    expect(decl).toContain('HOT_SWAP_ENABLED');
    expect(decl).toContain('previewModule');
    // Hot inputs must never be part of it: each has its own postMessage
    // channel, and rebuilding for one throws the user's camera away.
    for (const hot of ['bgColor', 'effLighting', 'playing', 'effectiveSubdivision', 'marchWindow', 'renderContinuous', 'moduleAnimates']) {
      expect(decl, `${hot} must stay a hot channel`).not.toContain(hot);
    }
  });

  it('is the document memo’s only dependency', () => {
    expect(documentMemoDeps()).toEqual(['coldDocKey']);
  });

  it('a Gaussian splat adds nothing to it: its kind rides the mesh id, its report is display-only', () => {
    // A splat document differs from a mesh document only in what is decided at
    // emit time for the SAME `custom:<id>` key, so a splat is cold exactly
    // when any dropped model is. The sandbox's fs:model-splat report and the
    // pane notice must never rebuild the document they describe.
    const decl = SRC.slice(SRC.indexOf('const coldInputsKey ='), SRC.indexOf(';', SRC.indexOf('const coldInputsKey =')));
    expect(decl).not.toMatch(/splat/i);
    expect(SRC).toContain("(previewGeometry === 'custom' ? `custom:${previewMesh?.id ?? 0}` : previewGeometry)");
  });

  it('names every document-memo dependency in the classification comment', () => {
    // The comment IS the specification (the task that introduced this asked
    // for every dep to be classified in prose). An unnamed dep means someone
    // changed the policy without deciding what it means.
    const at = SRC.indexOf('WHAT REBUILDS THE DOCUMENT AND WHAT DOES NOT');
    expect(at).toBeGreaterThan(-1);
    const comment = SRC.slice(at, SRC.indexOf('const coldInputsKey =', at));
    expect(comment).toContain('HOT (');
    expect(comment).toContain('COLD (');
    for (const dep of documentMemoDeps()) expect(comment).toContain(dep);
    for (const cold of ['geometryRebuildKey', 'forceWebGL2', 'coldGen', 'previewModule', 'coldInputsKey']) {
      expect(comment).toContain(cold);
    }
  });

  it('classifies the render mode as HOT: its own message, replayed on ready, never a rebuild', () => {
    // Render on demand (previewRenderMode.ts). The stage boots continuous and
    // is told otherwise; rebuilding the document to say so would throw the
    // camera, the spin phase and `time` away for a flag.
    const at = SRC.indexOf('WHAT REBUILDS THE DOCUMENT AND WHAT DOES NOT');
    const comment = SRC.slice(at, SRC.indexOf('const coldInputsKey =', at));
    const hot = comment.slice(comment.indexOf('HOT ('), comment.indexOf('COLD ('));
    expect(hot).toContain('renderContinuous');
    expect(hot).toContain('fs:render-mode');
    // Posted by an effect keyed on the value alone, and from nowhere that
    // could rebuild: not the cold key, not the document memo.
    const effect = SRC.slice(SRC.indexOf('const moduleAnimates = useMemo('));
    expect(effect.slice(0, effect.indexOf('}, [renderContinuous]);'))).toContain(
      "iframeRef.current?.contentWindow?.postMessage({ type: RENDER_MODE_MESSAGE, continuous: renderContinuous }, '*');",
    );
    expect(documentMemoDeps()).toEqual(['coldDocKey']);
    const memo = SRC.slice(SRC.indexOf('const [previewHtml, bakedModule, bootAssetKeys] = useMemo('));
    expect(memo.slice(0, memo.indexOf('}, [coldDocKey]);'))).not.toMatch(/renderContinuous|RENDER_MODE_MESSAGE/);
    // Replayed on EVERY fs:preview-ready, like fs:stats-on: a fresh document
    // draws every frame until it is told otherwise.
    const ready = SRC.slice(SRC.indexOf("if (data.type === 'fs:preview-ready') {"));
    expect(ready.slice(0, ready.indexOf("} else if (data.type === 'fs:camera') {"))).toContain(
      "win.postMessage({ type: RENDER_MODE_MESSAGE, continuous: renderContinuousRef.current }, '*');",
    );
    expect(SRC).toContain('renderContinuousRef.current = renderContinuous;');
  });
});

/** The settled-pair hook's ONE call in ShaderPreview, up to its closing `});`. */
function settledPairCall(): string {
  const at = SRC.indexOf('const { settled: settledPreview, settlePending: settlePendingPreview } = useSettledPreview({');
  expect(at, 'the settled-pair call was renamed or reshaped').toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf('});', at));
}

describe('preview rebuild policy: every cold rebuild first settles the module’s debounced inputs', () => {
  // useSettledPreview.ts tells why; settledPreview.test.ts MOUNTS its hooks
  // with the real React renderer (one bake, of the edit; StrictMode; a newer
  // code held through React's rebase; the material settings; a graph edit
  // that moves the cold key itself, in either tree order; the trap of keying
  // the memo on the live inputs). These pin that ShaderPreview is wired the
  // one way those tests prove right, so no cold input, today's or a future
  // one, can rebuild the document around the settle.
  it('the document is keyed on the ADOPTED key, which only useColdRebuildKey produces', () => {
    expect(SRC).toContain(
      'const [coldDocKey, coldRebuildPending] = useColdRebuildKey(coldInputsKey, settleColdRebuild);',
    );
    expect(documentMemoDeps()).toEqual(['coldDocKey']);
    // The iframe moves with the document it holds (bootMeshWait.test.ts pins
    // the line itself).
    expect(SRC).toMatch(/key=\{coldDocKey\}\s*\n\s*ref=\{iframeRef\}/);
    expect(codeOnly(SRC).match(/useColdRebuildKey\(/g)).toHaveLength(1);
  });

  it('nothing but useColdRebuildKey reads the live inputs: the declaration and that call, no third use', () => {
    // A memo, an effect or an element key on `coldInputsKey` would rebuild
    // around the settle and bake the PREVIOUS module again.
    expect(codeOnly(SRC).match(/\bcoldInputsKey\b/g)).toHaveLength(2);
  });

  it('the first document is held while its cold key is adopted, so a boot with a model still builds ONE', () => {
    // The adoption waits for the commit's effects, so the render in which a
    // cached mesh lifts the boot hold still holds the sphere bake; every gate
    // (the iframe's srcDoc, the rebuild and swap effects) reads the combined
    // hold, which `holdsDocument` decides (settledPreview.test.ts mounts it).
    expect(SRC).toContain(
      'const waitingForBootMesh = holdsDocument(bootMeshHeld, coldRebuildPending, runningModuleRef.current !== null);',
    );
    expect(SRC).toContain('const bootMeshHeld = shouldWaitForBootMesh(');
    // Declared after the adopted key and before every gate that reads it.
    const decl = SRC.indexOf('const waitingForBootMesh =');
    expect(decl).toBeGreaterThan(SRC.indexOf('= useColdRebuildKey(coldInputsKey, settleColdRebuild);'));
    const code = codeOnly(SRC);
    const uses = [...code.matchAll(/\bwaitingForBootMesh\b/g)].map((m) => m.index!);
    expect(uses[0]).toBe(code.indexOf('const waitingForBootMesh =') + 'const '.length);
    expect(uses.length).toBeGreaterThan(1);
    // `bootMeshHeld` feeds the combined hold and nothing else.
    expect(code.match(/\bbootMeshHeld\b/g)).toHaveLength(2);
    // The latch is the first attach's: seeded by the rebuild effect, never null again.
    expect(code.match(/runningModuleRef\.current = null/g)).toBeNull();
  });

  it('the settle commits BOTH debounced inputs: the settled pair and the material settings’ key', () => {
    // The pair is the settled-pair hook's own, wired to the store and the window.
    const call = settledPairCall();
    expect(call).toContain('getState: useAppStore.getState,');
    expect(call).toContain('subscribe: useAppStore.subscribe,');
    expect(call).toContain('delayMs: PREVIEW_REBUILD_DEBOUNCE_MS,');
    expect(call).toContain('events: window,');
    // The material settings reach the module only through buildShaderModule's
    // option, so the code's settle cannot cover them: a cold key inside 200 ms
    // of a settings edit baked the previous Side / Transparent / … (review
    // 2026-10-09). Their own debounce is flushed by the same settle.
    expect(SRC).toContain(
      'const [debouncedMaterialSettingsKey, settleMaterialSettings] =\n    useDebounced(materialSettingsKey, PREVIEW_REBUILD_DEBOUNCE_MS);',
    );
    const at = SRC.indexOf('const settleColdRebuild = useCallback(() => {');
    expect(at).toBeGreaterThan(-1);
    // Up to the hook that calls it: a missing end marker would slice the rest
    // of the file, where these strings could sit anywhere.
    const end = SRC.indexOf('= useColdRebuildKey(coldInputsKey, settleColdRebuild);', at);
    expect(end).toBeGreaterThan(at);
    const settle = SRC.slice(at, end);
    expect(settle).toContain('settlePendingPreview();');
    expect(settle).toContain('settleMaterialSettings();');
    expect(settle).toContain('}, [settlePendingPreview, settleMaterialSettings]);');
    // Both are the cold rebuild's alone: the binding, the call and the dep.
    expect(codeOnly(SRC).match(/\bsettlePendingPreview\b/g)).toHaveLength(3);
    expect(codeOnly(SRC).match(/\bsettleMaterialSettings\b/g)).toHaveLength(3);
  });

  it('the remembered playhead resets when a document is BUILT for another model, never on the live key', () => {
    // The key is adopted a commit after it moves (a task later for an async
    // drop), and the outgoing document keeps reporting `fs:anim-time` until
    // it is replaced: a reset keyed on the live `geometryRebuildKey` let those
    // reports back in, so the next model started at the previous one's time
    // (review 2026-10-10, a scripted drop over a playing clip in real Chrome).
    const at = SRC.indexOf('const playheadModelRef = useRef(geometryRebuildKey);');
    expect(at).toBeGreaterThan(-1);
    const end = SRC.indexOf('}, [previewHtml]);', at);
    expect(end).toBeGreaterThan(at);
    const effect = SRC.slice(at, end);
    expect(effect).toContain('if (playheadModelRef.current === geometryRebuildKey) return;');
    expect(effect).toContain('animTimeRef.current = 0;');
    expect(effect).toContain('animClipRef.current = 0;');
    // The one reset of the remembered clip: a second one on the live key
    // would bring the leak back.
    expect(codeOnly(SRC).match(/animClipRef\.current = 0;/g)).toHaveLength(1);
  });
});

describe('preview rebuild policy: no closure keeps a replaced graph alive', () => {
  // Every closure created in one render shares ONE context holding each
  // variable any of them names, so a closure naming the settled nodes made
  // every callback of that render keep them, and a memoized one
  // (handleOpenVR, …) kept a replaced graph's images reachable long after the
  // history had let go (a heap probe, review 2026-10-09: 51.9 MB against
  // 21.9 MB). The three feed-planning closures read them through a ref.
  it('the pair is bound in render and handed to `settledRef`, and no closure names it', () => {
    const code = codeOnly(SRC);
    expect(SRC).toContain('const debouncedPreviewCode = settledPreview.code;');
    expect(SRC).toContain('const settledRef = useRef(settledPreview);\n  settledRef.current = settledPreview;');
    // The binding, `.code`, the ref's seed and its render-time write: a fifth
    // use would be a closure naming the pair.
    expect(code.match(/\bsettledPreview\b/g)).toHaveLength(4);
    expect(code).not.toContain('settledPreview.nodes');
  });

  it('the document memo, the hot swap and the load-time replay each read the nodes when they RUN', () => {
    const code = codeOnly(SRC);
    expect(code.match(/const moduleNodes = settledRef\.current\.nodes;/g)).toHaveLength(3);
    const memo = SRC.slice(SRC.indexOf('const [previewHtml, bakedModule, bootAssetKeys] = useMemo('));
    expect(memo.slice(0, memo.indexOf('const boot ='))).toContain('const moduleNodes = settledRef.current.nodes;');
    const swap = SRC.slice(SRC.indexOf('if (previewModule === runningModuleRef.current) return;'));
    expect(swap.slice(0, swap.indexOf('postShaderSwap('))).toContain('const moduleNodes = settledRef.current.nodes;');
    const load = SRC.slice(SRC.indexOf('const handleIframeLoad = useCallback('));
    expect(load.slice(0, load.indexOf('postShaderSwap('))).toContain('const moduleNodes = settledRef.current.nodes;');
    // So the load handler is no longer re-created for the nodes.
    expect(load.slice(0, load.indexOf('// Immersive VR entry.'))).toContain(
      '}, [previewGeometry, previewMesh, previewModule, bakedModule, bootAssetKeys, postShaderSwap, language, showDropNotice]);',
    );
  });
});

describe('preview rebuild policy: the module is the hot half', () => {
  it('depends on the shader code and the material settings, and on nothing else', () => {
    const at = SRC.indexOf('const previewModule = useMemo(');
    expect(at).toBeGreaterThan(-1);
    const decl = SRC.slice(at, SRC.indexOf('\n  );', at));
    // Material settings are a buildShaderModule OPTION, so they are module
    // text and travel down the hot channel with it.
    expect(decl).toContain('debouncedPreviewCode');
    expect(decl).toContain('debouncedMaterialSettingsKey');
    expect(decl).toContain('buildPreviewShaderModule');
    // Image payloads are NOT expanded into the module any more (GLB Phase 6
    // S3): the module stays placeholder-only on this side, the document
    // resolves the placeholders from the asset feed, and the boot list is
    // planned in the document memo — previewAssetFeed.test.ts pins the feed.
    expect(SRC).not.toContain('inlinedPreviewCode');
    const doc = SRC.slice(SRC.indexOf('const [previewHtml, bakedModule, bootAssetKeys] = useMemo('));
    expect(doc.slice(0, 500)).toContain('planPreviewAssetFeed(new Set(), collectImageAssets(');
  });

  it('is handed to the document so the baked copy and the channel agree byte for byte', () => {
    expect(SRC).toContain('shaderModule: previewModule');
    expect(SRC).toContain('return [tslToPreviewHTML(debouncedPreviewCode, options), previewModule, boot.sent] as const;');
  });
});

describe('preview rebuild policy: a lost swap must not leave the old picture', () => {
  it('posts the module with a generation number', () => {
    expect(SRC).toContain("win.postMessage({ type: SHADER_SWAP_MESSAGE, code, gen }, '*')");
    expect(SRC).toContain('const gen = ++hotGenRef.current;');
  });

  it('skips the post only when the LIVE document is already running these bytes', () => {
    // NOT "the document was baked with these bytes": the boot document is baked
    // with the empty red-sentinel shader and the real graph arrives by swap, so
    // a baked-compare skipped NEW (whose module is that sentinel) and left the
    // previous shader on screen — as did any undo back to the boot shader
    // (2026-09-11).
    expect(SRC).toContain('if (previewModule === runningModuleRef.current) return;');
    expect(SRC).not.toContain('if (previewModule === bakedModule) return;');
  });

  it('tracks what the live document runs: seeded on rebuild, advanced on every post', () => {
    expect(SRC).toContain('const runningModuleRef = useRef<string | null>(null);');
    const post = SRC.slice(SRC.indexOf('const postShaderSwap = useCallback('));
    expect(post.slice(0, post.indexOf(POST_SHADER_SWAP_DEPS))).toContain('runningModuleRef.current = code;');
    const rebuild = SRC.slice(SRC.indexOf('A new srcDoc means a full document reload'));
    expect(rebuild.slice(0, rebuild.indexOf('}, [previewHtml, bakedModule, bootAssetKeys, containerReady'))).toContain(
      'runningModuleRef.current = bakedModule;',
    );
    // The seed must run BEFORE the swap effect in the same commit, or a render
    // that both rebuilds and edits would post a module the fresh document
    // already boots with.
    expect(SRC.indexOf('runningModuleRef.current = bakedModule;')).toBeLessThan(
      SRC.indexOf('if (previewModule === runningModuleRef.current) return;'),
    );
  });

  it('treats only a gen-matched reply as proof the swap landed', () => {
    const at = SRC.indexOf("if (typeof data.hot === 'number')");
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 200);
    expect(block).toContain('if (data.hot !== hotGenRef.current) return;');
    expect(block).toContain('clearHotSwapWait();');
    // An untagged fs:preview-error is the error overlay's console.error
    // mirror, which fires for unrelated noise; an untagged fs:preview-ready is
    // the boot handshake. Neither may clear the wait, so the gen guard must be
    // the ONLY place inside the message handler that does.
    const start = SRC.indexOf('const handler = (e: MessageEvent) => {');
    const end = SRC.indexOf("window.addEventListener('message', handler);", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = SRC.slice(start, end);
    expect(handler.split('clearHotSwapWait()')).toHaveLength(2);
  });

  it('escalates an unanswered swap to a real document rebuild, through ONE stable helper', () => {
    // The timer's body is `escalateUnackedSwap`, so the swap and the boot
    // restart below arm the SAME escalation.
    const at = SRC.indexOf('const escalateUnackedSwap = useCallback(() => {');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf('}, []);', at));
    expect(body).toContain('hotAckTimerRef.current = null;');
    expect(body).toContain('setHotSwapSlow(false);');
    expect(body).toContain('setColdGen((g) => g + 1)');
    // Every arm of the ack timer hands it that helper, never an inline body.
    const arms = [...codeOnly(SRC).matchAll(/hotAckTimerRef\.current = window\.setTimeout\(([^,]*),/g)].map((m) => m[1]);
    expect(arms).toEqual(['escalateUnackedSwap', 'escalateUnackedSwap']);
    const post = SRC.slice(SRC.indexOf('const postShaderSwap = useCallback('));
    expect(post.slice(0, post.indexOf(POST_SHADER_SWAP_DEPS))).toContain(
      'hotAckTimerRef.current = window.setTimeout(escalateUnackedSwap, HOT_SWAP_ACK_TIMEOUT_MS);',
    );
  });

  it('restarts the countdown when the stage reports its backend, i.e. when boot() applies the held swap', () => {
    // The receiver HOLDS a swap posted before the scene exists and applies it
    // at boot, right before boot() posts fs:backend. The first document's real
    // module always arrives by swap (it is baked from the empty previewCode),
    // so a countdown armed at the post had spent the whole boot: under SwiftShader the 6 s watchdog fired mid-apply and built the
    // document twice (first good frame ~15 s, ~7.5 s with the restart — review
    // 2026-10-11, 4/4; a genuinely lost swap still escalated at boot + 6 s).
    const at = SRC.indexOf("if (data.type === 'fs:backend') {");
    expect(at).toBeGreaterThan(-1);
    const branch = SRC.slice(at, SRC.indexOf("if (data.type === 'fs:anim') {", at));
    expect(codeOnly(branch)).toContain(
      'if (hotAckTimerRef.current !== null) {\n' +
      '          window.clearTimeout(hotAckTimerRef.current);\n' +
      '          hotAckTimerRef.current = window.setTimeout(escalateUnackedSwap, HOT_SWAP_ACK_TIMEOUT_MS);\n' +
      '        }',
    );
    // RESTARTED, never cleared: only the gen-tagged ack proves a swap landed,
    // so a forged or early fs:backend can postpone the watchdog, not cancel it.
    expect(codeOnly(branch)).not.toContain('clearHotSwapWait');
    expect(codeOnly(branch)).not.toContain('hotAckTimerRef.current = null');
    // Armed only while a swap is waiting: a report with nothing in flight
    // starts no watchdog of its own.
    expect(codeOnly(branch).indexOf('if (hotAckTimerRef.current !== null)')).toBeLessThan(
      codeOnly(branch).indexOf('window.setTimeout(escalateUnackedSwap'),
    );
  });

  it('an UNTAGGED fs:preview-ready re-pushes the tuned values and leaves the watchdog alone (contract b)', () => {
    // After a geometry change makes the stage RE-APPLY the shader (the teapot's
    // new tessellation, a move to or from the teapot), the stage posts
    // fs:preview-ready with NO gen. The re-apply rebuilt the uniform map from
    // the schema, so the tuned values must be pushed again; and since nothing
    // proves the in-flight swap landed, the watchdog must keep running.
    const start = SRC.indexOf('const handler = (e: MessageEvent) => {');
    const end = SRC.indexOf("window.addEventListener('message', handler);", start);
    const handler = codeOnly(SRC.slice(start, end));
    // The gen guard sits ABOVE every branch and is skipped for an untagged reply…
    const guard = handler.indexOf("if (typeof data.hot === 'number') {");
    const ready = handler.indexOf("if (data.type === 'fs:preview-ready') {");
    expect(guard).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(guard);
    expect(handler.slice(guard, handler.indexOf('}', guard))).toContain('clearHotSwapWait();');
    // …and the ready branch itself reads no gen at all: the same re-push for
    // the boot handshake, a swap's ack and a re-apply.
    const branch = handler.slice(ready, handler.indexOf("} else if (data.type === 'fs:camera') {", ready));
    expect(branch).not.toContain('data.hot');
    expect(branch).not.toContain('clearHotSwapWait');
    expect(branch).not.toContain('hotAckTimerRef');
    expect(branch).toContain('for (const [name, value] of Object.entries(uniformValuesRef.current)) {');
    expect(branch).toContain("win.postMessage({ type: 'fs:uniform', name, value }, '*');");
  });

  it('gives up on the in-flight swap when a rebuild supersedes it', () => {
    const at = SRC.indexOf('A new srcDoc means a full document reload');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf('}, [previewHtml, bakedModule, bootAssetKeys, containerReady', at));
    expect(body).toContain('clearHotSwapWait();');
    expect(body).toContain('hotGenRef.current += 1;');
  });

  it('replays the swap on the fresh document\u2019s load event', () => {
    // The receiver's <script> parses below the ~1.65 MB bundle's blocking
    // script tags, so a module change landing during a cold rebuild's parse is
    // dropped outright. Waiting out the ack watchdog for that would leave the
    // previous shader on screen for seconds.
    const at = SRC.indexOf('const handleIframeLoad = useCallback(');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf('if (!isModelGeometry(previewGeometry)) return;', at));
    expect(body).toContain('previewModule !== bakedModule');
    // With the nodes that module was generated from (previewAssetFeed.test.ts).
    expect(body).toContain('postShaderSwap(previewModule, moduleNodes)');
  });

  it('also replays a swap still WAITING for its ack, even one that carried the baked module back', () => {
    // An edit and its undo inside the boot window post the baked module last,
    // and that post is lost like any other; gated on the baked module alone,
    // nothing replayed it and nothing answered its wait, so the pill stood
    // over a correct picture until the watchdog rebuilt the document for
    // nothing (review 2026-10-09). The receiver acks its own bytes at once.
    const at = SRC.indexOf('const handleIframeLoad = useCallback(');
    const body = SRC.slice(at, SRC.indexOf('if (!isModelGeometry(previewGeometry)) return;', at));
    expect(body).toContain(
      'if (HOT_SWAP_ENABLED && (previewModule !== bakedModule || hotAckTimerRef.current !== null)) {',
    );
    // The ack timer is exactly "a post not answered yet": armed by every post,
    // cleared by the gen-matched ack and by a rebuild.
    const post = SRC.slice(SRC.indexOf('const postShaderSwap = useCallback('));
    expect(post.slice(0, post.indexOf(POST_SHADER_SWAP_DEPS))).toContain('hotAckTimerRef.current = window.setTimeout(');
    const clear = SRC.slice(SRC.indexOf('const clearHotSwapWait = useCallback('));
    expect(clear.slice(0, clear.indexOf('}, []);'))).toContain('hotAckTimerRef.current = null;');
  });

  it('shows the pill only after a delay, and never covers a failed compile', () => {
    // A landed swap acks in tens of ms, so the ordinary edit draws nothing; a
    // FAILED one needs no pill at all, because the iframe puts red text over a
    // mesh the loader has already dropped back to its grey original.
    expect(SRC).toContain('HOT_SWAP_PILL_DELAY_MS');
    expect(SRC).toContain('{(compiling || hotSwapSlow) && (');
    // One translated sentence for both causes — a second string would ship
    // untranslated English in a Latvian-first app.
    expect(SRC.split("t('Compiling shader…', language)")).toHaveLength(2);
  });
});

describe('preview rebuild policy: a whole-graph replacement shows its own module first', () => {
  // components/Preview/settledPreview.ts tells the race; settledPreview.test.ts
  // runs the watcher and the real document. These pin the wiring that turns
  // the flush into "the new model's first shaded frame runs the new module".
  it('the settled pair is watched with the window as the replacement-event target', () => {
    const call = settledPairCall();
    expect(call).toContain('getState: useAppStore.getState,');
    expect(call).toContain('subscribe: useAppStore.subscribe,');
    expect(call).toContain('events: window,');
    // The state the watcher commits into (useSettledPreview.ts, mounted by
    // settledPreview.test.ts): seeded from the store, adopted whole.
    const HOOKS = readFileSync(resolve(__dirname, 'useSettledPreview.ts'), 'utf8');
    expect(HOOKS).toContain('useState(() => settledPreviewOf(getState()))');
    expect(HOOKS).toContain('commit: (next) => setSettled((prev) => adoptSettled(prev, next)),');
    // Still a subscription, never a selector on the per-scrub value.
    expect(SRC).not.toMatch(/useAppStore\(\(s\) => s\.previewCode\)/);
  });

  it('the load-time replay posts the module BEFORE the model feed', () => {
    // A module change that lands while the fresh document still parses is
    // lost; the replay re-sends it on `load`, and it must go before
    // `fs:obj-model`, whose model-loaded is what first shades the new mesh.
    // (A replacement that moves a cold key no longer needs it: the key is
    // adopted after the commit's effects, so its own module is baked.)
    const at = SRC.indexOf('const handleIframeLoad = useCallback(');
    const body = SRC.slice(at, SRC.indexOf('// Immersive VR entry.', at));
    const replay = body.indexOf('postShaderSwap(previewModule, moduleNodes)');
    const model = body.indexOf("type: 'fs:obj-model'");
    expect(replay).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(replay);
  });

  it('the swap effect posts the pair but re-runs only for what supersedes the swap in flight', () => {
    // Its cleanup cancels the in-flight swap's ack watchdog. Every dep below
    // replaces that swap (a new module, a new document, the gates); the nodes
    // alone do not, and two codes can build the same module
    // (settledPreview.test.ts runs that), so a nodes dep would cancel the
    // watchdog and then bail without arming a new one.
    const at = SRC.indexOf('if (previewModule === runningModuleRef.current) return;');
    const deps = SRC.slice(at, SRC.indexOf(']);', at) + 3);
    expect(deps).toContain('postShaderSwap(previewModule, moduleNodes);');
    expect(deps).toContain(
      '}, [previewModule, bakedModule, containerReady, waitingForBootMesh, postShaderSwap, clearHotSwapWait]);',
    );
    expect(deps.slice(deps.lastIndexOf('}, ['))).not.toContain('moduleNodes');
  });
});
