import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseCostFile, buildMergedComplexity, profileFromParsed, sanitizeCostMeta, mergedComplexityFileName,
  createManualProfile, buildProfileFile, buildProfileBundle, parseCostProfileBundle, profileFileName,
} from './costOverride';
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

  it('accepts the RAW results shape { metadata, shaders } — the file users actually grab', () => {
    const file = JSON.stringify({
      metadata: {
        bench: 'microplane', gpu: 'qualcomm / adreno-7xx', timingMethod: 'gpu-timestamp',
        date: '2026-07-22', resolution: { width: 1024, height: 1024 },
      },
      shaders: [
        { id: 'ref_baseline', stats: { marginalPoints: 0 } },  // baseline prices nothing
        { id: 'noise_voronoi', stats: { marginalPoints: 228 } },
        { id: 'noise_perlin', stats: { marginalPoints: 34 } },
        { id: 'preset_marble', stats: { marginalPoints: 999 } }, // not a node key → dropped
        { id: 'noise_fbm', stats: { marginalPoints: null } },    // underivable → skipped
      ],
    });
    const parsed = parseCostFile(file, 'raw.json')!;
    expect(parsed.costs).toEqual({ voronoi: 228, perlin: 34 });
    expect(parsed.meta.valid).toBe(true);
    expect(parsed.meta.device).toBe('qualcomm / adreno-7xx');
    expect(parsed.meta.bench).toBe('microplane');
    expect(parsed.meta.date).toBe('2026-07-22');
  });

  it('derives validity gating for a raw run with the same gates the bench applies', () => {
    const base = {
      metadata: { resolution: { width: 8, height: 8 }, timingMethod: 'gpu-timestamp' },
      shaders: [
        { id: 'ref_baseline', stats: { marginalPoints: 0 } },
        { id: 'noise_voronoi', stats: { marginalPoints: 5 } },
      ],
    };
    expect(parseCostFile(JSON.stringify(base))!.meta.valid).toBe(true);

    const noBaseline = { ...base, shaders: base.shaders.slice(1) };
    const p1 = parseCostFile(JSON.stringify(noBaseline))!;
    expect(p1.meta.valid).toBe(false);
    expect(p1.meta.reasons.join(' ')).toContain('baseline-missing');

    const rafDelta = { ...base, metadata: { ...base.metadata, timingMethod: 'raf-delta' } };
    const p2 = parseCostFile(JSON.stringify(rafDelta))!;
    expect(p2.meta.valid).toBe(false);
    expect(p2.meta.reasons.join(' ')).toContain('raf-delta');

    const noRes = { ...base, metadata: { timingMethod: 'gpu-timestamp' } };
    const p3 = parseCostFile(JSON.stringify(noRes))!;
    expect(p3.meta.valid).toBe(false);
    expect(p3.meta.reasons.join(' ')).toContain('resolution-unknown');
  });

  it('raw and suggestion exports of the SAME run parse to identical prices (exporter↔importer drift pin)', () => {
    // The raw branch re-derives what bench-stats' buildSuggestion emits
    // (id → stats.marginalPoints). If either side drifts, the two files of a
    // committed run stop agreeing — this is the check that catches it.
    const dir = join(process.cwd(), 'ShaderCarousel', 'benchData', 'quest3-20260723');
    for (const bench of ['microplane', 'static']) {
      const names = readdirSync(dir);
      const rawName = names.find((f) => f.includes(`-${bench}-2026`) && f.endsWith('.json'))!;
      const sugName = names.find((f) => f.includes(`-${bench}-complexity-suggestion`))!;
      const raw = parseCostFile(readFileSync(join(dir, rawName), 'utf8'), rawName)!;
      const sug = parseCostFile(readFileSync(join(dir, sugName), 'utf8'), sugName)!;
      expect(raw, `${bench}: raw export must parse`).not.toBeNull();
      expect(raw.costs, bench).toEqual(sug.costs);
      expect(raw.meta.valid, bench).toBe(sug.meta.valid);
      expect(raw.meta.device, bench).toBe(sug.meta.device);
    }
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

describe('mergedComplexityFileName', () => {
  it('carries device slug + date so downloads from two runs never collide', () => {
    expect(mergedComplexityFileName({
      ...sanitizeCostMeta({}), device: 'qualcomm / adreno-7xx', date: '2026-07-22T21:36:00.000Z',
    })).toBe('complexity-qualcomm-adreno-7xx-2026-07-22.json');
  });
  it('degrades gracefully when provenance is missing', () => {
    expect(mergedComplexityFileName(null)).toBe('complexity-measured.json');
    expect(mergedComplexityFileName(sanitizeCostMeta({}))).toBe('complexity-measured.json');
  });
});

describe('sanitizeCostMeta (persisted-profile hardening)', () => {
  it('coerces a non-array / absent reasons to [] and normalizes fields', () => {
    expect(sanitizeCostMeta({ valid: false, reasons: 42 }).reasons).toEqual([]);   // would crash reasons.join otherwise
    expect(sanitizeCostMeta({ valid: false }).reasons).toEqual([]);
    expect(sanitizeCostMeta({ reasons: ['a', 5, 'b'] }).reasons).toEqual(['a', 'b']);
    expect(sanitizeCostMeta(null)).toEqual({ source: null, device: null, bench: null, date: null, timingMethod: null, valid: null, reasons: [], count: 0, manual: false });
    // Absent/……ish `manual` means MEASURED — every profile persisted before the
    // field existed is a benchmark import, and only an explicit true flips it.
    expect(sanitizeCostMeta({ manual: 'yes' }).manual).toBe(false);
    expect(sanitizeCostMeta({ manual: true }).manual).toBe(true);
    expect(sanitizeCostMeta({ valid: 'yes' }).valid).toBeNull();  // non-boolean → null
    expect(sanitizeCostMeta({ device: 'M4', count: 3 })).toMatchObject({ device: 'M4', count: 3 });
  });
});

describe('buildMergedComplexity', () => {
  it('merges the override over base costs and keeps other keys + provenance', () => {
    const meta = { source: 'run.json', device: 'apple', bench: 'microplane', date: null, timingMethod: 'gpu-timestamp', valid: true, reasons: [], count: 1, manual: false };
    const merged = buildMergedComplexity({ voronoi: 230 }, meta);
    expect(merged.costs.voronoi).toBe(230);
    expect(merged.costs.perlin).toBe(BASE.perlin); // untouched key preserved
    expect((merged.meta.calibratedFrom as { device: string }).device).toBe('apple');
    expect((merged.meta.calibratedFrom as { nodes: string[] }).nodes).toEqual(['voronoi']);
  });
});

describe('hand-authored profiles (New / Edit / Export)', () => {
  const manual = () => createManualProfile('My Device', 250, 2048, new Date('2026-08-18T10:00:00Z'));

  it('createManualProfile seeds the AUTHORED table and never claims to be measured', () => {
    const p = manual();
    // Seeded, not empty: an empty costs map is rejected by parseCostFile, is
    // dropped by the store's boot loader, and would give the user no node keys
    // to fill in. Until edited it prices exactly like the shipped table.
    expect(p.costs).toEqual(BASE);
    expect(p.costs).not.toBe(BASE);                 // a copy — editing must not touch the registry
    expect(p.meta.manual).toBe(true);
    expect(p.meta.valid).toBeNull();                // never `false`: no run was gated
    expect(p.meta.count).toBe(Object.keys(BASE).length);
    expect(p.id).toMatch(/^cp:manual:my-device-[a-z0-9]+$/);
    expect(p.maxPoints).toBe(250);
    expect(createManualProfile('   ', 1, 1).label).toBe('Custom profile');   // blank falls back
  });

  it('a written profile file round-trips through the SAME parser every entrance uses', () => {
    const p = manual();
    const parsed = parseCostFile(JSON.stringify(buildProfileFile(p)), 'fastshaders-profile-my-device.json');
    expect(parsed).not.toBeNull();
    expect(parsed!.meta.manual).toBe(true);
    expect(parsed!.self).toEqual({ id: p.id, label: 'My Device', maxPoints: 250, maxTextureDim: 2048 });
    // Rebuilt against a DIFFERENT active device: its own identity wins, so an
    // edited download lands back on the same row instead of forking.
    const back = profileFromParsed(parsed!, 200, 4096, [p]);
    expect(back.id).toBe(p.id);
    expect(back.label).toBe('My Device');
    expect(back.maxPoints).toBe(250);
  });

  it('a benchmark export carries no identity, so a run can never claim a profile row', () => {
    const suggestion = parseCostFile(JSON.stringify({
      metadata: { device: 'Quest 3', id: 'cp:manual:stolen', label: 'stolen' },
      suggestions: [{ id: 'noise_voronoi', suggestedPoints: 230 }],
    }), 'run.json');
    expect(suggestion!.self).toBeNull();
    expect(profileFromParsed(suggestion!, 200, 2048).id).toMatch(/^cp:Quest 3\|/);
  });

  it('validates every claimed field — a file is adversarial input', () => {
    const claim = (meta: Record<string, unknown>) =>
      parseCostFile(JSON.stringify({ meta, costs: { voronoi: 1 } }))!.self;
    expect(claim({ id: 'not-namespaced' })?.id ?? null).toBeNull();     // must be cp:…
    expect(claim({ id: `cp:${'x'.repeat(200)}` })?.id ?? null).toBeNull();
    expect(claim({ id: 'cp:a\u0007b' })?.id ?? null).toBeNull();      // control chars
    expect(claim({ id: 'cp:a\nb' })?.id ?? null).toBeNull();
    expect(claim({ id: 'cp:manual:ok-1' })!.id).toBe('cp:manual:ok-1');
    // A DERIVED id embeds the device string — spaces and slashes included, so
    // the shape this module mints must be claimable by the file it writes.
    expect(claim({ id: 'cp:qualcomm / adreno-7xx|microplane|2026-07-23|7xmtbb' })!.id)
      .toBe('cp:qualcomm / adreno-7xx|microplane|2026-07-23|7xmtbb');
    expect(claim({ label: '  spaced   out  ' })!.label).toBe('spaced out');
    expect(claim({ label: 'x'.repeat(200) })!.label).toHaveLength(60);
    expect(claim({ maxPoints: -5 })!.maxPoints).toBe(1);                // clamped, never 0/negative
    expect(claim({ maxPoints: 1e12 })!.maxPoints).toBe(1_000_000);
    expect(claim({ maxPoints: 'junk' })?.maxPoints ?? null).toBeNull();
    expect(claim({ maxTextureDim: 99_999 })!.maxTextureDim).toBe(16_384);
    // No usable field at all → no identity, i.e. a plain bench patch behaves
    // exactly as it did before profiles could be written by hand.
    expect(claim({ device: 'M4' })).toBeNull();
  });

  it('a claimed cap can tighten but NEVER loosen the active device cap', () => {
    const wide = parseCostFile(JSON.stringify({ meta: { id: 'cp:manual:a', maxTextureDim: 8192 }, costs: { voronoi: 1 } }))!;
    expect(profileFromParsed(wide, 200, 1024).maxTextureDim).toBe(1024);   // claim ignored upward
    const tight = parseCostFile(JSON.stringify({ meta: { id: 'cp:manual:a', maxTextureDim: 512 }, costs: { voronoi: 1 } }))!;
    expect(profileFromParsed(tight, 200, 2048).maxTextureDim).toBe(512);   // own stricter cap kept
  });

  it('a claimed id may replace a hand-authored row but never a MEASURED one', () => {
    const measured = profileFromParsed(
      parseCostFile(JSON.stringify({ meta: { device: 'Quest 3', bench: 'microplane' }, costs: { voronoi: 230 } }))!,
      200, 2048,
    );
    // A file claiming the measured row's id lands as its OWN entry instead:
    // benchmark numbers cost a device run to reproduce, so a typed file must
    // not be able to overwrite them.
    const impostor = parseCostFile(JSON.stringify({
      meta: { id: measured.id, label: 'typed', manual: true }, costs: { voronoi: 1 },
    }))!;
    expect(profileFromParsed(impostor, 200, 2048, [measured]).id).not.toBe(measured.id);
    // …while a hand-authored row IS replaceable — that is the edit round-trip.
    const mine = manual();
    const edited = parseCostFile(JSON.stringify({ meta: { id: mine.id, manual: true }, costs: { voronoi: 7 } }))!;
    expect(profileFromParsed(edited, 200, 2048, [mine]).id).toBe(mine.id);
  });

  it('hand-editing a MEASURED download yields a hand-authored row, not a second "measured" one', () => {
    const measured = profileFromParsed(
      parseCostFile(JSON.stringify({
        meta: { device: 'Quest 3', bench: 'microplane', date: '2026-07-23', valid: true },
        costs: { voronoi: 230, perlin: 40 },
      }), 'run.json')!,
      200, 2048,
    );
    expect(measured.meta.manual).toBe(false);

    // Downloaded, one price retyped, dropped back in.
    const file = buildProfileFile(measured) as { meta: Record<string, unknown>; costs: Record<string, number> };
    file.costs.voronoi = 1;
    const edited = profileFromParsed(parseCostFile(JSON.stringify(file))!, 200, 2048, [measured]);
    expect(edited.id).not.toBe(measured.id);      // the measured row is untouched…
    expect(edited.meta.manual).toBe(true);        // …and the typed copy says it is typed
    expect(edited.label).toBe('Quest 3 (edited)'); // …in the dropdown too, beside the row it came from
    expect(edited.meta.device).toBe('Quest 3');   // provenance is kept, just no longer claimed as measured
    // …and it stops claiming the RUN passed its gates, which is a statement
    // about numbers this file no longer carries.
    expect(edited.meta.valid).toBeNull();

    // A FAITHFUL copy (a backup restored, byte-identical) stays measured and
    // dedups onto the same row — that is what makes backups honest.
    const copy = profileFromParsed(parseCostFile(JSON.stringify(buildProfileFile(measured)))!, 200, 2048, [measured]);
    expect(copy.id).toBe(measured.id);
    expect(copy.meta.manual).toBe(false);
  });

  it('bundles: build → parse gives every profile back, and junk is survivable', () => {
    const a = manual();
    const b = createManualProfile('Second', 300, 1024, new Date('2026-08-18T11:00:00Z'));
    const parsed = parseCostProfileBundle(JSON.stringify(buildProfileBundle([a, b])), 'fastshaders-profiles.json');
    expect(parsed).toHaveLength(2);
    expect(parsed!.map((p) => p.self!.label)).toEqual(['My Device', 'Second']);
    // A single-profile file is NOT a bundle (the caller falls through to
    // parseCostFile), and a bundle of only junk reads as no bundle at all.
    expect(parseCostProfileBundle(JSON.stringify(buildProfileFile(a)))).toBeNull();
    expect(parseCostProfileBundle('{"fastShadersCostProfiles":1,"profiles":[null,7,{}]}')).toBeNull();
    // One bad entry must not cost the user the good ones.
    const mixed = parseCostProfileBundle(JSON.stringify({
      fastShadersCostProfiles: 1, profiles: [null, buildProfileFile(b)],
    }));
    expect(mixed).toHaveLength(1);
    // Bounded: an adversarial bundle can't make the app parse forever.
    const many = { fastShadersCostProfiles: 1, profiles: Array.from({ length: 500 }, () => buildProfileFile(a)) };
    expect(parseCostProfileBundle(JSON.stringify(many))!.length).toBeLessThanOrEqual(100);
  });

  it('file names are derived from the label a user recognises', () => {
    expect(profileFileName(manual())).toBe('fastshaders-profile-my-device.json');
    expect(profileFileName({ ...manual(), label: '!!!' })).toBe('fastshaders-profile-custom.json');
  });

  it('a hand-authored table says so in the committed complexity.json', () => {
    const merged = buildMergedComplexity({ voronoi: 7 }, manual().meta);
    expect((merged.meta.calibratedFrom as { manual: boolean }).manual).toBe(true);
  });
});
