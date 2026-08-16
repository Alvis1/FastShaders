import { describe, it, expect, vi, afterEach } from 'vitest';
import { readPendingBenchResult, clearBenchResult, BENCH_RESULT_KEY } from './benchResult';
import { parseCostFile, profileFromParsed } from './costOverride';

/**
 * fs:benchResult is the same-browser handoff from a ShaderCarousel run to the
 * cost bar. It is localStorage, therefore ADVERSARIAL — whoever wrote it. The
 * reader must offer only payloads that survive the same gate a dropped file
 * passes, report already-imported runs as consumed, and never throw.
 */
describe('readPendingBenchResult', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(value: string | null) {
    const store: Record<string, string> = {};
    if (value !== null) store[BENCH_RESULT_KEY] = value;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      __store: store,
    });
    return store;
  }

  const PROFILE = JSON.stringify({
    meta: { device: 'quest-3', bench: 'microplane', generatedAt: '2026-08-14T09:00:00Z', valid: true },
    costs: { voronoi: 228, perlin: 34 },
  });

  it('offers a valid stored profile with label + content-hashed id', () => {
    stub(PROFILE);
    const r = readPendingBenchResult([]);
    expect(r).not.toBeNull();
    expect(r).not.toBe('consumed');
    const pending = r as Exclude<typeof r, 'consumed' | null>;
    expect(pending.label).toBe('quest-3');
    expect(pending.parsed.costs).toEqual({ voronoi: 228, perlin: 34 });
    // Same identity a real import would produce, so dedup works end to end.
    expect(pending.profileId).toBe(profileFromParsed(parseCostFile(PROFILE)!, 200, 2048).id);
  });

  it('reports an already-imported run as consumed (chip must not re-offer)', () => {
    stub(PROFILE);
    const id = profileFromParsed(parseCostFile(PROFILE)!, 0, 0).id;
    expect(readPendingBenchResult([id])).toBe('consumed');
  });

  it('absent key is null; garbage and oversize are consumed (caller clears)', () => {
    stub(null);
    expect(readPendingBenchResult([])).toBeNull();
    stub('not json');
    expect(readPendingBenchResult([])).toBe('consumed');
    stub(JSON.stringify({ foo: 1 }));
    expect(readPendingBenchResult([])).toBe('consumed');
    stub('{"costs":{"voronoi":1}}' + ' '.repeat(40_000));
    expect(readPendingBenchResult([])).toBe('consumed');
  });

  it('a profile whose every key is unknown is consumed, not offered empty', () => {
    stub(JSON.stringify({ meta: {}, costs: { notANode: 5 } }));
    expect(readPendingBenchResult([])).toBe('consumed');
  });

  it('clearBenchResult removes the key and never throws', () => {
    const store = stub(PROFILE);
    clearBenchResult();
    expect(store[BENCH_RESULT_KEY]).toBeUndefined();
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(() => clearBenchResult()).not.toThrow();
    expect(readPendingBenchResult([])).toBeNull();
  });
});
