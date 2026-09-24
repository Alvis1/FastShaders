import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HISTORY_IDLE, makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import {
  activeSink,
  drivingMarchOutput,
  isUntargetedOutput,
  marchWindowRadius,
  normalizeActiveOutput,
  clearActiveOutput,
  hasActiveFlag,
} from './sdfPartition';
import {
  defaultOutput,
  findDefaultOutput,
  materialTargetNames,
  moduleSettingsOutput,
  outputMaterials,
  unfoldOutputMaterials,
} from './outputMaterials';
import { carryInactiveSinks } from './sinkCarry';
import { pairResyncNodes } from './resyncPairing';
import { computeReachableCost, costSeeds, getCost, nodeCostPoints } from './nodeCost';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { connectedUniformNamesKey } from './connectedUniforms';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';

/**
 * Several output nodes — plain Outputs and Raymarch Outputs — may coexist and
 * exactly ONE is active. The flag is node data (`activeOutput: true`), ABSENT
 * on every document that never had a choice made, so those keep emitting
 * under the historical rule byte-for-byte. See utils/sdfPartition.ts.
 */

const flag = (n: AppNode): AppNode => ({ ...n, data: { ...n.data, activeOutput: true } }) as AppNode;

const pos = () => makeNode('pos', 'positionLocal');
const sd = () => makeNode('sd', 'sdCircle');
const rm = () => makeNode('rm', 'raymarchOutput');
const out = (id = 'out1') => makeNode(id, 'output');
/** An Output bound to meshes of its own — a `parts` entry, not the default. */
const targeted = (n: AppNode, names: string[]): AppNode =>
  ({ ...n, data: { ...n.data, meshTargets: names } }) as AppNode;
const marchWired = () => [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field')];

describe('activeSink — the ONE resolver', () => {
  it('with no flag: the first WIRED Raymarch Output, else the first Output (the historical rule)', () => {
    expect(activeSink([pos(), sd(), rm(), out()], marchWired())?.id).toBe('rm');
    expect(activeSink([pos(), sd(), rm(), out()], marchWired().slice(0, 1))?.id).toBe('out1');
    expect(activeSink([out('a'), out('b')], [])?.id).toBe('a');
    expect(activeSink([pos()], [])).toBeNull();
  });

  it('the flag wins over wiring and over array order', () => {
    expect(activeSink([pos(), sd(), rm(), flag(out())], marchWired())?.id).toBe('out1');
    expect(activeSink([pos(), sd(), flag(rm()), out()], [])?.id).toBe('rm');
    expect(activeSink([out('a'), flag(out('b'))], [])?.id).toBe('b');
  });

  it('only the literal true counts (node data is untrusted)', () => {
    const junk = { ...out('b'), data: { ...out('b').data, activeOutput: 'yes' } } as AppNode;
    expect(activeSink([out('a'), junk], [])?.id).toBe('a');
    expect(hasActiveFlag(junk)).toBe(false);
  });

  it('drivingMarchOutput / marchWindowRadius / findDefaultOutput all follow it', () => {
    const nodes = [pos(), sd(), rm(), flag(out())];
    expect(drivingMarchOutput(nodes, marchWired())).toBeNull();
    expect(marchWindowRadius(nodes, marchWired())).toBeNull();
    const flaggedRm = flag(rm());
    (flaggedRm.data as { values: Record<string, number> }).values = { window: 7 };
    expect(drivingMarchOutput([pos(), sd(), flaggedRm, out()], [])?.id).toBe('rm');
    expect(marchWindowRadius([pos(), sd(), flaggedRm, out()], [])).toBe(7);
    expect(findDefaultOutput([out('a'), flag(out('b'))])?.id).toBe('b');
  });
});

describe('normalizeActiveOutput / clearActiveOutput', () => {
  it('returns the SAME array when nothing needed changing', () => {
    const nodes = [out('a'), flag(out('b')), pos()];
    expect(normalizeActiveOutput(nodes)).toBe(nodes);
    expect(clearActiveOutput([out('a'), pos()])).toEqual([out('a'), pos()]);
  });

  it('keeps the FIRST true and strips every other flag and every junk value', () => {
    const junk = { ...out('c'), data: { ...out('c').data, activeOutput: 1 } } as AppNode;
    const nodes = [out('a'), flag(out('b')), flag(rm()), junk];
    const next = normalizeActiveOutput(nodes);
    expect(next).not.toBe(nodes);
    expect(next.map((n) => hasActiveFlag(n))).toEqual([false, true, false, false]);
    expect('activeOutput' in (next[2].data as object)).toBe(false);
    expect('activeOutput' in (next[3].data as object)).toBe(false);
  });

  it('clearActiveOutput strips the flag from a fragment', () => {
    const next = clearActiveOutput([flag(out('a')), flag(rm())]);
    expect(next.some(hasActiveFlag)).toBe(false);
  });
});

/**
 * ONLY AN UNTARGETED plain Output may be elected. A targeted one is a `parts`
 * entry: electing it would hand it the module's TOP-LEVEL channels as well —
 * the same material painted twice, the module-level copy repainting every mesh
 * no other material claims — while it also became the cost seed, the Uniforms
 * scope, the preview window's owner and Preview mode's target. An import-built
 * document's first Output node is a targeted one, so the old
 * `nodes.find(registryType === 'output')` fallback would have picked exactly
 * that node.
 */
describe('the election is narrowed to UNTARGETED plain Outputs', () => {
  it('a graph whose FIRST Output is targeted elects the untargeted one instead', () => {
    const nodes = [targeted(out('a'), ['Body']), out('b')];
    expect(activeSink(nodes, [])?.id).toBe('b');
    expect(defaultOutput(nodes)?.id).toBe('b');
    // The old rule — array order, blind to targeting — picked 'a'.
    expect(findDefaultOutput(nodes)?.id).toBe('a');
  });

  /**
   * An EMPTY section — a material naming no mesh, which "shades nothing" and is
   * the state a mesh swap passes through — is UNTARGETED, so once the split
   * gives it its own node it looks exactly like the default. Position told them
   * apart while every material lived on one node; `emitRank` is what tells them
   * apart now, and array order must not, or a drag-into-a-group could hand the
   * module's top-level channels to the empty one and silently drop `color:`.
   */
  it('among UNTARGETED Outputs the LOWEST-RANKED one is the default, whatever the array says', () => {
    const def = out('a');
    const empty = out('b');
    (def.data as Record<string, unknown>).emitOrder = 0;
    (empty.data as Record<string, unknown>).emitOrder = 3;
    expect(defaultOutput([def, empty])?.id).toBe('a');
    expect(defaultOutput([empty, def])?.id).toBe('a');
    // The FLAG still wins outright — it is an explicit choice about which
    // whole-model variant is in use.
    expect(defaultOutput([def, flag(empty)])?.id).toBe('b');
  });

  /**
   * `activeSink` and `defaultOutput` must name the SAME untargeted node.
   *
   * They did not: `activeSink` ended in `nodes.find(isUntargetedOutput)` —
   * ARRAY order — while `defaultOutput` had already moved to `emitRank`, so on
   * a split document whose EMPTY section sits ahead of the real default in the
   * array, `graphToCode` gave the module's top-level channels to one node while
   * the preview socket, the preview window's owner and Preview mode's target
   * followed the other. `liftChildrenAfterParents` puts a node in that slot on
   * an ordinary drag-into-a-group, so it needed no Output to be touched at all.
   *
   * The fix was to move `emitRank` into the zero-import contract leaf
   * (`engine/materialPartsContract.ts`, beside `isGltfMaterialIndex`, which is
   * there for the same reason) so the LEAF `sdfPartition.ts` can read the ONE
   * accessor — `utils/outputMaterials.ts` re-exports it from the same place, so
   * there is no second copy to drift.
   */
  it('activeSink elects the SAME untargeted node defaultOutput does, whatever the array order', () => {
    const def = out('a');
    const empty = out('b');
    (def.data as Record<string, unknown>).emitOrder = 0;
    (empty.data as Record<string, unknown>).emitOrder = 3;
    for (const order of [[def, empty], [empty, def]]) {
      expect(activeSink(order, [])?.id).toBe('a');
      expect(activeSink(order, [])?.id).toBe(defaultOutput(order)?.id);
    }
    // ONE accessor: the leaf reads the contract's, never a copy of its own.
    const leaf = readFileSync(resolve(__dirname, 'sdfPartition.ts'), 'utf8');
    expect(leaf).toContain("import { emitRank, isGltfMaterialIndex } from '@/engine/materialPartsContract';");
    expect(leaf).not.toMatch(/function emitRank\b/);
    const materials = readFileSync(resolve(__dirname, 'outputMaterials.ts'), 'utf8');
    expect(materials).not.toMatch(/export function emitRank\b/);
    expect(materials).toContain('export { MAX_INDEX_MATERIALS, MAX_MIRROR_ENTRIES, emitRank };');
  });

  it('with the ranks TIED, array order decides — so an unsplit document is unchanged', () => {
    // Every node of a document that never went through the unfold carries the
    // absent-key rank 0, and those must elect exactly what they always did.
    expect(defaultOutput([out('a'), out('b')])?.id).toBe('a');
    expect(defaultOutput([out('b'), out('a')])?.id).toBe('b');
  });

  it('a FLAG on a targeted node is neither honoured nor left in data', () => {
    const nodes = [flag(targeted(out('a'), ['Body'])), out('b')];
    expect(activeSink(nodes, [])?.id).toBe('b');
    const next = normalizeActiveOutput(nodes);
    expect(next).not.toBe(nodes);
    expect('activeOutput' in (next[0].data as object)).toBe(false);
    // Stripping it is what stops the choice being obeyed in-session and
    // silently reverting on the next restore: both rules ask one predicate.
    expect(activeSink(next, [])?.id).toBe('b');
  });

  it('an index-bound node is targeted too (the per-material split writes that key)', () => {
    const idx = out('gi');
    (idx.data as Record<string, unknown>).gltfMaterialIndex = 0;
    expect(isUntargetedOutput(idx)).toBe(false);
    expect(activeSink([idx, out('b')], [])?.id).toBe('b');
    // Junk in that key is NOT a binding — `isGltfMaterialIndex`'s rule.
    for (const v of ['0', 1.5, -1, Number.NaN, true, null, {}]) {
      const j = out('j');
      (j.data as Record<string, unknown>).gltfMaterialIndex = v;
      expect(isUntargetedOutput(j)).toBe(true);
    }
  });

  /**
   * RE-AIMED: the LAST-RESORT term is deleted.
   *
   * It existed because one node held every material, so a document whose only
   * Output is targeted would otherwise have had no sink at all and every
   * consumer read that as "nothing here" — the cost bar at 0, the Uniforms
   * overlay empty — while graphToCode emitted its parts perfectly. Both halves
   * of that are gone: the consumers ask the Output SET (`contributingOutputs`,
   * `costSeeds`), and array order — what the term picked by — is not a usable
   * order, so with several targeted Outputs it would have elected an arbitrary
   * one and a drag-into-a-group could move the choice.
   *
   * What it protected is pinned here directly: such a document still PRICES.
   */
  it('a document whose every Output is TARGETED has no sink — and still prices', () => {
    const only = [targeted(out('a'), ['Body'])];
    expect(defaultOutput(only)).toBeNull();
    expect(activeSink(only, [])).toBeNull();
    expect(costSeeds(only, []).map((n) => n.id)).toEqual(['a']);

    const feeder = makeNode('c1', 'color', { hex: '#223344' });
    const graph = [feeder, targeted(out('a'), ['Body'])];
    const edges = [makeEdge('c1', 'out', 'a', 'color')];
    expect(computeReachableCost(graph, edges)).toBe(nodeCostPoints(feeder, edges) + getCost('output'));
  });

  it('moduleSettingsOutput always answers while any Output exists (D1)', () => {
    // `buildShaderModule` writes the four keys at module level unconditionally,
    // so unlike the channels this question may not come back null.
    const only = [targeted(out('a'), ['Body'])];
    expect(moduleSettingsOutput(only)?.id).toBe('a');
    expect(moduleSettingsOutput([targeted(out('a'), ['Body']), out('b')])?.id).toBe('b');
    expect(moduleSettingsOutput([pos()])).toBeNull();
    // A Raymarch Output is never a candidate — its settings come from
    // `marchMaterialSettings`, which layers over this.
    expect(moduleSettingsOutput([rm()])).toBeNull();
  });

  it("moduleSettingsOutput's fallback follows emitOrder, never the nodes array", () => {
    // The four settings keys are module TEXT, and this fallback is reached on
    // any document where EVERY Output names a mesh. `liftChildrenAfterParents`
    // moves the nodes array on an ordinary drag-into-a-group and useSyncEngine
    // reorders on every Apply — so an array-ordered answer would rewrite the
    // module on a layout gesture, which is the exact class `emitOrder` exists
    // to close. `defaultOutput` already ranks; leaving its partner on array
    // order would have re-opened it through the back door.
    const rank = (n: AppNode, emitOrder: number): AppNode =>
      ({ ...n, data: { ...n.data, emitOrder } }) as AppNode;

    const a = rank(targeted(out('a'), ['Body']), 1);
    const b = rank(targeted(out('b'), ['Glass']), 2);
    expect(moduleSettingsOutput([b, a])?.id).toBe('a');
    expect(moduleSettingsOutput([a, b])?.id).toBe('a');

    // Equal ranks break by id, stably, in both array orders — `Array.sort` is
    // stable, so without the tie-break these would fall back to array order,
    // which is what is being closed.
    const c = rank(targeted(out('c'), ['Trim']), 1);
    expect(moduleSettingsOutput([c, a])?.id).toBe('a');
    expect(moduleSettingsOutput([a, c])?.id).toBe('a');
  });

  it('`isUntargetedOutput` and graphToCode\'s `material0Target` read one rule', () => {
    // The leaf restates `materialTargetNames(outputMaterials(n)[0]).length === 0`
    // over the raw fields (utils/sdfPartition.ts may not import the
    // store-coupled outputMaterials — the costTable TDZ rule), so the two can
    // drift silently. A name the sanitizer would refuse is NOT a binding: if
    // they disagreed there, the module's default holder would differ from the
    // node graphToCode resolves.
    const junk: unknown[] = [
      undefined, null, [], ['Body'], ['', 'Body'], [''], ['\u0000bad'], ['__proto__'],
      [{ name: 'Body' }], 'Body', 42, {}, [null], ['a'.repeat(5000)],
    ];
    for (const list of junk) {
      for (const single of [undefined, { name: 'Body' }, { name: '' }, { name: 42 }]) {
        const n = out('x');
        const d = n.data as Record<string, unknown>;
        if (list !== undefined) d.meshTargets = list;
        if (single !== undefined) d.meshTarget = single;
        expect(
          isUntargetedOutput(n),
          `meshTargets=${JSON.stringify(list)} meshTarget=${JSON.stringify(single)}`,
        ).toBe(materialTargetNames(outputMaterials(n)[0]).length === 0);
      }
    }
  });

  it('a Raymarch Output is elected whatever a plain Output names', () => {
    const nodes = [targeted(out('a'), ['Body']), rm()];
    expect(activeSink(nodes, marchWired())?.id).toBe('rm');
    expect(activeSink([flag(rm()), targeted(out('a'), ['Body'])], [])?.id).toBe('rm');
  });
});

describe('emission follows the active sink', () => {
  it('a document with no flag emits exactly what it always did', () => {
    const nodes = [pos(), sd(), rm(), out()];
    const { code } = graphToCode(nodes, marchWired());
    expect(code).toContain('const rm1 = Fn(');
    expect(code).not.toContain('activeOutput');
  });

  it('a flagged plain Output silences a wired march; its own chain emits', () => {
    const color = makeNode('c', 'color', { hex: '#ff0000' });
    const nodes = [pos(), sd(), rm(), flag(out()), color];
    const edges = [...marchWired(), makeEdge('c', 'out', 'out1', 'color')];
    const { code } = graphToCode(nodes, edges);
    expect(code).not.toContain('const rm1 = Fn(');
    expect(code).toContain('return color1;');
    // The march's feeders still emit as ordinary consts, so the carry can
    // keep the inactive node's wiring across an Apply.
    expect(code).toContain('const sdCircle1 = sdCircle(positionLocal1');
  });

  it('a flagged but UNWIRED Raymarch Output emits the "nothing wired" sentinel, not the plain Output', () => {
    const color = makeNode('c', 'color', { hex: '#ff0000' });
    const nodes = [flag(rm()), out(), color];
    const edges = [makeEdge('c', 'out', 'out1', 'color')];
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('return vec3(1, 0, 0);');
    expect(code).not.toContain('return color1;');
  });

  it('a second, flagged Output emits ITS chain, byte-identically to a lone Output with that chain', () => {
    const a = makeNode('a', 'color', { hex: '#ff0000' });
    const b = makeNode('b', 'color', { hex: '#00ff00' });
    const two = graphToCode(
      [out('o1'), flag(out('o2')), a, b],
      [makeEdge('a', 'out', 'o1', 'color'), makeEdge('b', 'out', 'o2', 'color')],
    ).code;
    const lone = graphToCode([out('o2'), a, b], [makeEdge('b', 'out', 'o2', 'color')]).code;
    expect(two).toBe(lone);
  });

  it('the Uniforms overlay lists only sliders that reach the ACTIVE sink', () => {
    const s1 = makeNode('s1', 'property_float', { name: 'one', value: 1 });
    const s2 = makeNode('s2', 'property_float', { name: 'two', value: 2 });
    const nodes = [out('o1'), flag(out('o2')), s1, s2];
    const edges = [makeEdge('s1', 'out', 'o1', 'roughness'), makeEdge('s2', 'out', 'o2', 'roughness')];
    const key = connectedUniformNamesKey(nodes, edges, { s1: 'one', s2: 'two' });
    expect(key).toContain('two');
    expect(key).not.toContain('one');
  });
});

describe('carryInactiveSinks — an Apply keeps the inactive outputs and their wiring', () => {
  /**
   * The 5th argument: did the PARSE mint a plain Output NODE at all? That is
   * the question "is there something in the code for a TARGETED Output to come
   * back as", and every case in this block but the march one below models a
   * module that answers yes.
   */
  const PARSE_HAS_OUTPUT = true;

  /** What the hook's `idMap` does: a paired node keeps its OLD id. */
  const idOf = (p: ReturnType<typeof pairResyncNodes>, id: string) =>
    p.paired.find((x) => x.node.id === id)?.match.id ?? id;

  it('carries every inactive sink verbatim plus the incoming edges whose source survived', () => {
    const a = makeNode('a', 'color');
    const b = makeNode('b', 'color');
    const gone = makeNode('gone', 'color');
    const nodes = [out('o1'), flag(out('o2')), rm(), a, b, gone];
    const edges = [
      makeEdge('a', 'out', 'o1', 'color'),
      makeEdge('b', 'out', 'o2', 'color'),
      makeEdge('gone', 'out', 'rm', 'field'),
    ];
    // After the parse: o2 (active) survived as itself, a and b were matched, gone was deleted.
    const surviving = new Set(['o2', 'a', 'b']);
    const carried = carryInactiveSinks(nodes, edges, 'o2', surviving, PARSE_HAS_OUTPUT);
    expect(carried.nodes.map((n) => n.id)).toEqual(['o1', 'rm']);
    expect(carried.edges.map((e) => e.id)).toEqual([edges[0].id]);
  });

  it('apply ∘ apply is stable: two Outputs survive two round trips with their edges', () => {
    const a = makeNode('a', 'color', { hex: '#ff0000' });
    const b = makeNode('b', 'color', { hex: '#00ff00' });
    let nodes: AppNode[] = [out('o1'), flag(out('o2')), a, b];
    let edges = [makeEdge('a', 'out', 'o1', 'color'), makeEdge('b', 'out', 'o2', 'color')];
    for (let pass = 0; pass < 2; pass++) {
      const { code } = graphToCode(nodes, edges);
      const parsed = codeToGraph(code);
      expect(parsed.nodes.filter((n) => n.data.registryType === 'output')).toHaveLength(1);
      // Model the hook's pairing: every parsed node pairs with an old node of
      // its type, the parsed sink with the ACTIVE old one only.
      const parsedSink = parsed.nodes.find((n) => n.data.registryType === 'output')!;
      const idMap = new Map<string, string>([[parsedSink.id, 'o2']]);
      for (const n of parsed.nodes) {
        if (n.id === parsedSink.id) continue;
        const old = nodes.find((o) => o.data.registryType === n.data.registryType && !idMap.has(o.id) && ![...idMap.values()].includes(o.id));
        if (old) idMap.set(n.id, old.id);
      }
      const merged = parsed.nodes.map((n) => ({ ...(nodes.find((o) => o.id === idMap.get(n.id)) ?? n), data: { ...n.data, ...(idMap.get(n.id) === 'o2' ? { activeOutput: true } : {}) } })) as AppNode[];
      const remapped = parsed.edges.map((e) => makeEdge(idMap.get(e.source) ?? e.source, e.sourceHandle ?? 'out', idMap.get(e.target) ?? e.target, e.targetHandle ?? 'in'));
      const carried = carryInactiveSinks(nodes, edges, 'o2', new Set(merged.map((n) => n.id)), PARSE_HAS_OUTPUT);
      nodes = normalizeActiveOutput([...merged, ...carried.nodes]);
      edges = [...remapped, ...carried.edges];
      expect(nodes.filter((n) => n.data.registryType === 'output')).toHaveLength(2);
      expect(edges).toHaveLength(2);
      expect(activeSink(nodes, edges)?.id).toBe('o2');
    }
  });

  /**
   * The Output split makes this the function's load-bearing rule, not a detail.
   * Every targeted Output CONTRIBUTES, so the parse re-creates it as a material
   * on the node it paired with — carrying the node too would add it BESIDE that
   * copy, and a GLB-imported document would gain one Output per mesh on every
   * Apply while emitting each part twice.
   */
  it('does NOT carry a TARGETED Output: it contributes, so the parse rebuilds it', () => {
    const feeder = makeNode('a', 'color');
    const def = out('o1');
    const glass = targeted(out('o2'), ['Glass']);
    const parked = out('o3');
    const nodes = [def, glass, parked, feeder];
    const edges = [makeEdge('a', 'out', 'o2', 'color'), makeEdge('a', 'out', 'o3', 'color')];
    // The parse paired with the default; neither extra survived under its id.
    const carried = carryInactiveSinks(nodes, edges, 'o1', new Set(['o1', 'a']), PARSE_HAS_OUTPUT);
    expect(carried.nodes.map((n) => n.id)).toEqual(['o3']);
    // …and the targeted one's wire is not carried either — the parse re-created
    // it from the `parts` entry, so carrying it would duplicate that too.
    expect(carried.edges.map((e) => e.target)).toEqual(['o3']);
  });

  /**
   * …and the ONE state in which that rule is wrong, because the premise it
   * rests on — "the module holds a `parts` entry to rebuild the node from" —
   * is false: a DRIVING Raymarch Output.
   *
   * `graphToCode` gates the whole Output pass on it
   * (`outputs = marchNode ? [] : contributingOutputs(nodes)`), so a marching
   * module carries no `parts`, no `materialParts` and no top-level channels.
   * The parse therefore mints NO plain Output, nothing pairs, and every
   * targeted Output plus its incoming edges was DELETED on Apply — silently,
   * and only PARTIALLY, since the untargeted default came back through the
   * carry and the graph went on working with some materials simply gone.
   *
   * The gate is what the PARSE holds, never what the old graph looks like: a
   * module with no plain Output has nothing a carried node could collide with,
   * by construction, while reading the old graph's march instead would
   * resurrect a material the user had just deleted from the code panel.
   */
  it('carries a TARGETED Output while a march DRIVES: the module holds no part to rebuild it from', () => {
    const feeder = makeNode('a', 'color', { hex: '#ff0000' });
    const nodes = [pos(), sd(), rm(), out('outA'), targeted(out('outB'), ['Glass']), feeder];
    const edges = [...marchWired(), makeEdge('a', 'out', 'outB', 'color')];

    // Vacuity: the march really drives, and the emitted module really says
    // nothing at all about either plain Output.
    expect(drivingMarchOutput(nodes, edges)?.id).toBe('rm');
    const { code } = graphToCode(nodes, edges);
    expect(code).not.toMatch(/\bparts\s*:/);
    const parsed = codeToGraph(code);
    const parseHasOutput = parsed.nodes.some((n) => n.data.registryType === 'output');
    expect(parseHasOutput).toBe(false);

    // The hook, modelled over its own pure halves: pair, then carry whatever
    // the parse could not have produced.
    const pairing = pairResyncNodes(nodes, parsed.nodes, 'rm');
    const surviving = new Set(pairing.paired.map((x) => x.match.id));
    const carried = carryInactiveSinks(nodes, edges, 'rm', surviving, parseHasOutput);

    expect([...carried.nodes].map((n) => n.id).sort()).toEqual(['outA', 'outB']);
    // …and the wire that fed it, which is the half nothing else could restore:
    // the feeder survived the parse, so the edge resolves.
    expect(carried.edges.map((e) => `${e.source}->${e.target}`)).toEqual(['a->outB']);

    // apply ∘ apply: the carried graph re-emits the same march module, so the
    // second Apply carries exactly the same pair — the document neither grows
    // nor loses anything from here.
    const merged = pairing.paired.map(
      (x) => ({ ...x.node, id: x.match.id, position: { ...x.match.position } }) as AppNode,
    );
    const next = [...merged, ...carried.nodes];
    const nextEdges = [
      ...parsed.edges.map((e) => makeEdge(
        idOf(pairing, e.source), e.sourceHandle ?? 'out',
        idOf(pairing, e.target), e.targetHandle ?? 'in',
      )),
      ...carried.edges,
    ];
    expect(next).toHaveLength(nodes.length);
    const again = codeToGraph(graphToCode(next, nextEdges).code);
    expect(again.nodes.some((n) => n.data.registryType === 'output')).toBe(false);
    const p2 = pairResyncNodes(next, again.nodes, 'rm');
    const carried2 = carryInactiveSinks(
      next, nextEdges, 'rm', new Set(p2.paired.map((x) => x.match.id)), false,
    );
    expect([...carried2.nodes].map((n) => n.id).sort()).toEqual(['outA', 'outB']);
    expect(carried2.edges.map((e) => `${e.source}->${e.target}`)).toEqual(['a->outB']);
  });

  /**
   * The other side of the same gate, and the one a NAIVE widening gets wrong.
   * Here the parse really did produce plain Outputs — one of them simply is not
   * this node's — so dropping the targeted clause outright instead of gating it
   * on the parse would carry `o3` back and resurrect, on every Apply, the
   * material the user had just deleted from the code panel by hand.
   */
  it('a material deleted from the code panel stays deleted', () => {
    const nodes = [out('o1'), targeted(out('o2'), ['Body']), targeted(out('o3'), ['Glass'])];
    // The user removed Glass's `parts` entry and renamed Body's mesh: the parse
    // mints the default plus ONE part, which the type pass hands to `o2` —
    // leaving `o3` with no partner and no entry in the text to come back from.
    const parsed = [out('p0'), targeted(out('p1'), ['Torso'])];
    const pairing = pairResyncNodes(nodes, parsed, 'o1');
    const surviving = new Set(pairing.paired.map((x) => x.match.id));
    expect([...surviving].sort()).toEqual(['o1', 'o2']);
    expect(carryInactiveSinks(nodes, [], 'o1', surviving, PARSE_HAS_OUTPUT).nodes).toEqual([]);
  });

  it('an unfolded GLB document carries NOTHING, so an Apply cannot grow it', () => {
    const o = out('o1');
    (o.data as Record<string, unknown>).modelSignature = { materials: ['A', 'B'] };
    (o.data as Record<string, unknown>).materials = [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }];
    const split = unfoldOutputMaterials([o, makeNode('c', 'color')], []);
    expect(split.nodes.filter((n) => n.data.registryType === 'output')).toHaveLength(3);
    // The default paired; both index siblings contribute and are rebuilt.
    expect(carryInactiveSinks(split.nodes, [], 'o1', new Set(['o1', 'c']), PARSE_HAS_OUTPUT).nodes).toEqual([]);
  });

  /**
   * The negative control the rule above is really protecting, run over the real
   * emitter, the real parser and the real pairing: a GLB-shaped document — an
   * untargeted default beside several TARGETED Outputs, which is what every
   * model import produces — must be a FIXED POINT across two successive
   * Applies. Each targeted node is rebuilt from its own `parts` entry and pairs
   * on its binding, so the carry must add NOTHING; carrying one too would put
   * it beside the parse's copy and the document would gain an Output per mesh
   * on every Apply while emitting each part twice.
   *
   * The three materials are wired to DIFFERENT colours on purpose: `codeToGraph`
   * merges byte-identical part bodies back into one material naming several
   * meshes, so identically wired parts would collapse and the count would fall
   * for a reason that has nothing to do with the carry.
   */
  it('apply ∘ apply on a GLB-shaped document with several TARGETED Outputs adds nothing', () => {
    let nodes: AppNode[] = [
      out('o1'),
      targeted(out('o2'), ['Body']),
      targeted(out('o3'), ['Glass']),
      makeNode('cDef', 'color', { hex: '#ff0000' }),
      makeNode('cBody', 'color', { hex: '#00ff00' }),
      makeNode('cGlass', 'color', { hex: '#0000ff' }),
    ];
    let edges = [
      makeEdge('cDef', 'out', 'o1', 'color'),
      makeEdge('cBody', 'out', 'o2', 'color'),
      makeEdge('cGlass', 'out', 'o3', 'color'),
    ];
    const before = nodes.length;

    for (let pass = 0; pass < 2; pass++) {
      const { code } = graphToCode(nodes, edges);
      // Vacuity: both materials really are in the module, each exactly once.
      expect(code.match(/Body/g) ?? []).toHaveLength(1);
      expect(code.match(/Glass/g) ?? []).toHaveLength(1);
      const parsed = codeToGraph(code);
      const parseHasOutput = parsed.nodes.some((n) => n.data.registryType === 'output');
      expect(parseHasOutput).toBe(true);
      expect(parsed.nodes.filter((n) => n.data.registryType === 'output')).toHaveLength(3);

      const active = activeSink(nodes, edges)!;
      const pairing = pairResyncNodes(nodes, parsed.nodes, active.id);
      expect(pairing.unpaired).toEqual([]);
      const idMap = new Map(pairing.paired.map((x) => [x.node.id, x.match.id]));
      const merged = pairing.paired.map(
        (x) => ({ ...x.node, id: x.match.id, position: { ...x.match.position } }) as AppNode,
      );
      const carried = carryInactiveSinks(
        nodes, edges, active.id, new Set(merged.map((n) => n.id)), parseHasOutput,
      );
      expect(carried.nodes).toEqual([]);

      nodes = normalizeActiveOutput([...merged, ...carried.nodes]);
      edges = [
        ...parsed.edges.map((e) => makeEdge(
          idMap.get(e.source) ?? e.source, e.sourceHandle ?? 'out',
          idMap.get(e.target) ?? e.target, e.targetHandle ?? 'in',
        )),
        ...carried.edges,
      ];
      expect(nodes).toHaveLength(before);
      expect(nodes.filter((n) => n.data.registryType === 'output').map((n) => n.id).sort())
        .toEqual(['o1', 'o2', 'o3']);
      expect(materialTargetNames(outputMaterials(nodes.find((n) => n.id === 'o2')!)[0])).toEqual(['Body']);
      expect(materialTargetNames(outputMaterials(nodes.find((n) => n.id === 'o3')!)[0])).toEqual(['Glass']);
    }
  });

  it('the hook pairs through resyncPairing and normalises the final list (source pins)', () => {
    const src = readFileSync(resolve(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');
    // WHICH old sinks may be paired at all is `pairable` in resyncPairing.ts,
    // pinned by its own suite; the hook only supplies the active id.
    expect(src).toContain('pairResyncNodes(oldNodes, result.nodes, oldActive?.id ?? null)');
    expect(src).toContain('if (isSinkNode(match) && hasActiveFlag(match)) {');
    expect(src).toContain("carryInactiveSinks(oldNodes, realOldEdges, oldActive?.id ?? null, survivingIds, parseHasPlainOutput)");
    // …and the 5th argument is read off the PARSE. Only a source pin can cover
    // this: derived from the OLD graph instead (“did a march drive”) the carry
    // would resurrect a material deleted from the code panel by hand, and the
    // pure suite above cannot see which array the hook hands it.
    expect(src).toContain('const parseHasPlainOutput = result.nodes.some(isOutputNode);');
    // With every plain Output TARGETED there is no active sink, and an unpaired
    // parsed Output would come back unpositioned — which trips the
    // `unpositioned.length === 0` gate and deletes every group frame. Two
    // mechanisms close that now, and the retired
    // `?? contributingOutputs(oldNodes)[0]` term (which could only name an
    // arbitrary targeted node "the active sink") must not come back: every
    // targeted Output is a pairing candidate on its own, and an unpaired one is
    // PLACED rather than laid out.
    expect(src).not.toContain('?? contributingOutputs(');
    // …and it is handed `oldNodes`, the only place a positioned Output's FRAME
    // still is: `mergeMatch` copies `id` and `position` and nothing else, so
    // without it the placement reads parent-relative numbers as absolute.
    expect(src).toContain('placeParsedOutputs(positioned, pairing.unpaired, oldNodes)');
    expect(src).toContain('finalNodes = normalizeActiveOutput(finalNodes);');
    // The carry sits inside the same gate as the orphan carry — never after autoLayout.
    expect(src.indexOf('carryInactiveSinks(oldNodes')).toBeGreaterThan(src.indexOf('if (unpositioned.length === 0) {'));
    expect(src.indexOf('carryInactiveSinks(oldNodes')).toBeLessThan(src.indexOf('// Preserve group nodes from the old graph'));
  });
});

describe('store.setActiveOutput', () => {
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });

  it('moves the flag in ONE history entry and ignores a non-sink id', () => {
    const c = makeNode('c', 'color');
    useAppStore.setState({ nodes: [out('o1'), out('o2'), c] as AppNode[], edges: [] });
    const store = useAppStore.getState();
    store.setActiveOutput('c');
    expect(useAppStore.getState().past).toHaveLength(0);
    store.setActiveOutput('o2');
    expect(useAppStore.getState().past).toHaveLength(1);
    expect(useAppStore.getState().nodes.map((n) => hasActiveFlag(n))).toEqual([false, true, false]);
    store.setActiveOutput('o1');
    expect(useAppStore.getState().nodes.map((n) => hasActiveFlag(n))).toEqual([true, false, false]);
    // Re-activating the active node is a no-op — no entry, no notify.
    const before = useAppStore.getState().nodes;
    store.setActiveOutput('o1');
    expect(useAppStore.getState().nodes).toBe(before);
    expect(useAppStore.getState().past).toHaveLength(2);
  });

  /**
   * RE-AIMED with the Output-node split: the order is now
   * sanitize -> unfold -> normalize on every path, so the election runs over
   * the node SET that actually exists. It used to run BEFORE `foldExtraOutputs`
   * so the fold kept the flagged Output; nothing folds any more, and the split
   * can turn one flagged node into several, exactly one of which may keep it.
   */
  it('every restore path normalises the flag AFTER the split, and a saved group loses it (source pins)', () => {
    const store = readFileSync(resolve(__dirname, '../store/useAppStore.ts'), 'utf8');
    const load = store.slice(store.indexOf('export function loadGraph()'), store.indexOf('export function reportImagesStrippedOnLoad('));
    expect(load, 'loadGraph must normalise the split result').toContain('data.nodes = normalizeActiveOutput(data.nodes);');
    expect(
      load.indexOf('unfoldOutputMaterials(data.nodes, data.edges)'),
      'and it must do so AFTER the split',
    ).toBeLessThan(load.indexOf('data.nodes = normalizeActiveOutput(data.nodes);'));
    // The saved group's Output sections are sanitized WITH a count (the
    // output-sections-trimmed notice), split, then its flag is cleared.
    expect(store, 'a saved group is a fragment — its flag is cleared at load').toContain('const nodes = clearActiveOutput(split.nodes);');
    expect(store, 'instantiate splits the COMBINED list, live graph first').toContain('unfoldOutputMaterials(\n      sanitizeOutputMaterials([group, ...state.nodes, ...members] as AppNode[]),');
    const at = store.indexOf('instantiateSavedGroup: (savedId, position, opts) => {');
    const inst = store.slice(at, store.indexOf('applyLangAttribute(', at));
    expect(inst).toContain('const nodes = normalizeActiveOutput(split.nodes);');
    const imp = readFileSync(resolve(__dirname, '../engine/projectImport.ts'), 'utf8');
    expect(imp).toContain('const nodes = normalizeActiveOutput(split.nodes);');
    expect(imp.indexOf('unfoldOutputMaterials(dataSanitized.nodes, edges)'))
      .toBeLessThan(imp.indexOf('normalizeActiveOutput(split.nodes)'));
  });
});
