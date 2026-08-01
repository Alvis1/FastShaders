import { describe, it, expect, afterEach } from 'vitest';
import { parseCostFile, buildMergedComplexity, profileFromParsed, sanitizeCostMeta } from './costOverride';
import {
  setCostOverrides, getCost, nodeCostPoints, sanitizeCostMap, computeReachableCost,
} from './nodeCost';
import complexityData from '@/registry/complexity.json';
import { makeNode, makeEdge } from '@/test-utils';

const BASE = (complexityData as { costs: Record<string, number> }).costs;

// setCostOverrides mutates module singleton state — always clear it so tests
// don't leak the active table into one another.
afterEach(() => setCostOverrides(null));

describe('parseCostFile', () => {
  it('accepts the patch shape { costs }', () => {
    const parsed = parseCostFile(JSON.stringify({ costs: { voronoi: 230, perlin: 35 } }), 'p.json');
    expect(parsed).not.toBeNull();
    expect(parsed!.costs).toEqual({ voronoi: 230, perlin: 35 });
    expect(parsed!.meta.count).toBe(2);
    expect(parsed!.meta.source).toBe('p.json');
  });

  it('accepts the suggestion shape and strips group prefixes + reads metadata', () => {
    const file = JSON.stringify({
      metadata: { valid: true, bench: 'microplane', device: 'apple', timingMethod: 'gpu-timestamp' },
      suggestions: [
        { id: 'noise_voronoi', suggestedPoints: 228 },
        { id: 'noise_perlin', suggestedPoints: 34 },
        { id: 'preset_marble', suggestedPoints: 999 }, // 'marble' isn't a node key → dropped
      ],
    });
    const parsed = parseCostFile(file)!;
    expect(parsed.costs).toEqual({ voronoi: 228, perlin: 34 });
    expect(parsed.meta.valid).toBe(true);
    expect(parsed.meta.bench).toBe('microplane');
    expect(parsed.meta.device).toBe('apple');
    expect(parsed.meta.timingMethod).toBe('gpu-timestamp');
  });

  it('drops unknown keys and non-finite / negative values (adversarial)', () => {
    const parsed = parseCostFile(JSON.stringify({
      costs: { voronoi: -3, perlin: 'x', fbm: null, notARealNode: 5, cellNoise: 3, add: 0 },
    }))!;
    expect(parsed.costs).toEqual({ cellNoise: 3, add: 0 });
  });

  it('carries an invalid run through with reasons', () => {
    const parsed = parseCostFile(JSON.stringify({
      metadata: { valid: false, reasons: ['baseline-missing'] },
      suggestions: [{ id: 'noise_voronoi', suggestedPoints: 10 }],
    }))!;
    expect(parsed.meta.valid).toBe(false);
    expect(parsed.meta.reasons).toEqual(['baseline-missing']);
  });

  it('returns null for junk, empty, or non-cost JSON', () => {
    expect(parseCostFile('not json')).toBeNull();
    expect(parseCostFile('{}')).toBeNull();
    expect(parseCostFile(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseCostFile(JSON.stringify({ costs: {} }))).toBeNull();
    expect(parseCostFile(JSON.stringify({ costs: { notARealNode: 5 } }))).toBeNull();
    expect(parseCostFile(JSON.stringify({ suggestions: [] }))).toBeNull();
  });
});

describe('sanitizeCostMap', () => {
  it('keeps only known keys with finite non-negative numbers', () => {
    expect(sanitizeCostMap({ voronoi: 230, bogus: 1, perlin: -1, fbm: 95 })).toEqual({ voronoi: 230, fbm: 95 });
    expect(sanitizeCostMap(null)).toEqual({});
    expect(sanitizeCostMap('nope')).toEqual({});
  });

  it('clamps an absurd value so it cannot overflow to Infinity downstream', () => {
    expect(sanitizeCostMap({ mul: 1e308 }).mul).toBe(1_000_000);   // clamped, not Infinity when a chainable multiplies it
    expect(sanitizeCostMap({ voronoi: 500 }).voronoi).toBe(500);   // realistic value untouched
  });
});

describe('setCostOverrides reprices the live table', () => {
  it('getCost + nodeCostPoints reflect the override, and clearing restores base', () => {
    expect(getCost('voronoi')).toBe(BASE.voronoi);
    setCostOverrides({ voronoi: 230 });
    expect(getCost('voronoi')).toBe(230);
    // a non-overridden key is unchanged
    expect(getCost('perlin')).toBe(BASE.perlin);
    // nodeCostPoints (non-chainable) picks up the override
    expect(nodeCostPoints(makeNode('v1', 'voronoi'), [])).toBe(230);
    setCostOverrides(null);
    expect(getCost('voronoi')).toBe(BASE.voronoi);
  });
});

describe('computeReachableCost respects overrides', () => {
  it('sums only nodes reachable from output, using the active table', () => {
    const nodes = [
      makeNode('out', 'output'),
      makeNode('v', 'voronoi'),
      makeNode('p', 'perlin'),
      makeNode('orphan', 'voronoi'), // not wired to output → excluded
    ];
    const edges = [makeEdge('v', 'out', 'out', 'color'), makeEdge('p', 'out', 'v', 'pos')];
    expect(computeReachableCost(nodes, edges)).toBe(BASE.voronoi + BASE.perlin);
    setCostOverrides({ voronoi: 230 });
    expect(computeReachableCost(nodes, edges)).toBe(230 + BASE.perlin);
  });
});

describe('profileFromParsed', () => {
  it('builds a device profile: id from device|bench|date + costs-hash, label from device, given budget + texture cap', () => {
    const parsed = parseCostFile(JSON.stringify({
      metadata: { valid: true, bench: 'microplane', device: 'M4 Max', generatedAt: '2026-08-02T00:00:00Z' },
      suggestions: [{ id: 'noise_voronoi', suggestedPoints: 230 }],
    }))!;
    const profile = profileFromParsed(parsed, 260, 4096);
    expect(profile.id).toMatch(/^cp:M4 Max\|microplane\|2026-08-02T00:00:00Z\|/); // provenance + hash tail
    expect(profile.label).toBe('M4 Max');
    expect(profile.maxPoints).toBe(260);
    expect(profile.maxTextureDim).toBe(4096);
    expect(profile.costs).toEqual({ voronoi: 230 });
    expect(profile.meta.bench).toBe('microplane');
  });

  it('falls back label to bench, then to the source filename (sans .json)', () => {
    const noDevice = parseCostFile(JSON.stringify({ costs: { perlin: 30 } }), 'quest3-run.json')!;
    expect(profileFromParsed(noDevice, 200, 2048).label).toBe('quest3-run');
    expect(profileFromParsed(noDevice, 200, 2048).id).toMatch(/^cp:/);

    const benchOnly = parseCostFile(JSON.stringify({ meta: { bench: 'static' }, costs: { fbm: 90 } }))!;
    expect(profileFromParsed(benchOnly, 200, 2048).label).toBe('static');
    expect(profileFromParsed(benchOnly, 200, 2048).id).toMatch(/^cp:static\|/);
  });

  it('id is content-sensitive: same provenance + same costs dedups; different costs stays distinct', () => {
    const same1 = parseCostFile(JSON.stringify({ meta: { device: 'M4 Max', bench: 'static' }, costs: { voronoi: 230 } }))!;
    const same2 = parseCostFile(JSON.stringify({ meta: { device: 'M4 Max', bench: 'static' }, costs: { voronoi: 230 } }))!;
    const diff = parseCostFile(JSON.stringify({ meta: { device: 'M4 Max', bench: 'static' }, costs: { voronoi: 999 } }))!;
    expect(profileFromParsed(same1, 200, 2048).id).toBe(profileFromParsed(same2, 200, 2048).id);  // identical → dedup
    expect(profileFromParsed(same1, 200, 2048).id).not.toBe(profileFromParsed(diff, 200, 2048).id); // different run → kept
  });
});

describe('sanitizeCostMeta (persisted-profile hardening)', () => {
  it('coerces a non-array / absent reasons to [] and normalizes fields', () => {
    expect(sanitizeCostMeta({ valid: false, reasons: 42 }).reasons).toEqual([]);   // would crash reasons.join otherwise
    expect(sanitizeCostMeta({ valid: false }).reasons).toEqual([]);
    expect(sanitizeCostMeta({ reasons: ['a', 5, 'b'] }).reasons).toEqual(['a', 'b']);
    expect(sanitizeCostMeta(null)).toEqual({ source: null, device: null, bench: null, date: null, timingMethod: null, valid: null, reasons: [], count: 0 });
    expect(sanitizeCostMeta({ valid: 'yes' }).valid).toBeNull();  // non-boolean → null
    expect(sanitizeCostMeta({ device: 'M4', count: 3 })).toMatchObject({ device: 'M4', count: 3 });
  });
});

describe('buildMergedComplexity', () => {
  it('merges the override over base costs and keeps other keys + provenance', () => {
    const meta = { source: 'run.json', device: 'apple', bench: 'microplane', date: null, timingMethod: 'gpu-timestamp', valid: true, reasons: [], count: 1 };
    const merged = buildMergedComplexity({ voronoi: 230 }, meta);
    expect(merged.costs.voronoi).toBe(230);
    expect(merged.costs.perlin).toBe(BASE.perlin); // untouched key preserved
    expect((merged.meta.calibratedFrom as { device: string }).device).toBe('apple');
    expect((merged.meta.calibratedFrom as { nodes: string[] }).nodes).toEqual(['voronoi']);
  });
});
