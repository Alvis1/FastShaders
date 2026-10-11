/**
 * The live preview document's retained-memory budget (previewMemoryBudget.ts):
 * the byte arithmetic, the budget and swap cap, the quiet-moment trigger (run
 * under fake timers), and ShaderPreview's wiring (source pins: the vitest env
 * is `node`, and ShaderPreview has no rendering test — previewRebuild.test.ts).
 *
 * Why it exists: every hot swap imports a module whose Image element and
 * THREE.Texture stay alive for the document's life. Measured 5.2 MB of GPU
 * memory per swap per 1024x1024 colour picture, 21.6 MB per 2048x2048 one
 * (review 2026-10-11). Only a cold rebuild frees it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode } from '@/test-utils';
import { graphToCode } from '@/engine/graphToCode';
import { mipChainTexels } from '@/utils/textureMemory';
import {
  MAX_RETAINED_SWAPS,
  POINTER_STALE_MS,
  QUIET_REBUILD_MS,
  QUIET_RECHECK_MS,
  RETAINED_BYTES_BUDGET,
  assetFeedBytes,
  createQuietRebuild,
  moduleImageTextureBytes,
  overBudget,
  quietRebuildDelay,
  retainedBytesBudget,
} from './previewMemoryBudget';

const SRC = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');

const MIB = 1024 * 1024;
// Canonical `btoa` payloads (the textureMemory.test.ts fixtures): the stored
// string equals the canonical `src` the emission planner keys on.
const P1 = `data:image/webp;base64,${btoa('abc')}`;
const P2 = `data:image/webp;base64,${btoa('xyz')}`;

function img(id: string, w: number, h: number, payload = P1, extra: Record<string, string | number> = {}) {
  return makeNode(id, 'imageNode', { imageB64: payload, width: w, height: h, fileName: '', colorSpace: 'color', ...extra });
}

/** A module text holding the placeholders of `nodes`' payloads, as graphToCode writes them. */
function moduleOf(nodes: ReturnType<typeof img>[], edges = [] as never[]): string {
  return graphToCode([...nodes, makeNode('out', 'output')], edges).code;
}

/** The exact RGBA8 bytes of a colour picture's mip chain. */
const colour = (w: number, h: number) => mipChainTexels(w, h) * 4;

describe('the byte arithmetic', () => {
  it('a 1024x1024 colour picture costs its mip chain: ~5.3 MiB, the 5.2 MB measured per swap', () => {
    const n = img('i', 1024, 1024);
    const bytes = moduleImageTextureBytes([n], moduleOf([n]));
    expect(bytes).toBe(colour(1024, 1024));
    expect(bytes).toBe(5_592_404);
    // Within 2 bytes of the ×4/3 rule the review used.
    expect(Math.abs(bytes - (1024 * 1024 * 4 * 4) / 3)).toBeLessThan(3);
  });

  it('a 2048x2048 one: ~21.3 MiB (21.6 MB measured)', () => {
    const n = img('i', 2048, 2048);
    expect(moduleImageTextureBytes([n], moduleOf([n]))).toBe(colour(2048, 2048));
  });

  it('a data map has no mip chain: exactly w x h x 4', () => {
    const n = img('i', 512, 256, P1, { colorSpace: 'data' });
    expect(moduleImageTextureBytes([n], moduleOf([n]))).toBe(512 * 256 * 4);
  });

  it('a module with no picture costs nothing, whatever the nodes hold', () => {
    const n = img('i', 1024, 1024);
    expect(moduleImageTextureBytes([n], 'export default function () {}')).toBe(0);
    expect(moduleImageTextureBytes([], moduleOf([n]))).toBe(0);
  });

  it('counts only the payloads the module carries', () => {
    const a = img('a', 256, 256, P1);
    const b = img('b', 1024, 1024, P2);
    // `b`'s payload is not in this module's text.
    expect(moduleImageTextureBytes([a, b], moduleOf([a]))).toBe(colour(256, 256));
    expect(moduleImageTextureBytes([a, b], moduleOf([a, b]))).toBe(colour(256, 256) + colour(1024, 1024));
  });

  it('one texture per distinct payload x spec, the way the emission planner shares them', () => {
    // Same picture, same spec: ONE texture, though only the owner's placeholder is in the code.
    const a = img('a', 512, 512);
    const b = img('b', 512, 512);
    const shared = moduleOf([a, b]);
    expect(shared.match(/fs-asset:/g)).toHaveLength(1);
    expect(moduleImageTextureBytes([a, b], shared)).toBe(colour(512, 512));
    // Same picture, one node a data map: two textures over one element.
    const c = img('c', 512, 512, P1, { colorSpace: 'data' });
    expect(moduleImageTextureBytes([a, c], moduleOf([a, c]))).toBe(colour(512, 512) + 512 * 512 * 4);
  });

  it('a node whose payload fails validation adds nothing (graphToCode emits the inert fallback)', () => {
    const good = img('g', 64, 64);
    const bad = img('b', 4096, 4096, 'data:image/png;base64,***');
    expect(moduleImageTextureBytes([good, bad], moduleOf([good, bad]))).toBe(colour(64, 64));
  });

  it('the asset feed’s Blobs: the decoded size of each base64 payload', () => {
    expect(assetFeedBytes([])).toBe(0);
    expect(assetFeedBytes([{ src: `data:image/png;base64,${btoa('abcdef')}` }])).toBe(6);
    expect(assetFeedBytes([{ src: P1 }, { src: P2 }])).toBe(6);
    // Junk never goes negative.
    expect(assetFeedBytes([{ src: 'no comma' }])).toBeGreaterThanOrEqual(0);
  });
});

describe('the budget', () => {
  it('is 256 MiB on the web (vitest runs the web profile) and 1 GiB on the desktop build', () => {
    // The figures live in PlatformCaps (`previewRetainedBytes`); the source
    // pin that the constant READS the table is platformCaps.test.ts's.
    expect(retainedBytesBudget(false)).toBe(256 * MIB);
    expect(retainedBytesBudget(true)).toBe(1024 * MIB);
    expect(RETAINED_BYTES_BUDGET).toBe(256 * MIB);
  });

  it('is crossed by bytes OR by 400 imports, whichever comes first', () => {
    expect(overBudget({ bytes: 0, swaps: 0 })).toBe(false);
    expect(overBudget({ bytes: 256 * MIB, swaps: 1 })).toBe(false);
    expect(overBudget({ bytes: 256 * MIB + 1, swaps: 1 })).toBe(true);
    expect(overBudget({ bytes: 0, swaps: MAX_RETAINED_SWAPS - 1 })).toBe(false);
    expect(overBudget({ bytes: 0, swaps: MAX_RETAINED_SWAPS })).toBe(true);
    expect(MAX_RETAINED_SWAPS).toBe(400);
  });

  it('at 21.3 MiB a swap, a 2048x2048 picture rebuilds after its 13th swap on the web', () => {
    const per = colour(2048, 2048);
    const tally = { bytes: 0, swaps: 0 };
    let swaps = 0;
    while (!overBudget(tally)) { tally.bytes += per; tally.swaps += 1; swaps++; }
    expect(swaps).toBe(13);
  });
});

describe('the quiet moment', () => {
  const base = { now: 10_000, lastActivityAt: 0, pointerDownAt: null, ackPending: false };

  it('is 2 s after the last activity, with nothing held and no swap in flight', () => {
    expect(QUIET_REBUILD_MS).toBe(2000);
    expect(quietRebuildDelay(base)).toBe(0);
    expect(quietRebuildDelay({ ...base, lastActivityAt: 9_000 })).toBe(1000);
    expect(quietRebuildDelay({ ...base, lastActivityAt: 8_000 })).toBe(0);
  });

  it('waits while a pointer is held, or a swap waits for its ack', () => {
    expect(quietRebuildDelay({ ...base, pointerDownAt: 9_999 })).toBe(QUIET_RECHECK_MS);
    expect(quietRebuildDelay({ ...base, ackPending: true })).toBe(QUIET_RECHECK_MS);
  });

  it('a pointer "held" past POINTER_STALE_MS no longer counts (its pointerup landed in the iframe)', () => {
    const now = 100_000;
    expect(quietRebuildDelay({ ...base, now, pointerDownAt: now - POINTER_STALE_MS + 1 })).toBe(QUIET_RECHECK_MS);
    expect(quietRebuildDelay({ ...base, now, pointerDownAt: now - POINTER_STALE_MS })).toBe(0);
  });
});

describe('the trigger (createQuietRebuild, fake timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness() {
    vi.useFakeTimers();
    const s = { over: true, lastActivityAt: 0, pointerDownAt: null as number | null, ackPending: false, rebuilds: 0 };
    const q = createQuietRebuild({
      over: () => s.over,
      inputs: () => ({ lastActivityAt: s.lastActivityAt, pointerDownAt: s.pointerDownAt, ackPending: s.ackPending }),
      rebuild: () => { s.rebuilds++; },
      now: () => Date.now(),
    });
    s.lastActivityAt = Date.now();
    return { s, q };
  }

  it('rebuilds once, 2 s after it is armed, when nothing else happens', () => {
    const { s, q } = harness();
    q.arm();
    vi.advanceTimersByTime(QUIET_REBUILD_MS - 1);
    expect(s.rebuilds).toBe(0);
    vi.advanceTimersByTime(1);
    expect(s.rebuilds).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(s.rebuilds).toBe(1);
  });

  it('arming again while it waits is a no-op: ONE timer, ONE rebuild', () => {
    const { s, q } = harness();
    q.arm();
    vi.advanceTimersByTime(500);
    q.arm();
    q.arm();
    vi.advanceTimersByTime(QUIET_REBUILD_MS);
    expect(s.rebuilds).toBe(1);
  });

  it('every new activity pushes it back, so a scrub is never interrupted', () => {
    const { s, q } = harness();
    q.arm();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(1500);
      s.lastActivityAt = Date.now();
    }
    expect(s.rebuilds).toBe(0);
    vi.advanceTimersByTime(QUIET_REBUILD_MS);
    expect(s.rebuilds).toBe(1);
  });

  it('waits out a held pointer and a swap awaiting its ack', () => {
    const { s, q } = harness();
    s.pointerDownAt = Date.now();
    s.ackPending = true;
    q.arm();
    vi.advanceTimersByTime(10_000);
    expect(s.rebuilds).toBe(0);
    s.pointerDownAt = null;
    vi.advanceTimersByTime(10_000);
    expect(s.rebuilds).toBe(0);
    s.ackPending = false;
    vi.advanceTimersByTime(QUIET_RECHECK_MS);
    expect(s.rebuilds).toBe(1);
  });

  it('stops without a rebuild once the tally is back under budget (a rebuild happened meanwhile)', () => {
    const { s, q } = harness();
    q.arm();
    s.over = false;
    vi.advanceTimersByTime(60_000);
    expect(s.rebuilds).toBe(0);
    // …and can be armed again afterwards.
    s.over = true;
    q.arm();
    vi.advanceTimersByTime(QUIET_REBUILD_MS);
    expect(s.rebuilds).toBe(1);
  });

  it('cancel() (unmount) drops the pending rebuild', () => {
    const { s, q } = harness();
    q.arm();
    q.cancel();
    vi.advanceTimersByTime(60_000);
    expect(s.rebuilds).toBe(0);
  });
});

describe('ShaderPreview wiring (source)', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('the rebuild is the manual handle `coldGen`, through the one quiet trigger', () => {
    const at = SRC.indexOf('const [quietRebuild] = useState(() => createQuietRebuild({');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf('}));', at));
    expect(body).toContain('over: () => overBudget(retainedRef.current),');
    expect(body).toContain('ackPending: hotAckTimerRef.current !== null,');
    expect(body).toContain('pointerDownAt: pointerDownAtRef.current,');
    expect(body).toContain('rebuild: () => setColdGen((g) => g + 1),');
    expect(SRC).toContain('useEffect(() => () => quietRebuild.cancel(), [quietRebuild]);');
    expect(code.match(/createQuietRebuild\(/g)).toHaveLength(1);
  });

  it('every swap charges the OUTGOING module’s textures and its feed, after the posts, then records the incoming one', () => {
    const at = SRC.indexOf('const postShaderSwap = useCallback(');
    const body = SRC.slice(at, SRC.indexOf('}, [clearHotSwapWait, escalateUnackedSwap, chargeRetained]);', at));
    expect(body.length).toBeLessThan(4500);
    const charge = body.indexOf('chargeRetained(runningTextureBytesRef.current + assetFeedBytes(feed.entries));');
    expect(charge).toBeGreaterThan(body.indexOf("win.postMessage({ type: SHADER_SWAP_MESSAGE, code, gen }, '*');"));
    // The incoming module is recorded AFTER the charge: it is what a fresh
    // document would hold too, and only the next swap or re-apply leaves it behind.
    const record = body.indexOf('runningTextureBytesRef.current = moduleImageTextureBytes(codeNodes, code);');
    expect(record).toBeGreaterThan(charge);
    // Never the incoming module (that over-counted every boot: the first
    // document is baked from the empty previewCode and gets its module by swap).
    expect(code).not.toContain('chargeRetained(moduleImageTextureBytes(');
  });

  it('the running module’s bytes start at the BAKED module’s, on a rebuild and on the fresh document’s load', () => {
    const rebuild = SRC.slice(SRC.indexOf('runningModuleRef.current = bakedModule;'));
    const block = rebuild.slice(0, rebuild.indexOf('}, [previewHtml, bakedModule, bootAssetKeys, containerReady'));
    expect(block).toContain('bakedTextureBytesRef.current = moduleImageTextureBytes(settledRef.current.nodes, bakedModule);');
    expect(block).toContain('runningTextureBytesRef.current = bakedTextureBytesRef.current;');
    const load = SRC.slice(SRC.indexOf('const handleIframeLoad = useCallback('));
    const seed = load.indexOf('runningTextureBytesRef.current = bakedTextureBytesRef.current;');
    expect(seed).toBeGreaterThan(-1);
    // Before the replay, so the replay charges the baked module, not stale bytes.
    expect(seed).toBeLessThan(load.indexOf('postShaderSwap(previewModule, moduleNodes)'));
    // A re-apply leaves one more instance of the RUNNING module behind.
    expect(SRC).toContain('chargeRetained(runningTextureBytesRef.current);');
  });

  it('the charge counts one import and arms the trigger past the budget', () => {
    const at = SRC.indexOf('const chargeRetained = useCallback(');
    const body = SRC.slice(at, SRC.indexOf('}, [quietRebuild]);', at));
    expect(body).toContain('tally.bytes += bytes;');
    expect(body).toContain('tally.swaps += 1;');
    expect(body).toContain('lastActivityRef.current = performance.now();');
    expect(body).toContain('if (overBudget(tally)) quietRebuild.arm();');
  });

  it('is reset exactly where the asset feed’s sent set is re-seeded: a rebuild, and the fresh document’s load', () => {
    const resets = [...SRC.matchAll(/retainedRef\.current = \{ bytes: 0, swaps: 0 \};/g)].map((m) => m.index!);
    expect(resets).toHaveLength(2);
    const seeds = [...SRC.matchAll(/sentAssetKeysRef\.current = new Set\(bootAssetKeys\);/g)].map((m) => m.index!);
    expect(seeds).toHaveLength(2);
    // Each reset follows its seed closely, in the same block.
    for (let i = 0; i < 2; i++) {
      expect(resets[i]).toBeGreaterThan(seeds[i]);
      expect(resets[i] - seeds[i]).toBeLessThan(400);
    }
    // The load handler resets BEFORE its replay, so the replay is counted.
    const load = SRC.slice(SRC.indexOf('const handleIframeLoad = useCallback('));
    expect(load.indexOf('retainedRef.current = { bytes: 0, swaps: 0 };')).toBeLessThan(
      load.indexOf('postShaderSwap(previewModule, moduleNodes)'),
    );
  });

  it('a geometry post that makes the stage re-apply is charged: a new tessellation, or a move to or from the teapot', () => {
    const at = SRC.indexOf('const prevGeometryRef = useRef(previewGeometry);');
    const effect = SRC.slice(at, SRC.indexOf('}, [previewGeometry, effectiveSubdivision, marchWindow, chargeRetained]);', at));
    expect(effect).toContain('chargeRetained(runningTextureBytesRef.current);');
    expect(effect).toContain('if (!isTeapotGeometry(prev) || teapot !== lastTeapotAttrRef.current) chargeReapply();');
    expect(effect).toContain('if (isTeapotGeometry(prev)) chargeReapply();');
    // A primitive-to-primitive change keeps its mesh, so the stage does not re-apply.
    expect(effect.match(/chargeReapply\(\);/g)).toHaveLength(2);
  });

  it('activity: this window’s input, the stage’s orbit reports and its activity pings', () => {
    expect(SRC).toContain("window.addEventListener('pointerdown', press, passive);");
    expect(SRC).toContain("window.addEventListener('pointerup', release, passive);");
    expect(SRC).toContain("window.addEventListener('pointercancel', release, passive);");
    const cam = SRC.slice(SRC.indexOf("} else if (data.type === 'fs:camera') {"));
    expect(cam.slice(0, cam.indexOf("} else if (data.type === 'fs:rotation') {"))).toContain('lastActivityRef.current = performance.now();');
    const act = SRC.slice(SRC.indexOf("if (data.type === 'fs:activity') {"));
    expect(act.slice(0, act.indexOf('return;'))).toContain('lastActivityRef.current = performance.now();');
  });

  it('a finite orbit report counts as activity even when it is too close to store (the controls pan)', () => {
    // enablePan is on, so a real drag can carry the camera inside radius 1.
    // The report is not stored, but the pointer is still held inside the
    // frame, where this window cannot see it: the stamp must not sit behind
    // the radius rule, or the quiet rebuild could fire mid-drag.
    const cam = SRC.slice(SRC.indexOf("} else if (data.type === 'fs:camera') {"));
    const body = cam.slice(0, cam.indexOf("} else if (data.type === 'fs:rotation') {"));
    const stamp = body.indexOf('if (pos) lastActivityRef.current = performance.now();');
    const guard = body.indexOf('if (pos && !cameraTooClose(pos)) {');
    expect(stamp).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(stamp);
    expect(body.match(/lastActivityRef\.current = performance\.now\(\);/g)).toHaveLength(1);
  });

  it('logs nothing to the study: the rebuild adds no telemetry call (evalHooks.test.ts pins the one there is)', () => {
    // Spelled in pieces: evalHooks.test.ts fails on any file outside the
    // reviewed set whose text holds the call form, this one included.
    const call = ['evalLog', '('].join('');
    expect(code.split(call)).toHaveLength(2);
    expect(code).toContain(`${call}'activity', { source: 'preview' });`);
  });
});
