/**
 * The editor's cards run on the 3D view's clock (owner, 2026-11-16: "the noise
 * node visual does not sync with the iframe"). The stage's `time` is three's
 * NodeFrame clock, restarted at 0 by every cold rebuild, while the editor's
 * counted from app load — so a noise card, a sin card and the Time hand ran
 * ahead of the mesh by however long the app had been open before the last
 * rebuild. The stage now reports the wall instant its `time` read 0, and
 * `followShaderClock` makes it the zero of `appTime`.
 *
 * Like fs-stats (previewStats.test.ts), the reporter lives in a template
 * string bound for the sandboxed iframe, so it is EXECUTED here against stubs
 * rather than only found in the HTML.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SHADER_CLOCK_MESSAGE, SHADER_CLOCK_SCRIPT, tslToPreviewHTML } from './tslToPreviewHTML';
import { appTime, followShaderClock } from '@/utils/appClock';

interface Stage {
  nodeFrame: { time?: unknown; lastTime?: unknown } | null;
  posted: Array<{ type: string; zero: number }>;
  /** Run the interval's report once. */
  poll: () => void;
}

function load(timeOrigin = 1_700_000_000_000): Stage {
  const body = SHADER_CLOCK_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const posted: Array<{ type: string; zero: number }> = [];
  const stage: Stage = { nodeFrame: { time: 0, lastTime: 0 }, posted, poll: () => {} };
  let interval: (() => void) | null = null;
  const win = {
    parent: { postMessage: (m: { type: string; zero: number }) => posted.push(m) },
    performance: { timeOrigin },
    __fsWhenSceneBooted: (fn: () => void) => fn(),
  };
  const doc = {
    querySelector: (sel: string) => (sel === 'a-scene'
      ? { renderer: stage.nodeFrame === null ? {} : { _nodes: { nodeFrame: stage.nodeFrame } } }
      : null),
  };
  const setIntervalStub = (fn: () => void) => { interval = fn; return 1; };
  new Function('window', 'document', 'setInterval', body)(win, doc, setIntervalStub);
  stage.poll = () => interval?.();
  return stage;
}

describe('SHADER_CLOCK_SCRIPT: the stage reports when its time was 0', () => {
  it('posts timeOrigin + lastTime − time once the renderer exists', () => {
    const s = load(1_000_000);
    expect(s.posted).toEqual([{ type: SHADER_CLOCK_MESSAGE, zero: 1_000_000 }]);
    s.nodeFrame = { time: 4.25, lastTime: 9_000 };
    s.poll();
    expect(s.posted[s.posted.length - 1]).toEqual({ type: SHADER_CLOCK_MESSAGE, zero: 1_000_000 + 9_000 - 4_250 });
  });

  it('is silent while the zero holds — a running document never moves it', () => {
    const s = load(5_000);
    s.nodeFrame = { time: 10, lastTime: 12_000 };
    s.poll();
    const n = s.posted.length;
    for (let i = 1; i <= 20; i++) {
      s.nodeFrame = { time: 10 + i * 0.5, lastTime: 12_000 + i * 500 + 0.3 }; // sub-ms drift
      s.poll();
    }
    expect(s.posted).toHaveLength(n);
  });

  it('reports again when the clock restarts (time back near 0)', () => {
    const s = load(0);
    s.nodeFrame = { time: 60, lastTime: 61_000 };
    s.poll();
    s.nodeFrame = { time: 0.016, lastTime: 90_016 };
    s.poll();
    expect(s.posted[s.posted.length - 1]?.zero).toBeCloseTo(90_000, 6);
  });

  it('posts nothing without three\'s NodeFrame, or with a junk clock — never a guess', () => {
    const missing = load();
    missing.nodeFrame = null;
    missing.posted.length = 0;
    missing.poll();
    expect(missing.posted).toHaveLength(0);
    const junk = load();
    junk.posted.length = 0;
    for (const nf of [{ time: Number.NaN, lastTime: 5 }, { time: 1, lastTime: undefined }, { time: '3', lastTime: 4 }]) {
      junk.nodeFrame = nf;
      junk.poll();
    }
    expect(junk.posted).toHaveLength(0);
  });
});

describe('wiring', () => {
  const code = 'const color = vec3(1.0, 0.0, 0.0);\nreturn { color };';

  it('the editor preview carries the reporter; the XR popup (no parent) does not', () => {
    expect(tslToPreviewHTML(code, { geometry: 'sphere' })).toContain(SHADER_CLOCK_SCRIPT);
    expect(tslToPreviewHTML(code, { geometry: 'sphere', xr: true })).not.toContain(SHADER_CLOCK_MESSAGE);
  });

  it('ShaderPreview hands the report to followShaderClock, from its own iframe only', () => {
    const src = readFileSync(path.join(__dirname, '../components/Preview/ShaderPreview.tsx'), 'utf8');
    const branch = src.indexOf('data.type === SHADER_CLOCK_MESSAGE');
    expect(branch).toBeGreaterThan(-1);
    // Inside the one handler that first checks e.source against the iframe.
    const sourceCheck = src.indexOf('if (e.source !== iframeRef.current?.contentWindow) return;');
    expect(sourceCheck).toBeGreaterThan(-1);
    expect(sourceCheck).toBeLessThan(branch);
    expect(src.slice(branch, branch + 600)).toContain('followShaderClock((data as { zero?: unknown }).zero)');
  });
});

describe('followShaderClock: appTime becomes the shader\'s time', () => {
  // The suite shares one module registry (isolate: false): put the zero back.
  const savedZero = -appTime(0) * 1000;
  afterAll(() => { followShaderClock(performance.timeOrigin + savedZero); });

  it('adopts a plausible zero: appTime is then seconds since it', () => {
    const now = performance.now();
    expect(followShaderClock(performance.timeOrigin + now - 42_000)).toBe(true);
    expect(appTime(now)).toBeCloseTo(42, 6);
    expect(appTime(now + 1500)).toBeCloseTo(43.5, 6);
  });

  it('ignores what a forged or broken report could hand it', () => {
    const now = performance.now();
    followShaderClock(performance.timeOrigin + now - 10_000);
    const before = appTime(now);
    for (const junk of [Number.NaN, Infinity, '123', null, undefined, {}, performance.timeOrigin + now + 5_000, performance.timeOrigin + now - 2e10]) {
      expect(followShaderClock(junk)).toBe(false);
    }
    expect(appTime(now)).toBe(before);
  });

  it('takes up to a second of skew between the two documents\' time origins', () => {
    const now = performance.now();
    expect(followShaderClock(performance.timeOrigin + now + 400)).toBe(true);
  });
});
