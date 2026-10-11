import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyWaveFrame, type WaveformDynamicRefs } from './WaveformSvg';
import { sameRange } from '../edges/EdgeInfoCard';

/**
 * The decorative canvas surfaces all tick on ONE shared 15 Hz frame loop
 * (utils/frameTicker, through hooks/useFrameLoop). Every frame with ANY canvas
 * write pays Chrome's whole-canvas layerization pass, so a single surface that
 * goes back to its own requestAnimationFrame loop brings the whole cost back
 * (measured 2026-10-11: one writer alone still cost 7.4–8.1 ms/frame of the
 * 8.8). These are .tsx components and the env is node, so the guard reads the
 * sources.
 */
const src = (f: string) => readFileSync(path.join(__dirname, f), 'utf8');

const SURFACES = [
  'LiveEdgeValue.tsx',
  'MathPreviewNode.tsx',
  'ClockNode.tsx',
  'PreviewNode.tsx',
  'SoundNode.tsx',
  '../edges/EdgeInfoCard.tsx',
];

describe('decorative surfaces stay on the shared frame ticker', () => {
  it.each(SURFACES)('%s ticks through useFrameLoop, with no private rAF loop or offsetParent probe', (f) => {
    const text = src(f);
    expect(text).toContain('useFrameLoop(');
    expect(text).not.toContain('requestAnimationFrame');
    // The ticker's IntersectionObserver is the one visibility gate; a per-tick
    // offsetParent read after another label's write forces a layout each.
    expect(text).not.toContain('.offsetParent');
  });
});

describe('no comment still points at a retired per-surface loop', () => {
  // EdgeInfoCard's tick reads useAppStore.getState(), so its `nodesRef` is
  // gone, and PreviewNode's own 30 Hz budget (ANIMATED_FRAME_MS) went with the
  // private loop: a comment citing either sends a reader to code that is not
  // there.
  it('ShaderPreview no longer cites EdgeInfoCard\'s nodesRef idiom', () => {
    const preview = src('../../Preview/ShaderPreview.tsx');
    expect(preview).not.toMatch(/nodesRef`? idiom/);
    expect(src('../edges/EdgeInfoCard.tsx')).not.toContain('nodesRef');
  });

  it('noisePreview names the shared ticker, not PreviewNode\'s old 30 Hz', () => {
    const noise = readFileSync(path.join(__dirname, '../../../utils/noisePreview.ts'), 'utf8');
    expect(noise).not.toContain('30 Hz per node');
    expect(noise).toContain('shared 15 Hz frame ticker');
    expect(src('PreviewNode.tsx')).not.toContain('ANIMATED_FRAME_MS');
  });
});

describe('EdgeInfoCard commits on the shared tick frame, not a later one', () => {
  // The chip is the one surface that renders through React state. A plain
  // setState from a frame callback is rendered by React's scheduler in a LATER
  // task, after the tick frame has painted, so the chip wrote on 15 frames of
  // its own every second (measured 2026-10-11, graph-150 with a Time wire
  // selected: 0 of 30 chip writes inside the frame; 2.5 -> 4.0 ms/frame at 1x
  // and 56% -> 90% busy at 4x). flushSync commits inside the tick.
  const card = src('../edges/EdgeInfoCard.tsx');

  it('the tick commits with flushSync, and only when the bounds moved', () => {
    expect(card).toMatch(/import \{ flushSync \} from 'react-dom';/);
    const tick = card.slice(card.indexOf('return (t) => {'));
    expect(tick.indexOf('sameRange(next, shown)')).toBeGreaterThan(0);
    expect(tick.indexOf('flushSync(() => setRange(next))')).toBeGreaterThan(tick.indexOf('sameRange(next, shown)'));
  });

  it('the first draw, inside the effect, is a plain update (flushSync cannot commit there)', () => {
    const factory = card.slice(card.indexOf('useFrameLoop('), card.indexOf('return (t) => {'));
    expect(factory).toContain('setRange(shown);');
    expect(factory).not.toContain('flushSync(');
  });

  it('sameRange compares every channel exactly, NaN included', () => {
    const r = (min: number[], max: number[]) => ({ min, max });
    expect(sameRange(null, null)).toBe(true);
    expect(sameRange(r([0.5], [0.5]), null)).toBe(false);
    expect(sameRange(r([0.5, 1], [0.5, 1]), r([0.5, 1], [0.5, 1]))).toBe(true);
    expect(sameRange(r([0.5, 1], [0.5, 1]), r([0.5, 1.0001], [0.5, 1]))).toBe(false);
    expect(sameRange(r([0.5], [0.5]), r([0.5, 0], [0.5, 0]))).toBe(false);
    expect(sameRange(r([NaN], [Infinity]), r([NaN], [Infinity]))).toBe(true);
    expect(sameRange(r([0], [0]), r([-0], [0]))).toBe(false);
  });
});

describe('LiveEdgeValue width reservation is opt-in, from the row layout only', () => {
  it('ShaderNode passes reserveWidth exactly once — the row-layout label', () => {
    const shader = src('ShaderNode.tsx');
    expect(shader.match(/<LiveEdgeValue [^>]*reserveWidth/g)?.length).toBe(1);
    const row = shader.slice(shader.indexOf('{row.input && inputConnected && (() => {'));
    expect(row.slice(0, 600)).toMatch(/<LiveEdgeValue className="shader-node__edge-val" reserveWidth \{\.\.\.info\} \/>/);
  });

  it.each(['OutputNode.tsx', 'RaymarchOutputNode.tsx', 'SplatOutputNode.tsx', 'SoundNode.tsx', 'ClockNode.tsx'])(
    '%s never reserves (Output cells are a FIXED 20px width)',
    (f) => {
      expect(src(f)).not.toContain('reserveWidth');
    },
  );

  it('measures in px from scrollWidth, never `ch`, and clears the min-width when it stops', () => {
    const text = src('LiveEdgeValue.tsx');
    expect(text).toContain('el.style.minWidth = `${w + 1}px`');
    expect(text).not.toMatch(/minWidth = `[^`]*ch`/);
    expect(text).toContain("el.style.minWidth = ''");
  });
});

/** A fake SVG element: just the attribute surface applyWaveFrame touches. */
function fakeEl() {
  const attrs = new Map<string, string>();
  const el = {
    writes: 0,
    textContent: '' as string | null,
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => { el.writes++; attrs.set(n, v); },
  };
  return el;
}
function refs() {
  const els = { curve: fakeEl(), drop: fakeEl(), dot: fakeEl(), pill: fakeEl(), text: fakeEl() };
  const r = Object.fromEntries(
    Object.entries(els).map(([k, v]) => [k, { current: v }]),
  ) as unknown as WaveformDynamicRefs;
  const writes = () => Object.values(els).reduce((s, e) => s + e.writes, 0);
  return { els, r, writes };
}

describe('applyWaveFrame writes only what moved', () => {
  it('a repeated frame writes nothing', () => {
    const { r, writes } = refs();
    const label = { current: null as string | null };
    applyWaveFrame(r, Math.sin, 'sin', 1.25, label);
    const first = writes();
    expect(first).toBeGreaterThan(0);
    applyWaveFrame(r, Math.sin, 'sin', 1.25, label);
    expect(writes()).toBe(first);
  });

  it('the visibility pair is written once, not every frame', () => {
    const { els, r } = refs();
    const label = { current: null as string | null };
    for (const phase of [0.1, 0.2, 0.3, 0.4]) applyWaveFrame(r, Math.sin, 'sin', phase, label);
    // transform, cy/y2 and the pill move every frame; visibility never does.
    expect(els.dot.writes).toBe(1 /* visibility */ + 4 /* cy */);
    expect(els.drop.writes).toBe(1 + 4);
    expect(els.curve.writes).toBe(4);
  });

  it('compares against the DOM, so a value React (or a remount) put back is rewritten', () => {
    const { els, r } = refs();
    const label = { current: null as string | null };
    applyWaveFrame(r, Math.sin, 'sin', 0.5, label);
    const tf = els.curve.getAttribute('transform');
    // A declarative re-render patches the attribute behind the writer's back.
    els.curve.setAttribute('transform', 'translate(0 0)');
    const before = els.curve.writes;
    applyWaveFrame(r, Math.sin, 'sin', 0.5, label);
    expect(els.curve.writes).toBe(before + 1);
    expect(els.curve.getAttribute('transform')).toBe(tf);
  });

  it('a non-finite phase hides the dot and drop line', () => {
    const { els, r } = refs();
    applyWaveFrame(r, Math.sin, 'sin', NaN, { current: null });
    expect(els.dot.getAttribute('visibility')).toBe('hidden');
    expect(els.drop.getAttribute('visibility')).toBe('hidden');
    expect(els.text.textContent).toBe('…');
  });
});
