import { describe, it, expect } from 'vitest';
import {
  searchNodes,
  getAllDefinitions,
  getEditorDefinitions,
  nodeMatchRank,
  NO_MATCH,
  NODE_REGISTRY,
} from './nodeRegistry';

/**
 * Search RANKING, not just matching.
 *
 * `description` doubles as the search corpus, so a node that merely mentions a
 * word in its prose used to be able to outrank the node actually named that —
 * results came back in raw registry order. The regression that prompted this:
 * the Time node's description said "speed multiplier", which put Time ABOVE
 * Multiply for the query "multip".
 *
 * IF ONE OF THESE FAILS AFTER A RENAME, THAT IS THE TEST WORKING. Node display
 * labels are editable from the Node Designer's Name field (it splices
 * nodeRegistry.ts's `label` — see nodeLabelRename.test.ts), and `label` is the
 * first entry in `nodeMatchRank`'s name tiers, so renaming a node really does
 * move it in search. The literals below are deliberate pins, NOT brittleness to
 * be refactored into `type` lookups: a rename that changes what wins the query
 * "multip" is a decision someone should make on purpose. The designer warns
 * inline before you get here — `nameWarning` mirrors the prose-collision sweep
 * below, and duplicate names are refused outright.
 */
const def = (type: string) => NODE_REGISTRY.get(type)!;

/**
 * Ranked labels for a query, over the WHOLE registry.
 *
 * Deliberately not `searchNodes()`, which ranks the EDITOR set — the list minus
 * whatever `editorVisibility.json` hides (see `editorVisibility.ts`). These
 * assertions are about `nodeMatchRank`'s ORDERING, so switching a node off in
 * node-editor.html must not redden them: hiding Perlin is a palette decision,
 * not a statement that "noise" should stop ranking Perlin first. `searchNodes`'
 * own agreement with this order is pinned separately below.
 */
const labels = (q: string) =>
  getAllDefinitions()
    .map((d) => ({ d, rank: nodeMatchRank(d, q) }))
    .filter((e) => e.rank !== NO_MATCH)
    .sort((a, b) => a.rank - b.rank)
    .map((e) => e.d.label);

describe('searchNodes — a node name always outranks prose that mentions it', () => {
  it('puts Multiply first for every prefix of "multiply"', () => {
    // Asserted by TYPE, not label: `mul` is designable, so its display name is
    // renameable from the Node Designer, and pinning the string here would make a
    // correct rename fail the release workflow's test job. What this test is about is
    // WHICH NODE wins the query — that must hold whatever the node is called.
    for (const q of ['mul', 'mult', 'multip', 'multiply']) {
      expect(searchNodes(q)[0]?.type, `query "${q}"`).toBe('mul');
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

  it('searchNodes applies exactly this order to the editor set', () => {
    // The bridge between the ranking pinned above and what the Add-node menu
    // actually shows. Written as a SUBSEQUENCE check rather than equality so it
    // holds whether or not anything is hidden: hiding removes entries, it must
    // never reorder the ones that remain.
    const visible = new Set(getEditorDefinitions().map((d) => d.type));
    for (const q of ['noise', 'multip', 'clock', 'mix']) {
      const expected = getAllDefinitions()
        .map((d) => ({ d, rank: nodeMatchRank(d, q) }))
        .filter((e) => e.rank !== NO_MATCH && visible.has(e.d.type))
        .sort((a, b) => a.rank - b.rank)
        .map((e) => e.d.type);
      expect(searchNodes(q).map((d) => d.type), q).toEqual(expected);
    }
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

  it('the Output node Discard socket documents its truthiness semantics', () => {
    const out = NODE_REGISTRY.get('output')!;
    const discard = out.inputs.find((p) => p.id === 'discard')!;
    expect(discard.description).toBeTruthy();
    // The whole point: a user must not read it as a 0/1 switch.
    expect(discard.description!).toMatch(/non-zero/);
    expect(discard.description!).toMatch(/0\.2/);
    // Must name nodes that actually exist in this registry — there is no
    // "Compare" node; the logic category is Greater Than / Less Than / Equal.
    // Checked against the LIVE labels rather than pinned literals: both types are
    // designable, so the Node Designer can rename them. Reading the labels keeps the
    // real invariant (the prose points at nodes that exist, by their current names)
    // and turns a rename into a failure only when it makes the prose genuinely stale —
    // which is a description edit, not a broken test.
    const gt = NODE_REGISTRY.get('greaterThan')!.label;
    const lt = NODE_REGISTRY.get('lessThan')!.label;
    expect(discard.description!).toContain(gt);
    expect(discard.description!).toContain(lt);
  });

  it('"view dir" now finds the GENUINE view vector first, and still finds the world one', () => {
    // positionViewDirection matches by NAME (rank 2); positionWorldDirection
    // only through its `Also:` alias tail (rank 3). Before the rename BOTH
    // matched by name at rank 2 and registry order put the world node first —
    // which is exactly the confusion the rename removes.
    const types = searchNodes('view dir').map((d) => d.type);
    expect(types).toContain('positionViewDirection');
    expect(types).toContain('positionWorldDirection');
    expect(types.indexOf('positionViewDirection'))
      .toBeLessThan(types.indexOf('positionWorldDirection'));
    expect(nodeMatchRank(def('positionViewDirection'), 'view dir'))
      .toBeLessThan(nodeMatchRank(def('positionWorldDirection'), 'view dir'));
  });
});
