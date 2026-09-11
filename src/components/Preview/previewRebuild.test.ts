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
 * is a ~2600-line .tsx with an iframe, postMessage and localStorage in it and
 * has never had a rendering test — so what can be checked is that the code
 * still says what the design says. In particular the last test is a real drift
 * guard rather than a restatement: a dep added to the document memo must also
 * be named in the classification comment above it, or this fails.
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
  const at = SRC.indexOf('const [previewHtml, bakedModule] = useMemo(');
  expect(at, 'the document memo was renamed').toBeGreaterThan(-1);
  const close = SRC.indexOf('}, [', at);
  expect(close).toBeGreaterThan(at);
  const end = SRC.indexOf(');', close);
  return SRC.slice(close + 3, end)
    .replace(/[[\]\s]/g, '')
    .split(',')
    .filter(Boolean);
}

describe('preview rebuild policy: the cold key', () => {
  it('is built from exactly the four inputs a fresh document is needed for', () => {
    const at = SRC.indexOf('const coldDocKey =');
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
    for (const hot of ['bgColor', 'effLighting', 'playing', 'effectiveSubdivision', 'marchWindow']) {
      expect(decl, `${hot} must stay a hot channel`).not.toContain(hot);
    }
  });

  it('is the document memo’s only dependency', () => {
    expect(documentMemoDeps()).toEqual(['coldDocKey']);
  });

  it('names every document-memo dependency in the classification comment', () => {
    // The comment IS the specification (the task that introduced this asked
    // for every dep to be classified in prose). An unnamed dep means someone
    // changed the policy without deciding what it means.
    const at = SRC.indexOf('WHAT REBUILDS THE DOCUMENT AND WHAT DOES NOT');
    expect(at).toBeGreaterThan(-1);
    const comment = SRC.slice(at, SRC.indexOf('const coldDocKey =', at));
    expect(comment).toContain('HOT (');
    expect(comment).toContain('COLD (');
    for (const dep of documentMemoDeps()) expect(comment).toContain(dep);
    for (const cold of ['geometryRebuildKey', 'forceWebGL2', 'coldGen', 'previewModule']) {
      expect(comment).toContain(cold);
    }
  });
});

describe('preview rebuild policy: the module is the hot half', () => {
  it('depends on the shader code and the material settings, and on nothing else', () => {
    const at = SRC.indexOf('const previewModule = useMemo(');
    expect(at).toBeGreaterThan(-1);
    const decl = SRC.slice(at, SRC.indexOf('\n  );', at));
    // Material settings are a buildShaderModule OPTION, so they are module
    // text and travel down the hot channel with it.
    expect(decl).toContain('inlinedPreviewCode');
    expect(decl).toContain('debouncedMaterialSettingsKey');
    expect(decl).toContain('buildPreviewShaderModule');
    // Image payloads must still be expanded before the module runs.
    const inline = SRC.slice(SRC.indexOf('const inlinedPreviewCode = useMemo('));
    expect(inline.slice(0, 300)).toContain('inlineImageAssetsFromNodes');
    expect(inline.slice(0, 300)).toContain('debouncedPreviewCode');
  });

  it('is handed to the document so the baked copy and the channel agree byte for byte', () => {
    expect(SRC).toContain('shaderModule: previewModule');
    expect(SRC).toContain('return [tslToPreviewHTML(inlinedPreviewCode, options), previewModule] as const;');
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
    expect(post.slice(0, post.indexOf('}, [clearHotSwapWait]);'))).toContain('runningModuleRef.current = code;');
    const rebuild = SRC.slice(SRC.indexOf('A new srcDoc means a full document reload'));
    expect(rebuild.slice(0, rebuild.indexOf('}, [previewHtml, bakedModule, containerReady'))).toContain(
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

  it('escalates an unanswered swap to a real document rebuild', () => {
    const at = SRC.indexOf('hotAckTimerRef.current = window.setTimeout(');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf('HOT_SWAP_ACK_TIMEOUT_MS)', at));
    expect(body).toContain('setColdGen((g) => g + 1)');
  });

  it('gives up on the in-flight swap when a rebuild supersedes it', () => {
    const at = SRC.indexOf('A new srcDoc means a full document reload');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf('}, [previewHtml, bakedModule, containerReady', at));
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
    expect(body).toContain('postShaderSwap(previewModule)');
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
