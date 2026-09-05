/**
 * The Output node's materials — one node, one material per targeted sub-mesh.
 *
 * The rules pinned here are the ones that fail SILENTLY:
 *
 *  - A document with no added materials must be BYTE-IDENTICAL to what it was
 *    before materials existed. Every built-in snapshot and every already-
 *    exported shader depends on it, so material 0 lives in the node's own
 *    fields and adds no key.
 *  - Material 0's handles must stay the BARE channel ids. Every saved edge and
 *    every `targetHandle === 'color'` reader was written against them; a
 *    namespaced material 0 would silently orphan the lot.
 *  - Restore paths must agree with emission about which claims survive, or a
 *    reload changes what renders.
 *  - A graph from the multi-Output design must FOLD rather than strand its
 *    wiring on nodes that emit nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  channelHandle,
  parseChannelHandle,
  outputMaterials,
  materialCount,
  materialTargetName,
  materialTargetNames,
  materialExposedPorts,
  claimedMeshNames,
  findDefaultOutput,
  outputNodes,
  sanitizeOutputMaterials,
  shiftMaterialHandles,
  foldExtraOutputs,
  dormantMaterialIndices,
  dormantIndicesForPreview,
  outputDefaultContributes,
  outputDormancyFromState,
  storedValueEmits,
  MAX_ADDED_MATERIALS,
  MAX_PARTS,
  assignMeshTargets,
} from './outputMaterials';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

const output = (id: string, materials?: unknown): AppNode => {
  const n = makeNode(id, 'output');
  if (materials !== undefined) (n.data as Record<string, unknown>).materials = materials;
  return n;
};

describe('handle namespacing', () => {
  it('material 0 keeps the BARE channel id', () => {
    // The whole back-compatibility story: every saved edge already points at
    // `color`, and codegen/consumers read that id directly.
    expect(channelHandle(0, 'color')).toBe('color');
    expect(channelHandle(0, 'position')).toBe('position');
  });

  it('an added material namespaces its own', () => {
    expect(channelHandle(1, 'color')).toBe('m1:color');
    expect(channelHandle(4, 'discard')).toBe('m4:discard');
  });

  it('round-trips, and reads an unknown shape as material 0', () => {
    for (const [i, ch] of [[0, 'color'], [1, 'emissive'], [7, 'position']] as const) {
      expect(parseChannelHandle(channelHandle(i, ch))).toEqual({ index: i, channel: ch });
    }
    // A bare id is material 0 by definition; anything unparseable degrades to
    // the default rather than to a material that does not exist.
    expect(parseChannelHandle('color')).toEqual({ index: 0, channel: 'color' });
    expect(parseChannelHandle('m0:color')).toEqual({ index: 0, channel: 'm0:color' });
    expect(parseChannelHandle('mx:color')).toEqual({ index: 0, channel: 'mx:color' });
  });

  it('a channel containing the separator still parses whole', () => {
    // Not reachable from the registry today, but the parser must not split a
    // channel in half if one ever appears.
    expect(parseChannelHandle('m2:a:b')).toEqual({ index: 2, channel: 'a:b' });
  });
});

describe('reading materials off a node', () => {
  it('a node with no materials key has exactly ONE material — the default', () => {
    const n = output('o1');
    expect(materialCount(n)).toBe(1);
    expect(outputMaterials(n)).toHaveLength(1);
    expect(materialTargetName(outputMaterials(n)[0])).toBeNull();
  });

  it('material 0 is the node\'s OWN fields, not a copy in the array', () => {
    const n = output('o1', [{ meshTargets: ['Glass'] }]);
    (n.data as Record<string, unknown>).values = { roughness: 0.4 };
    (n.data as Record<string, unknown>).exposedPorts = ['color', 'roughness'];
    const [first, second] = outputMaterials(n);
    expect(first.values).toEqual({ roughness: 0.4 });
    expect(first.exposedPorts).toEqual(['color', 'roughness']);
    expect(materialTargetNames(first)).toEqual([]);
    expect(materialTargetNames(second)).toEqual(['Glass']);
  });

  it('reads the LEGACY single target, and a list, through one accessor', () => {
    // `meshTarget: { name }` is what a graph or saved group written before the
    // list existed carries, and it meant exactly what a one-entry list means.
    expect(materialTargetNames({ meshTarget: { name: 'Body' } })).toEqual(['Body']);
    expect(materialTargetNames({ meshTargets: ['Body', 'Glass'] })).toEqual(['Body', 'Glass']);
    // The list WINS when both are present, so a half-migrated entry cannot
    // shade something the node does not show.
    expect(materialTargetNames({ meshTargets: ['A'], meshTarget: { name: 'B' } })).toEqual(['A']);
    // De-duped, unusable names dropped, capped — every name here reaches
    // generated code that the XR popup runs at the app's real origin.
    expect(materialTargetNames({ meshTargets: ['A', 'A', '', '__proto__', 'B'] }))
      .toEqual(['A', 'B']);
    expect(materialTargetNames({ meshTargets: Array.from({ length: 40 }, (_, i) => `m${i}`) }))
      .toHaveLength(MAX_PARTS);
    expect(materialTargetNames(undefined)).toEqual([]);
  });

  it('claimedMeshNames lists only the ADDED materials, every target of each', () => {
    const n = output('o1', [
      { meshTargets: ['Glass', 'Window'] },
      { meshTargets: ['Body'] },
    ]);
    expect(claimedMeshNames(n)).toEqual(['Glass', 'Window', 'Body']);
  });

  it('a non-Output node has no materials at all', () => {
    expect(outputMaterials(makeNode('c1', 'color'))).toEqual([]);
    expect(claimedMeshNames(makeNode('c1', 'color'))).toEqual([]);
  });

  it('an explicit empty exposed list means "every channel hidden"', () => {
    // The `effectiveExposedPorts` rule: only an ABSENT list falls back.
    expect(materialExposedPorts({ exposedPorts: [] }, ['color'])).toEqual([]);
    expect(materialExposedPorts({}, ['color', 'position'])).toEqual(['color', 'position']);
    expect(materialExposedPorts(undefined, ['color'])).toEqual(['color']);
  });
});

describe('findDefaultOutput', () => {
  it('is the Output node', () => {
    const o = output('o1');
    expect(findDefaultOutput([makeNode('c1', 'color'), o])).toBe(o);
  });

  it('is null when there is none', () => {
    expect(findDefaultOutput([makeNode('c1', 'color')])).toBeNull();
  });

  it('follows ARRAY order when no Output carries the active flag', () => {
    const a = output('o1');
    const b = output('o2');
    expect(findDefaultOutput([a, b])).toBe(a);
    expect(outputNodes([a, makeNode('c1', 'color'), b]).map((n) => n.id)).toEqual(['o1', 'o2']);
  });

  it('the Output carrying `activeOutput: true` wins over array order (several may coexist, one active)', () => {
    const a = output('o1');
    const b = output('o2');
    (b.data as Record<string, unknown>).activeOutput = true;
    expect(findDefaultOutput([a, b])).toBe(b);
    // Only the literal true counts — node data is untrusted.
    (b.data as Record<string, unknown>).activeOutput = 'yes';
    expect(findDefaultOutput([a, b])).toBe(a);
  });
});

describe('sanitizeOutputMaterials', () => {
  it('returns the SAME array when nothing needed changing', () => {
    // The autosave subscriber and `selectionOnlyGraphChange` compare by
    // reference — a fresh array every load would defeat both.
    const nodes = [output('o1', [{ meshTargets: ['Glass'] }]), makeNode('c1', 'color')];
    expect(sanitizeOutputMaterials(nodes)).toBe(nodes);
  });

  it('leaves a node with no materials key untouched', () => {
    const nodes = [output('o1')];
    expect(sanitizeOutputMaterials(nodes)).toBe(nodes);
  });

  it('drops a non-array materials value', () => {
    const out = sanitizeOutputMaterials([output('o1', 'Glass')]);
    expect((out[0].data as { materials?: unknown }).materials).toBeUndefined();
  });

  it('KEEPS a material whose names are all unusable — empty, not deleted', () => {
    // An empty added material shades NOTHING (it is not a second default —
    // only material 0's empty list means "everything else"). It is the state a
    // swap passes through when one material's last mesh moves to another, so
    // dropping it here would delete a section, and its wiring, on the reload
    // after an ordinary swap.
    const out = sanitizeOutputMaterials([
      output('o1', [
        { values: { roughness: 1 } },
        { meshTargets: [''] },
        { meshTargets: ['__proto__'] },
        { meshTarget: 'Glass' },
        { meshTargets: ['Body'] },
      ]),
    ]);
    expect((out[0].data as { materials?: unknown }).materials).toEqual([
      { meshTargets: [], values: { roughness: 1 } },
      { meshTargets: [] },
      { meshTargets: [] },
      { meshTargets: [] },
      { meshTargets: ['Body'] },
    ]);
  });

  it('KEEPS a duplicate claim — dropping it would delete a live section', () => {
    // The picker lets two materials name one mesh on purpose: locking the
    // options was what made swapping two materials' meshes impossible without
    // deleting one and rebuilding its wiring. So the loser must survive the
    // round trip through localStorage — dropping it here would silently delete
    // a whole section, and its edges with it, on the next reload.
    //
    // Emission is where the duplicate is resolved (first claim wins), so a live
    // graph and a reloaded one still render identically.
    const out = sanitizeOutputMaterials([
      output('o1', [
        { meshTargets: ['Glass'], values: { roughness: 0.1 } },
        { meshTargets: ['Glass'], values: { roughness: 0.9 } },
      ]),
    ]);
    const materials = (out[0].data as { materials: { values?: unknown }[] }).materials;
    expect(materials).toHaveLength(2);
    expect(materials[0].values).toEqual({ roughness: 0.1 });
    expect(materials[1].values).toEqual({ roughness: 0.9 });
  });

  it('assignMeshTargets MOVES a mesh — it never lets two materials hold it', () => {
    const before = [
      { meshTargets: ['Body'] },
      { meshTargets: ['Glass', 'Wheels'] },
    ];
    // Material 0 takes Glass: material 1 keeps Wheels and loses Glass.
    expect(assignMeshTargets(before, 0, ['Glass'])).toEqual([
      { meshTargets: ['Glass'] },
      { meshTargets: ['Wheels'] },
    ]);
    // Taking a material's LAST mesh leaves it empty rather than deleting it —
    // the state a swap of two single-mesh materials must pass through.
    expect(assignMeshTargets([{ meshTargets: ['Body'] }, { meshTargets: ['Glass'] }], 0, ['Glass']))
      .toEqual([{ meshTargets: ['Glass'] }, { meshTargets: [] }]);
  });

  it('assignMeshTargets keeps everything else about a material', () => {
    // The channels, ports and settings of the materials it re-points are the
    // whole reason those sections exist; only the target list may move.
    const out = assignMeshTargets(
      [
        { meshTargets: ['Body'], values: { roughness: 0.5 } },
        { meshTargets: ['Glass'], exposedPorts: ['color'], materialSettings: { transparent: true } },
      ],
      0,
      ['Glass'],
    );
    expect(out[0].values).toEqual({ roughness: 0.5 });
    expect(out[1]).toEqual({
      meshTargets: [],
      exposedPorts: ['color'],
      materialSettings: { transparent: true },
    });
  });

  it('assignMeshTargets drops the LEGACY key on any edit', () => {
    // Leaving it behind lets the two shapes disagree about what a material
    // shades — `materialTargetNames` prefers the list, so the stale single
    // target would be invisible until something read it directly.
    const out = assignMeshTargets([{ meshTarget: { name: 'Body' } }], 0, ['Glass']);
    expect(out[0]).toEqual({ meshTargets: ['Glass'] });
    expect('meshTarget' in out[0]).toBe(false);
  });

  it('MAX_PARTS is exactly one more than the button offers', () => {
    // The two bounds are one decision: the UI adds materials, and an Apply can
    // turn material 0's own target into one more. Drifting them apart is how a
    // material ends up authorable but undeletable-by-reload.
    expect(MAX_PARTS).toBe(MAX_ADDED_MATERIALS + 1);
  });

  it('caps the list at MAX_PARTS, one MORE than the button offers', () => {
    // A code-panel Apply turns a TARGETED material 0 into an added one, so a
    // node can legitimately hold MAX_ADDED_MATERIALS + 1 of them; bounding this
    // at MAX_ADDED_MATERIALS would delete the last one on the next reload.
    const many = Array.from({ length: MAX_PARTS + 4 }, (_, i) => ({
      meshTarget: { name: `m${i}` },
    }));
    const out = sanitizeOutputMaterials([output('o1', many)]);
    expect((out[0].data as { materials: unknown[] }).materials).toHaveLength(MAX_PARTS);
  });

  it("normalizes material 0's own target, and leaves a clean one alone", () => {
    // It is a NODE field, not a `materials` entry, so it is reachable on a node
    // carrying no materials at all — and it reaches generated code by exactly
    // the same route, which is what makes an unbounded string there a problem.
    const ok = output('o1');
    (ok.data as Record<string, unknown>).meshTargets = ['Body'];
    expect(sanitizeOutputMaterials([ok])[0]).toBe(ok);

    // The LEGACY single form is rewritten to the list, so nothing downstream
    // has two shapes to handle.
    const legacy = output('o1');
    (legacy.data as Record<string, unknown>).meshTarget = { name: 'Body' };
    const migrated = sanitizeOutputMaterials([legacy])[0];
    expect((migrated.data as { meshTargets?: unknown }).meshTargets).toEqual(['Body']);
    expect((migrated.data as { meshTarget?: unknown }).meshTarget).toBeUndefined();

    for (const bad of [
      { name: '' },
      { name: 'x'.repeat(5000) },
      { name: '__proto__' },
      'Body',
      42,
    ]) {
      const n = output('o1');
      (n.data as Record<string, unknown>).meshTarget = bad;
      const cleaned = sanitizeOutputMaterials([n])[0];
      expect(cleaned, JSON.stringify(bad)).not.toBe(n);
      expect((cleaned.data as { meshTarget?: unknown }).meshTarget).toBeUndefined();
      expect((cleaned.data as { meshTargets?: unknown }).meshTargets).toBeUndefined();
    }
    for (const bad of [['', '__proto__'], 'Body', 42, [{ name: 'Body' }]]) {
      const n = output('o1');
      (n.data as Record<string, unknown>).meshTargets = bad;
      const cleaned = sanitizeOutputMaterials([n])[0];
      expect(cleaned, JSON.stringify(bad)).not.toBe(n);
      expect((cleaned.data as { meshTargets?: unknown }).meshTargets).toBeUndefined();
    }
  });

  it('strips unknown keys, so nothing unbounded can ride along', () => {
    const out = sanitizeOutputMaterials([
      output('o1', [{ meshTargets: ['Glass'], junk: 'x'.repeat(5000) }]),
    ]);
    expect((out[0].data as { materials: object[] }).materials).toEqual([
      { meshTargets: ['Glass'] },
    ]);
  });

  it('keeps the fields a material legitimately owns', () => {
    const out = sanitizeOutputMaterials([
      output('o1', [{
        meshTargets: ['Glass'],
        values: { roughness: 0.5, color: '#ff0000' },
        exposedPorts: ['color'],
        materialSettings: { transparent: true },
      }]),
    ]);
    expect((out[0].data as { materials: object[] }).materials[0]).toEqual({
      meshTargets: ['Glass'],
      values: { roughness: 0.5, color: '#ff0000' },
      exposedPorts: ['color'],
      materialSettings: { transparent: true },
    });
  });

  it('drops non-primitive VALUES rather than letting them ride', () => {
    const out = sanitizeOutputMaterials([
      output('o1', [{ meshTargets: ['Glass'], values: { a: 1, b: { deep: 1 } } }]),
    ]);
    expect((out[0].data as { materials: { values: object }[] }).materials[0].values)
      .toEqual({ a: 1 });
  });
});

describe('foldExtraOutputs — the multi-Output graph migration', () => {
  /** The shape the previous design produced: one Output per targeted mesh. */
  const legacy = () => {
    const base = makeNode('c1', 'color');
    const part = makeNode('c2', 'color');
    const def = output('o1');
    const glass = output('o2');
    (glass.data as Record<string, unknown>).meshTarget = { name: 'Glass' };
    (glass.data as Record<string, unknown>).values = { roughness: 0.3 };
    return {
      nodes: [base, part, def, glass],
      edges: [
        makeEdge('c1', 'out', 'o1', 'color'),
        makeEdge('c2', 'out', 'o2', 'color'),
      ],
    };
  };

  it('is a no-op for the ordinary single-Output graph', () => {
    const nodes = [output('o1'), makeNode('c1', 'color')];
    const edges = [makeEdge('c1', 'out', 'o1', 'color')];
    const folded = foldExtraOutputs(nodes, edges);
    expect(folded.nodes).toBe(nodes);
    expect(folded.edges).toBe(edges);
  });

  it('folds a targeted Output into a material and KEEPS its wiring', () => {
    // Without the re-pointing, the extra Output sits inert and whatever was
    // wired into it silently stops emitting.
    const { nodes, edges } = legacy();
    const folded = foldExtraOutputs(nodes, edges);
    expect(outputNodes(folded.nodes)).toHaveLength(1);
    const out = outputNodes(folded.nodes)[0];
    expect(out.id).toBe('o1');
    expect((out.data as { materials: object[] }).materials).toEqual([
      { meshTargets: ['Glass'], values: { roughness: 0.3 } },
    ]);
    // The part edge now points at the surviving node's namespaced handle.
    const handles = folded.edges
      .filter((e) => e.target === 'o1')
      .map((e) => e.targetHandle)
      .sort();
    expect(handles).toEqual(['color', 'm1:color']);
  });

  it('re-derives the moved edge\'s id from its new endpoints', () => {
    // The id is endpoint-derived, so a stale one collides with the next edge
    // that really does connect this pair, and any dedupe keyed on it drops one.
    const { nodes, edges } = legacy();
    const moved = foldExtraOutputs(nodes, edges).edges.find((e) => e.targetHandle === 'm1:color')!;
    expect(moved.id).toContain('m1:color');
    expect(moved.id).not.toContain('o2');
  });

  it('KEEPS an extra UNTARGETED Output, wiring and all — it is an ordinary inactive Output now', () => {
    // Several Outputs may coexist with exactly one active (utils/sdfPartition.ts);
    // only the LEGACY per-node mesh target still folds. Same arrays back.
    const nodes = [output('o1'), output('o2'), makeNode('c1', 'color')];
    const edges = [makeEdge('c1', 'out', 'o2', 'color')];
    const folded = foldExtraOutputs(nodes, edges);
    expect(folded.nodes).toBe(nodes);
    expect(folded.edges).toBe(edges);
  });

  it('keeps the ACTIVE Output as the survivor when folding a legacy targeted extra', () => {
    const a = output('o1');
    const b = output('o2');
    (b.data as Record<string, unknown>).activeOutput = true;
    const glass = output('o3');
    (glass.data as Record<string, unknown>).meshTarget = { name: 'Glass' };
    const folded = foldExtraOutputs([a, b, glass], [makeEdge('c', 'out', 'o3', 'color')]);
    expect(outputNodes(folded.nodes).map((n) => n.id)).toEqual(['o1', 'o2']);
    expect((folded.nodes.find((n) => n.id === 'o2')!.data as { materials?: { meshTargets?: string[] }[] }).materials?.map((m) => m.meshTargets)).toEqual([['Glass']]);
    expect(folded.edges[0].target).toBe('o2');
  });

  it('respects the cap when folding, and keeps a duplicate claim', () => {
    const nodes: AppNode[] = [output('o1')];
    for (let i = 0; i < MAX_PARTS + 3; i++) {
      const n = output(`x${i}`);
      // Two of them claim the same mesh.
      (n.data as Record<string, unknown>).meshTarget = { name: i === 1 ? 'Glass' : `mesh${i}` };
      nodes.push(n);
    }
    (nodes[1].data as Record<string, unknown>).meshTarget = { name: 'Glass' };
    const folded = foldExtraOutputs(nodes, []);
    const materials = (outputNodes(folded.nodes)[0].data as { materials: object[] }).materials;
    expect(materials.length).toBeLessThanOrEqual(MAX_PARTS);
    // The duplicate is FOLDED IN rather than skipped: its wiring is re-pointed
    // and survives, shadowed at emission, exactly as sanitizeOutputMaterials
    // treats one that arrives from localStorage.
    const names = materials.flatMap((m) => materialTargetNames(m));
    expect(names.filter((n) => n === 'Glass')).toHaveLength(2);
  });
});

describe('shiftMaterialHandles — removing a material renumbers the rest', () => {
  const edges = () => [
    makeEdge('c0', 'out', 'o1', 'color'),      // the default: never moves
    makeEdge('c1', 'out', 'o1', 'm1:color'),   // the removed one
    makeEdge('c2', 'out', 'o1', 'm2:color'),   // must become m1:color
    makeEdge('c3', 'out', 'o1', 'm3:emissive'), // must become m2:emissive
    makeEdge('c4', 'out', 'other', 'm2:color'), // another node: untouched
  ];

  it('moves only the materials BELOW the removed one', () => {
    const out = shiftMaterialHandles(edges(), 'o1', 1);
    expect(out.map((e) => `${e.target}:${e.targetHandle}`)).toEqual([
      'o1:color',
      'o1:m1:color',   // the removed material's own edge — the caller deletes it
      'o1:m1:color',
      'o1:m2:emissive',
      'other:m2:color',
    ]);
  });

  it('re-derives the moved edge\'s id, which is endpoint-derived', () => {
    // A stale id collides with the next edge that really does connect this
    // pair, and React Flow's element id then names a handle that is gone.
    const moved = shiftMaterialHandles(edges(), 'o1', 1)[3];
    expect(moved.id).toContain('m2:emissive');
    expect(moved.id).not.toContain('m3:');
  });

  it('returns the SAME array when nothing moved', () => {
    const list = edges();
    // Removing the LAST material moves nothing below it.
    expect(shiftMaterialHandles(list, 'o1', 9)).toBe(list);
  });
});

/**
 * Dormant sections — the "different model clears it, the right model restores
 * it" behaviour is a pure VISIBILITY rule over the session-only inventory:
 * data, edges and emission never change, which is what makes the restore
 * perfect. These pins are the rule's edges.
 */
describe('dormantMaterialIndices', () => {
  const mats = (...targets: (string[] | null)[]) =>
    [{}, ...targets.map((t) => (t ? { meshTargets: t } : {}))];

  it('hides an added material whose EVERY mesh is absent', () => {
    expect(dormantMaterialIndices(mats(['Body']), [])).toEqual(new Set([1]));
    expect(dormantMaterialIndices(mats(['Body']), ['Other'])).toEqual(new Set([1]));
  });

  it('keeps a PARTIALLY present material visible (the picker marks the rest)', () => {
    expect(dormantMaterialIndices(mats(['Body', 'Glass']), ['Glass'])).toEqual(new Set());
  });

  it('never hides material 0 or an EMPTY added material', () => {
    // Material 0 is the node's own channel state; an empty material names
    // nothing to be missing — it is a "No mesh" state to resolve, and hiding
    // it would orphan it forever.
    expect(dormantMaterialIndices(mats(null), [])).toEqual(new Set());
    expect(dormantMaterialIndices([{ meshTargets: ['Gone'] }, { meshTargets: ['Gone2'] }], [])).toEqual(
      new Set([1]),
    );
  });

  it('reads the legacy single meshTarget shape through materialTargetNames', () => {
    const legacy = [{}, { meshTarget: { name: 'Old' } }];
    expect(dormantMaterialIndices(legacy, [])).toEqual(new Set([1]));
    expect(dormantMaterialIndices(legacy, ['Old'])).toEqual(new Set());
  });

  it('wakes the section the moment its name is back', () => {
    expect(dormantMaterialIndices(mats(['Body']), ['Body'])).toEqual(new Set());
  });
});

describe('outputDefaultContributes / dormantIndicesForPreview (the context rules)', () => {
  const mats = (...targets: string[][]) => [{}, ...targets.map((t) => ({ meshTargets: t }))];

  it('storedValueEmits treats the documented no-ops as absent', () => {
    expect(storedValueEmits('discard', 0)).toBe(false);
    expect(storedValueEmits('position', 0)).toBe(false);
    expect(storedValueEmits('normal', '#8080FF')).toBe(false);
    expect(storedValueEmits('color', '#00ff00')).toBe(true);
    expect(storedValueEmits('discard', 0.5)).toBe(true);
  });

  it('material 0 contributes via a BARE-handle edge, never an m<n>: one', () => {
    const out = output('o1', [{ meshTargets: ['Body'] }]);
    expect(outputDefaultContributes(out, [makeEdge('f1', 'out', 'o1', 'm1:color')])).toBe(false);
    expect(outputDefaultContributes(out, [makeEdge('f1', 'out', 'o1', 'color')])).toBe(true);
  });

  it('material 0 contributes via an emitting stored value on an EXPOSED channel only', () => {
    const out = output('o1');
    (out.data as { values?: Record<string, unknown> }).values = { color: '#00ff00' };
    expect(outputDefaultContributes(out, [])).toBe(true);
    // Exposure-gated (emission is): a tampered value on a hidden channel is inert.
    (out.data as { exposedPorts?: string[] }).exposedPorts = ['roughness'];
    expect(outputDefaultContributes(out, [])).toBe(false);
    // A documented no-op value never counts.
    const noop = output('o2');
    (noop.data as { values?: Record<string, unknown> }).values = { discard: 0 };
    expect(outputDefaultContributes(noop, [])).toBe(false);
  });

  it('an UNKNOWN inventory (model loaded, report pending) hides nothing', () => {
    // The swap window: the chip must not claim "for another model" about the
    // very model that is loading.
    expect(
      dormantIndicesForPreview(mats(['Body']), {
        meshNames: [], inventoryKnown: false, defaultContributes: true,
      }),
    ).toEqual(new Set());
  });

  it("mirrors the 0.6 single-mesh fallback: parts-only + one mesh keeps the FIRST named material visible", () => {
    // That material is actively SHADING the screen — hiding it behind a
    // "for another model" chip would be a lie.
    const opts = { meshNames: [] as string[], inventoryKnown: true, defaultContributes: false };
    expect(dormantIndicesForPreview(mats(['Body'], ['Glass']), opts)).toEqual(new Set([2]));
    // A contributing default disarms the loader fallback, so both sleep.
    expect(
      dormantIndicesForPreview(mats(['Body'], ['Glass']), { ...opts, defaultContributes: true }),
    ).toEqual(new Set([1, 2]));
    // On a MULTI-mesh mismatched model the loader leaves authored materials
    // alone (variants fallback), so no exemption — both sleep.
    expect(
      dormantIndicesForPreview(mats(['Body'], ['Glass']), {
        ...opts, meshNames: ['OtherX', 'OtherY'],
      }),
    ).toEqual(new Set([1, 2]));
    // The exemption skips an EMPTY material and lands on the first NAMED one.
    expect(
      dormantIndicesForPreview([{}, {}, { meshTargets: ['Body'] }], opts),
    ).toEqual(new Set());
  });

  it('outputDormancyFromState derives the same set from a whole-store shape', () => {
    const out = output('o1', [{ meshTargets: ['Body'] }]);
    (out.data as { values?: Record<string, unknown> }).values = { color: '#00ff00' };
    const state = {
      nodes: [out], edges: [], previewMesh: null,
      previewMeshInventory: null,
    };
    // No custom model: inventory KNOWN (primitives), default contributes ->
    // the section sleeps and the visible count drops to material 0 alone.
    expect(outputDormancyFromState(state)).toEqual({
      outputId: 'o1', dormant: new Set([1]), visibleCount: 1,
    });
    // The matching model wakes it.
    expect(
      outputDormancyFromState({
        ...state, previewMesh: {}, previewMeshInventory: { meshes: [{ name: 'Body' }] },
      }).dormant,
    ).toEqual(new Set());
    // Loaded but unreported: hold off.
    expect(
      outputDormancyFromState({ ...state, previewMesh: {}, previewMeshInventory: null }).dormant,
    ).toEqual(new Set());
  });
});
