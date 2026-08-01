import { describe, it, expect } from 'vitest';
import { searchNodes, nodeMatchRank, NO_MATCH, NODE_REGISTRY } from './nodeRegistry';

/**
 * Search RANKING, not just matching.
 *
 * `description` doubles as the search corpus, so a node that merely mentions a
 * word in its prose used to be able to outrank the node actually named that —
 * results came back in raw registry order. The regression that prompted this:
 * the Time node's description said "speed multiplier", which put Time ABOVE
 * Multiply for the query "multip".
 */
const def = (type: string) => NODE_REGISTRY.get(type)!;
const labels = (q: string) => searchNodes(q).map((d) => d.label);

describe('searchNodes — a node name always outranks prose that mentions it', () => {
  it('puts Multiply first for every prefix of "multiply"', () => {
    for (const q of ['mul', 'mult', 'multip', 'multiply']) {
      expect(labels(q)[0], `query "${q}"`).toBe('Multiply');
    }
  });

  it('puts the Color node above Property (color)', () => {
    const r = labels('color');
    expect(r[0]).toBe('Color');
    expect(r.indexOf('Color')).toBeLessThan(r.indexOf('Property (color)'));
  });

  it('ranks an exact name above a mere substring match', () => {
    expect(nodeMatchRank(def('sin'), 'sin')).toBeLessThan(nodeMatchRank(def('cos'), 'sin'));
    expect(labels('sin')[0]).toBe('Sine');
  });

  it('ranks the Also: alias list above prose but below a real name', () => {
    // 'clock' is a Time alias; no node is NAMED clock.
    const aliasRank = nodeMatchRank(def('time'), 'clock');
    expect(aliasRank).toBeGreaterThan(nodeMatchRank(def('time'), 'time'));
    // 'mask' appears only in Multiply's prose (its alias tail is "times,
    // product, scale"), so it must rank strictly below an alias hit.
    expect(aliasRank).toBeLessThan(nodeMatchRank(def('mul'), 'mask'));
    expect(labels('clock')[0]).toBe('Time');
  });

  it('returns NO_MATCH for a query nothing matches', () => {
    expect(nodeMatchRank(def('time'), '__nothing_matches_this__')).toBe(NO_MATCH);
    expect(labels('__nothing_matches_this__')).toEqual([]);
  });

  it('keeps registry order among equally-ranked matches (stable sort)', () => {
    const noise = labels('noise').slice(0, 2);
    expect(noise).toEqual(['Perlin Noise', 'Perlin Noise (vec3)']);
  });
});

describe('node descriptions keep UI instructions out of the search corpus', () => {
  it('the Time node no longer collides with Multiply', () => {
    // It stays findable by its real aliases instead.
    expect(nodeMatchRank(def('time'), 'multip')).toBe(NO_MATCH);
    expect(labels('speed')).toContain('Time');
    expect(labels('clock')).toContain('Time');
  });

  it('no definition advertises a right-click in a way that shadows another node', () => {
    // "right-click" is fine as prose; what is NOT fine is prose containing a
    // word that is another node's NAME, since that node then shares the query.
    const names = new Set(
      [...NODE_REGISTRY.values()].map((d) => d.label.toLowerCase()).filter((n) => n.length >= 4),
    );
    for (const d of NODE_REGISTRY.values()) {
      const [prose = ''] = (d.description?.toLowerCase() ?? '').split(/\s*also:/);
      for (const name of names) {
        if (name === d.label.toLowerCase()) continue;
        if (!prose.includes(name)) continue;
        // Allowed only because the named node still wins. A TIE is legitimate:
        // Slider's prose mentions "float" and its tslFunction IS `float`, so
        // both rank 0 — Slider really is a float node. What must never happen
        // is the prose-mentioning node ranking BETTER than the named one.
        const other = [...NODE_REGISTRY.values()].find((x) => x.label.toLowerCase() === name)!;
        expect(
          nodeMatchRank(other, name),
          `"${d.label}" prose mentions "${name}"; that node must not be outranked by it`,
        ).toBeLessThanOrEqual(nodeMatchRank(d, name));
      }
    }
  });
});
