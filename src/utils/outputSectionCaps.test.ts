/**
 * Decision 9 for NAME sections (GLB Phase 5 Step 4): every Output cap
 * announces itself, and emission never drops a mesh the node still shows.
 *
 *  - `planNamedParts` is the ONE first-claim loop. For every graph with at
 *    most `MAX_PARTS` entries it must reproduce graphToCode's old loop and the
 *    node's old shadowed mark exactly (the golden below restates both), or the
 *    byte-stability suites stop meaning what they say.
 *  - The restore sanitizer COUNTS what it drops, and keeps counting past the
 *    cap (it used to `break`).
 *  - A section that was dropped must not leave its wires behind.
 *  - The legacy fold folds only what fits and deletes nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  planNamedParts,
  sanitizeOutputMaterials,
  sanitizeOutputMaterialsReport,
  pruneOrphanMaterialEdges,
  foldExtraOutputs,
  sectionLabel,
  outputNodes,
  outputMaterials,
  materialTargetNames,
  MAX_PARTS,
  MAX_PART_ENTRIES,
  type OutputMaterial,
} from './outputMaterials';
import { formatSectionLabel } from '@/components/NodeEditor/nodes/sectionLabelText';
import { t } from '@/i18n';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

const output = (id: string, data: Record<string, unknown> = {}): AppNode => {
  const n = makeNode(id, 'output');
  Object.assign(n.data as Record<string, unknown>, data);
  return n;
};
const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const added = (node: AppNode) =>
  ((node.data as { materials?: OutputMaterial[] }).materials ?? []) as OutputMaterial[];

/** graphToCode's name loop as it stood before Step 4 — the golden reference. */
function legacyEntries(materials: readonly OutputMaterial[]) {
  const claimed = new Set<string>();
  const out: { name: string; section: number }[] = [];
  for (let i = 0; i < materials.length; i++) {
    for (const name of materialTargetNames(materials[i])) {
      if (claimed.has(name) || out.length >= MAX_PARTS) continue;
      claimed.add(name);
      out.push({ name, section: i });
    }
  }
  return out;
}

/** OutputNode's shadowed mark as it stood before Step 4 (`claimedAbove`). */
function legacyShadowed(materials: readonly OutputMaterial[]) {
  const shadowed = new Set<number>();
  materials.forEach((m, index) => {
    const targets = materialTargetNames(m);
    const above = new Set(materials.slice(0, index).flatMap((x) => materialTargetNames(x)));
    if (targets.length > 0 && targets.every((n) => above.has(n))) shadowed.add(index);
  });
  return shadowed;
}

const FIXTURES: Record<string, OutputMaterial[]> = {
  'the default alone': [{}],
  'one mesh material': [{}, { meshTargets: ['Glass'] }],
  'a targeted material 0': [{ meshTargets: ['Body'] }, { meshTargets: ['Glass'] }],
  'the legacy single target': [{}, { meshTarget: { name: 'Glass' } }],
  'a duplicate claim': [{}, { meshTargets: ['Glass'] }, { meshTargets: ['Glass'] }],
  'a partial overlap': [{}, { meshTargets: ['A', 'B'] }, { meshTargets: ['B', 'C'] }],
  'an empty added section': [{}, { meshTargets: [] }, { meshTargets: ['A'] }],
  'exactly nine entries': [{}, { meshTargets: names('a', 4) }, { meshTargets: names('b', 5) }],
  'three sections sharing names': [
    { meshTargets: ['A'] },
    { meshTargets: ['A', 'B'] },
    { meshTargets: ['B'] },
    { meshTargets: ['C'] },
  ],
};

describe('MAX_PART_ENTRIES', () => {
  it('is every name the sanitizer can admit, so emission can never drop one the node shows', () => {
    expect(MAX_PART_ENTRIES).toBe(90);
    expect(MAX_PART_ENTRIES).toBe((MAX_PARTS + 1) * MAX_PARTS);
    // The sanitizer admits MAX_PARTS sections of MAX_PARTS names each.
    expect(MAX_PART_ENTRIES).toBeGreaterThanOrEqual(MAX_PARTS * MAX_PARTS);
  });
});

describe('planNamedParts — the ONE first-claim loop', () => {
  for (const [label, materials] of Object.entries(FIXTURES)) {
    it(`reproduces the old emission order and shadowed mark: ${label}`, () => {
      const plan = planNamedParts(materials);
      expect(plan.entries).toEqual(legacyEntries(materials));
      expect(plan.shadowed).toEqual(legacyShadowed(materials));
      expect(plan.overCap).toEqual([]);
    });
  }

  it('emits all 81 entries of nine full sections (the old loop stopped at 9)', () => {
    const materials: OutputMaterial[] = Array.from({ length: MAX_PARTS }, (_, s) => ({
      meshTargets: names(`s${s}_`, MAX_PARTS),
    }));
    const plan = planNamedParts(materials);
    expect(plan.entries).toHaveLength(MAX_PARTS * MAX_PARTS);
    expect(plan.overCap).toEqual([]);
    expect(plan.shadowed.size).toBe(0);
    // Section order, then name order within a section.
    expect(plan.entries[0]).toEqual({ name: 's0_0', section: 0 });
    expect(plan.entries[80]).toEqual({ name: 's8_8', section: 8 });
    expect(legacyEntries(materials)).toHaveLength(MAX_PARTS);
  });

  it('reports names past the entry cap and does not claim them (unsanitized data only)', () => {
    // Eleven sections of nine is more than any restore path admits.
    const materials: OutputMaterial[] = Array.from({ length: 11 }, (_, s) => ({
      meshTargets: names(`s${s}_`, MAX_PARTS),
    }));
    const plan = planNamedParts(materials);
    expect(plan.entries).toHaveLength(MAX_PART_ENTRIES);
    expect(plan.overCap).toEqual(names('s10_', MAX_PARTS));
    expect(plan.shadowed.has(10)).toBe(true);
    expect(plan.shadowed.has(9)).toBe(false);
  });

  it('never marks an EMPTY section shadowed — "No mesh" is a different state', () => {
    expect(planNamedParts([{}, { meshTargets: [] }]).shadowed.size).toBe(0);
  });

  it('sees nothing on an unusable or hostile name', () => {
    const plan = planNamedParts([{}, { meshTargets: ['__proto__', '', 'ok'] as string[] }]);
    expect(plan.entries).toEqual([{ name: 'ok', section: 1 }]);
  });
});

describe('sanitizeOutputMaterialsReport — every drop is COUNTED', () => {
  it('returns the SAME array and trimmed 0 for a clean graph', () => {
    const nodes = [output('o1', { materials: [{ meshTargets: ['Glass'] }] }), makeNode('c1', 'color')];
    const report = sanitizeOutputMaterialsReport(nodes);
    expect(report.nodes).toBe(nodes);
    expect(report.trimmed).toBe(0);
    const bare = [output('o2')];
    expect(sanitizeOutputMaterialsReport(bare)).toEqual({ nodes: bare, trimmed: 0 });
    expect(sanitizeOutputMaterialsReport(bare).nodes).toBe(bare);
  });

  it('keeps MAX_PARTS sections of twelve and counts the other three', () => {
    const report = sanitizeOutputMaterialsReport([
      output('o1', { materials: names('s', 12).map((n) => ({ meshTargets: [n] })) }),
    ]);
    expect(added(report.nodes[0])).toHaveLength(MAX_PARTS);
    expect(report.trimmed).toBe(3);
  });

  it('keeps counting past the cap (it used to break), and counts non-object entries', () => {
    const entries: unknown[] = [
      ...names('a', MAX_PARTS).map((n) => ({ meshTargets: [n] })),
      null,
      { meshTargets: ['late1'] },
      { meshTargets: ['late2'] },
    ];
    const report = sanitizeOutputMaterialsReport([output('o1', { materials: entries })]);
    expect(added(report.nodes[0]).map((m) => m.meshTargets)).toEqual(names('a', MAX_PARTS).map((n) => [n]));
    expect(report.trimmed).toBe(3);

    const junk = sanitizeOutputMaterialsReport([
      output('o2', { materials: [null, 5, 'x', [], { meshTargets: ['A'] }] }),
    ]);
    expect(added(junk.nodes[0])).toEqual([{ meshTargets: ['A'] }]);
    expect(junk.trimmed).toBe(4);
  });

  it("counts material 0's own names past the cap", () => {
    const report = sanitizeOutputMaterialsReport([output('o1', { meshTargets: names('m', 12) })]);
    expect((report.nodes[0].data as { meshTargets?: string[] }).meshTargets).toEqual(names('m', MAX_PARTS));
    expect(report.trimmed).toBe(3);
  });

  it('counts unusable names but not de-duplication', () => {
    const report = sanitizeOutputMaterialsReport([
      output('o1', { materials: [{ meshTargets: ['A', 'A', '', '__proto__', 'B'] }] }),
    ]);
    expect(added(report.nodes[0])).toEqual([{ meshTargets: ['A', 'B'] }]);
    expect(report.trimmed).toBe(2);
  });

  it('migrates the legacy single target without counting it, and counts a junk one', () => {
    const legacy = sanitizeOutputMaterialsReport([output('o1', { materials: [{ meshTarget: { name: 'Glass' } }] })]);
    expect(added(legacy.nodes[0])).toEqual([{ meshTargets: ['Glass'] }]);
    expect(legacy.trimmed).toBe(0);

    for (const meshTarget of [{ name: 5 }, 'x', null, 7]) {
      const r = sanitizeOutputMaterialsReport([output('o1', { materials: [{ meshTarget }] })]);
      expect(added(r.nodes[0]), JSON.stringify(meshTarget)).toEqual([{ meshTargets: [] }]);
      expect(r.trimmed, JSON.stringify(meshTarget)).toBe(1);
    }
    // A string where the LIST belongs is junk too.
    const str = sanitizeOutputMaterialsReport([output('o1', { materials: [{ meshTargets: 'Glass' }] })]);
    expect(str.trimmed).toBe(1);
  });

  it('removes a non-array materials value and counts it', () => {
    const report = sanitizeOutputMaterialsReport([output('o1', { materials: { 0: { meshTargets: ['A'] } } })]);
    expect((report.nodes[0].data as { materials?: unknown }).materials).toBeUndefined();
    expect(report.trimmed).toBe(1);
  });

  it('never reorders, and the uncounted wrapper returns the same nodes', () => {
    const nodes = [output('o1', { materials: [{ meshTargets: ['B'] }, { meshTargets: ['A'] }, null] })];
    const report = sanitizeOutputMaterialsReport(nodes);
    expect(added(report.nodes[0]).map((m) => m.meshTargets)).toEqual([['B'], ['A']]);
    expect(sanitizeOutputMaterials(nodes)).toEqual(report.nodes);
  });

  it('sums across several Output nodes', () => {
    const report = sanitizeOutputMaterialsReport([
      output('o1', { meshTargets: names('m', 10) }),
      output('o2', { materials: [null] }),
    ]);
    expect(report.trimmed).toBe(2);
  });
});

describe('pruneOrphanMaterialEdges — a dropped section leaves no wires behind', () => {
  const nodes = (): AppNode[] => [
    output('o1', { materials: [{ meshTargets: ['A'] }, { meshTargets: ['B'] }] }), // 3 materials
    makeNode('other', 'add'),
  ];

  it('removes the edges naming a material the node no longer has', () => {
    const edges = [
      makeEdge('c0', 'out', 'o1', 'color'),
      makeEdge('c1', 'out', 'o1', 'm2:color'),
      makeEdge('c2', 'out', 'o1', 'm5:color'),
      makeEdge('c3', 'out', 'o1', 'm99999999999999999999:emissive'),
      makeEdge('c4', 'out', 'other', 'm5:color'),
    ];
    const r = pruneOrphanMaterialEdges(nodes(), edges);
    expect(r.removed).toBe(2);
    expect(r.edges.map((e) => `${e.target}/${e.targetHandle}`)).toEqual(['o1/color', 'o1/m2:color', 'other/m5:color']);
  });

  it('returns the SAME array when nothing is pruned, or when there is no Output', () => {
    const edges = [makeEdge('c0', 'out', 'o1', 'm2:color'), { ...makeEdge('c1', 'out', 'o1', 'x'), targetHandle: null } as AppEdge];
    const r = pruneOrphanMaterialEdges(nodes(), edges);
    expect(r.edges).toBe(edges);
    expect(r.removed).toBe(0);
    const none = [makeEdge('a', 'out', 'b', 'm7:color')];
    expect(pruneOrphanMaterialEdges([makeNode('b', 'add')], none).edges).toBe(none);
  });
});

describe('foldExtraOutputs folds only what FITS and deletes nothing', () => {
  it('leaves over-cap legacy extras on the canvas as inactive Outputs, wiring intact', () => {
    const nodes: AppNode[] = [output('o1')];
    const edges: AppEdge[] = [];
    for (let i = 0; i < MAX_PARTS + 3; i++) {
      nodes.push(output(`x${i}`, { meshTarget: { name: `mesh${i}` } }));
      edges.push(makeEdge(`c${i}`, 'out', `x${i}`, 'color'));
    }
    const folded = foldExtraOutputs(nodes, edges);
    const keep = folded.nodes.find((n) => n.id === 'o1')!;
    expect(outputMaterials(keep)).toHaveLength(1 + MAX_PARTS);
    expect(outputNodes(folded.nodes).map((n) => n.id)).toEqual(['o1', 'x9', 'x10', 'x11']);
    for (const id of ['x9', 'x10', 'x11']) {
      const original = edges.find((e) => e.target === id)!;
      expect(folded.edges, id).toContain(original);
    }
    expect(folded.edges.filter((e) => e.target === 'o1').map((e) => e.targetHandle))
      .toEqual(Array.from({ length: MAX_PARTS }, (_, k) => `m${k + 1}:color`));
  });

  it('returns the SAME arrays when nothing fits', () => {
    const keep = output('o1', { materials: names('k', MAX_PARTS).map((n) => ({ meshTargets: [n] })) });
    const extra = output('x', { meshTarget: { name: 'late' } });
    const nodes = [keep, extra];
    const edges = [makeEdge('c', 'out', 'x', 'color')];
    const folded = foldExtraOutputs(nodes, edges);
    expect(folded.nodes).toBe(nodes);
    expect(folded.edges).toBe(edges);
  });
});

describe('sectionLabel + formatSectionLabel — the one section label', () => {
  const mats: OutputMaterial[] = [{}, { meshTargets: ['Glass'] }, { meshTargets: ['A', 'B'] }, { meshTargets: [] }];

  it('says what the label is', () => {
    expect(sectionLabel(mats, 0)).toEqual({ kind: 'default' });
    expect(sectionLabel(mats, 1)).toEqual({ kind: 'named', first: 'Glass', more: false });
    expect(sectionLabel(mats, 2)).toEqual({ kind: 'named', first: 'A', more: true });
    expect(sectionLabel(mats, 3)).toEqual({ kind: 'empty' });
    expect(sectionLabel(mats, 9)).toEqual({ kind: 'empty' });
    expect(sectionLabel([{ meshTargets: ['Body'] }], 0)).toEqual({ kind: 'named', first: 'Body', more: false });
  });

  it('words it the way the node does, in both languages', () => {
    expect(formatSectionLabel(sectionLabel(mats, 0), 'en')).toBe('All meshes (default)');
    expect(formatSectionLabel(sectionLabel(mats, 1), 'en')).toBe('Glass');
    expect(formatSectionLabel(sectionLabel(mats, 2), 'en')).toBe('A …');
    expect(formatSectionLabel(sectionLabel(mats, 3), 'en')).toBe('No mesh');
    expect(formatSectionLabel(sectionLabel(mats, 0), 'lv')).toBe(t('All meshes (default)', 'lv'));
    expect(formatSectionLabel(sectionLabel(mats, 3), 'lv')).toBe(t('No mesh', 'lv'));
    expect(t('No mesh', 'lv')).not.toBe('No mesh');
    // A mesh name is never translated.
    expect(formatSectionLabel(sectionLabel(mats, 1), 'lv')).toBe('Glass');
  });
});
