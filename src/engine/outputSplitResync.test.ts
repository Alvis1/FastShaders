/**
 * THE RESYNC after the Output split (plan step 6b).
 *
 * `codeToGraph` mints one Output NODE per material now, and every one of them
 * is labelled the literal string `"Output"`. The resync's pass-1 key used to be
 * `registryType + label`, so all of them landed in ONE bucket and paired by
 * ARRAY ORDER — an Apply silently moving one material's id, position,
 * exposedPorts and stored values ONTO ANOTHER MESH, with `errors: []` and
 * byte-identical emitted output. Nothing downstream notices; the only evidence
 * is that the node the user had been editing is shading something else.
 *
 * So the swap is attacked DIRECTLY here (`labelPairing` is a transcription of
 * the old rule, so each case is shown to fail the old code rather than pass
 * vacuously), and the headline property — apply∘apply on a multi-material GLB
 * document adds NO node and moves NOTHING — is executed over the real builder,
 * the real emitter and the real parser.
 *
 * `useSyncEngine` is a React hook and the vitest env is `node`, which is why
 * the pairing, the placement and the per-key settings carry live in the pure
 * `utils/resyncPairing.ts` rather than inside it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { buildGltfSectionGraph } from './gltfSectionBuilder';
import { encodeRequests } from '@/utils/gltfImportPlan';
import { encodeGltfImages, type GltfEncodedImage } from '@/utils/gltfTextureEncode';
import { blenderGlb, fakeEncoder, fakeStash, readOk, scanGlb } from './gltfImportFixtures';
import {
  carryMaterialSettings,
  matchKey,
  pairResyncNodes,
  placeParsedOutputs,
  type ResyncPairing,
} from '@/utils/resyncPairing';
import {
  UNFOLD_DY,
  gltfIndexOf,
  isIndexSection,
  materialTargetNames,
  outputMaterials,
  outputsInEmitOrder,
} from '@/utils/outputMaterials';
import { carryInactiveSinks } from '@/utils/sinkCarry';
import { makeEdge, makeNode } from '@/test-utils';
import type { AppEdge, AppNode, MaterialSettings } from '@/types';
import type { GltfModelReport } from '@/utils/gltfReader';

const isOut = (n: AppNode) => n.data.registryType === 'output';
const outs = (nodes: readonly AppNode[]) => outputsInEmitOrder(nodes.filter(isOut));
const dataOf = (n: AppNode) => n.data as Record<string, unknown>;

/** Every Output's binding in emit order, in `matchKey`'s own vocabulary. */
const bindings = (nodes: readonly AppNode[]) => outs(nodes).map(matchKey);

/** An Output NODE bound to `meshes` (none = the untargeted default). */
function outputNode(id: string, emitOrder: number, meshes: string[] = [], extra: Record<string, unknown> = {}): AppNode {
  const n = makeNode(id, 'output');
  const d = dataOf(n);
  d.emitOrder = emitOrder;
  if (meshes.length > 0) d.meshTargets = meshes;
  Object.assign(d, extra);
  return n;
}

/**
 * The pairing with the PRE-SPLIT KEY — `registryType + label` — and everything
 * else held exactly as it is today, so the KEY alone is what these cases put
 * under test.
 *
 * That isolation is the point. The candidate rule had to widen when a material
 * became a node (every TARGETED Output contributes, so every one of them must
 * be pairable), and widening it while the key stayed `label` is precisely the
 * swap: all of them land in one bucket labelled `"Output"` and pair by ARRAY
 * ORDER. Transcribed rather than imported so each case is shown to FAIL the old
 * rule — a pin that only passes the new code proves nothing about the defect it
 * names.
 */
function labelPairing(oldNodes: readonly AppNode[], newNodes: readonly AppNode[], activeOldId: string | null): ResyncPairing {
  const key = (n: AppNode) => `${n.data.registryType}\0${n.data.label}`;
  const byKey = new Map<string, AppNode[]>();
  const byType = new Map<string, AppNode[]>();
  for (const o of oldNodes) {
    const sink = o.data.registryType === 'output' || o.data.registryType === 'raymarchOutput';
    const targeted = o.data.registryType === 'output'
      && materialTargetNames(outputMaterials(o)[0]).length + (isIndexSection(outputMaterials(o)[0]) ? 1 : 0) > 0;
    if (sink && o.id !== activeOldId && !targeted) continue;
    (byKey.get(key(o)) ?? byKey.set(key(o), []).get(key(o))!).push(o);
    const t = o.data.registryType;
    (byType.get(t) ?? byType.set(t, []).get(t)!).push(o);
  }
  const used = new Set<string>();
  const paired: { node: AppNode; match: AppNode }[] = [];
  const unpaired: AppNode[] = [];
  const take = (list: AppNode[] | undefined) => list?.find((o) => !used.has(o.id));
  for (const n of newNodes) {
    const m = take(byKey.get(key(n)));
    if (m) { used.add(m.id); paired.push({ node: n, match: m }); }
  }
  const done = new Set(paired.map((p) => p.node.id));
  for (const n of newNodes) {
    if (done.has(n.id)) continue;
    const m = take(byType.get(n.data.registryType));
    if (m) { used.add(m.id); paired.push({ node: n, match: m }); }
    else unpaired.push(n);
  }
  return { paired, unpaired };
}

/** new-node binding → the old node it paired with. */
const pairedBy = (p: ResyncPairing) =>
  new Map(p.paired.filter((x) => isOut(x.node)).map((x) => [matchKey(x.node), x.match.id]));

/* ── the swap: two Outputs whose ONLY difference is the mesh ──────────────── */

describe('an Apply cannot move one material onto another mesh', () => {
  /**
   * The attack. Two targeted Outputs, identical in every way the OLD key could
   * see — same registryType, same label "Output", same channel wired from a
   * colour — differing only in the mesh they name and in the number each one
   * stores. Everything else about the document is symmetric, so if the pairing
   * crosses, the Body node comes back wearing Glass's roughness.
   */
  function twoMeshDoc() {
    const body = outputNode('body-node', 1, ['Body'], {
      values: { roughness: 0.25 },
      exposedPorts: ['color', 'roughness'],
    });
    body.position = { x: 100, y: 100 };
    const glass = outputNode('glass-node', 2, ['Glass'], {
      values: { roughness: 0.75 },
      exposedPorts: ['color', 'roughness'],
    });
    glass.position = { x: 100, y: 300 };
    const nodes: AppNode[] = [
      outputNode('default-node', 0),
      makeNode('c1', 'color', { hex: '#112233' }),
      makeNode('c2', 'color', { hex: '#445566' }),
      body,
      glass,
    ];
    const edges: AppEdge[] = [
      makeEdge('c1', 'out', 'body-node', 'color'),
      makeEdge('c2', 'out', 'glass-node', 'color'),
    ];
    return { nodes, edges };
  }

  it('nothing crosses over: each parsed material pairs with the node bound to ITS mesh', () => {
    const { nodes, edges } = twoMeshDoc();
    const parsed = codeToGraph(graphToCode(nodes, edges).code);
    expect(parsed.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    const pairs = pairedBy(pairResyncNodes(nodes, parsed.nodes, 'default-node'));
    expect(pairs.get(matchKey(outputNode('x', 0, ['Body'])))).toBe('body-node');
    expect(pairs.get(matchKey(outputNode('x', 0, ['Glass'])))).toBe('glass-node');
    expect(pairs.get('output\0default')).toBe('default-node');
  });

  it('the values, ports and position that ride the pairing stay with their own mesh', () => {
    const { nodes, edges } = twoMeshDoc();
    const parsed = codeToGraph(graphToCode(nodes, edges).code);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const { node, match } of pairResyncNodes(nodes, parsed.nodes, 'default-node').paired) {
      if (!isOut(node)) continue;
      // `mergeMatch` takes the DATA from the parse and the id + position from
      // the old node, so a crossed pair shows up as an old node's position
      // arriving under a different mesh's material.
      const mesh = materialTargetNames(outputMaterials(node)[0])[0] ?? 'default';
      const old = byId.get(match.id)!;
      expect(materialTargetNames(outputMaterials(old)[0])[0] ?? 'default').toBe(mesh);
      expect(old.position).toEqual(match.position);
    }
  });

  it('the OLD label-only key really does cross them — this pin is not vacuous', () => {
    const { nodes, edges } = twoMeshDoc();
    // The parse emits `parts` in emit order, so the module reads Body then
    // Glass; the OLD graph is reordered so the two arrays disagree, which is
    // what `liftChildrenAfterParents` does on an ordinary drag-into-a-group.
    const reordered = [nodes[0], nodes[1], nodes[2], nodes[4], nodes[3]];
    const parsed = codeToGraph(graphToCode(nodes, edges).code);
    const crossed = pairedBy(labelPairing(reordered, parsed.nodes, 'default-node'));
    // Glass's material landed on the node that shades Body — silently, with
    // `errors: []` and byte-identical emitted output.
    expect(crossed.get(matchKey(outputNode('x', 0, ['Glass'])))).toBe('body-node');
    expect(crossed.get(matchKey(outputNode('x', 0, ['Body'])))).not.toBe('body-node');
    // The real rule is unmoved by the same reordering.
    const real = pairedBy(pairResyncNodes(reordered, parsed.nodes, 'default-node'));
    expect(real.get(matchKey(outputNode('x', 0, ['Glass'])))).toBe('glass-node');
    expect(real.get(matchKey(outputNode('x', 0, ['Body'])))).toBe('body-node');
  });
});

/* ── index nodes ─────────────────────────────────────────────────────────── */

describe('an import-built document pairs by glTF material index', () => {
  it('each index node keeps its own identity, and a reordered array changes nothing', () => {
    const sig = { materials: ['A', 'B', 'C'] };
    const mk = (i: number) => outputNode(`ix-${i}`, i + 1, [], { gltfMaterialIndex: i, modelSignature: sig });
    const nodes = [outputNode('def', 0), mk(0), mk(1), mk(2)];
    const parsed = [outputNode('p0', 0), mk(2), mk(0), mk(1)].map((n, i) => ({ ...n, id: `new-${i}` }) as AppNode);
    const pairs = pairedBy(pairResyncNodes(nodes, parsed, 'def'));
    expect(pairs.get('output\u0000i0')).toBe('ix-0');
    expect(pairs.get('output\u0000i1')).toBe('ix-1');
    expect(pairs.get('output\u0000i2')).toBe('ix-2');
    expect(pairs.get('output\u0000default')).toBe('def');
  });

  it('a material naming the same meshes in a different order is the same material', () => {
    expect(matchKey(outputNode('a', 1, ['Glass', 'Body'])))
      .toBe(matchKey(outputNode('b', 1, ['Body', 'Glass'])));
    expect(matchKey(outputNode('a', 1, ['Body'])))
      .not.toBe(matchKey(outputNode('b', 1, ['Body', 'Glass'])));
  });
});

/* ── which old sinks may be paired ───────────────────────────────────────── */

describe('a PARKED sink is never a pairing candidate, a TARGETED one always is', () => {
  it('an inactive untargeted Output is left for carryInactiveSinks', () => {
    const active = outputNode('active', 0);
    const parked = outputNode('parked', 1);
    const parsed = [outputNode('new', 0)];
    const p = pairResyncNodes([active, parked], parsed, 'active');
    expect(p.paired.map((x) => x.match.id)).toEqual(['active']);
    expect(p.unpaired).toEqual([]);
  });

  it('a targeted Output is a candidate even though it is not the active sink', () => {
    const def = outputNode('def', 0);
    const body = outputNode('body', 1, ['Body']);
    const parsed = [outputNode('n0', 0), outputNode('n1', 1, ['Body'])];
    const pairs = pairedBy(pairResyncNodes([def, body], parsed, 'def'));
    expect(pairs.get(matchKey(body))).toBe('body');
  });

  it('a Raymarch Output still pairs on its label, and an inactive one does not', () => {
    const march = makeNode('rm', 'raymarchOutput');
    const other = makeNode('rm2', 'raymarchOutput');
    const parsed = [makeNode('new', 'raymarchOutput')];
    expect(pairResyncNodes([march, other], parsed, 'rm').paired.map((x) => x.match.id)).toEqual(['rm']);
  });
});

/* ── a re-bound Output keeps its identity ────────────────────────────────── */

describe('renaming a mesh in the code panel keeps the node', () => {
  it('falls to the type pass and inherits the old node', () => {
    const body = outputNode('body', 1, ['Body']);
    body.position = { x: 40, y: 80 };
    const nodes = [outputNode('def', 0), body];
    const parsed = [outputNode('n0', 0), outputNode('n1', 1, ['Torso'])];
    const p = pairResyncNodes(nodes, parsed, 'def');
    expect(p.unpaired).toEqual([]);
    expect(p.paired.find((x) => matchKey(x.node) === matchKey(parsed[1]))!.match.id).toBe('body');
  });
});

/* ── placement: an unpaired Output must not delete the group frames ──────── */

describe('an unpaired Output is PLACED, never laid out', () => {
  it('leaves nothing unpositioned, so the group-preservation gate cannot fire', () => {
    const def = { ...outputNode('def', 0), position: { x: 500, y: 200 } } as AppNode;
    const a = { ...outputNode('a', 1, ['Body']), position: { x: 500, y: 380 } } as AppNode;
    const fresh = outputNode('fresh', 2, ['Glass']);
    const { placed, rest } = placeParsedOutputs([def, a], [fresh], [def, a]);
    expect(rest).toEqual([]);
    expect(placed).toHaveLength(1);
    // Below the LOWEST positioned Output, on the unfold's own pitch, so the
    // column keeps its shape.
    expect(placed[0].position).toEqual({ x: 500, y: 380 + UNFOLD_DY });
    // The node is otherwise untouched — same id, same data.
    expect(placed[0].id).toBe('fresh');
    expect(placed[0].data).toBe(fresh.data);
  });

  it('stacks several in emit order, and is deterministic', () => {
    const def = { ...outputNode('def', 0), position: { x: 10, y: 20 } } as AppNode;
    const news = [outputNode('c', 3, ['C']), outputNode('b', 1, ['B']), outputNode('a', 2, ['A'])];
    const first = placeParsedOutputs([def], news, [def]);
    const second = placeParsedOutputs([def], news, [def]);
    expect(first.placed.map((n) => n.id)).toEqual(['b', 'a', 'c']);
    expect(first.placed.map((n) => n.position.y)).toEqual([20 + UNFOLD_DY, 20 + 2 * UNFOLD_DY, 20 + 3 * UNFOLD_DY]);
    expect(second.placed.map((n) => n.position)).toEqual(first.placed.map((n) => n.position));
  });

  it('leaves every OTHER new node to the relayout — today\'s path for a new Multiply', () => {
    const def = { ...outputNode('def', 0), position: { x: 0, y: 0 } } as AppNode;
    const mul = makeNode('mul1', 'mul');
    const out = outputNode('o', 1, ['Body']);
    const { placed, rest } = placeParsedOutputs([def], [mul, out], [def]);
    expect(placed.map((n) => n.id)).toEqual(['o']);
    expect(rest.map((n) => n.id)).toEqual(['mul1']);
  });

  it('hands them back when there is no Output to anchor to', () => {
    const { placed, rest } = placeParsedOutputs([makeNode('c1', 'color')], [outputNode('o', 0)], []);
    expect(placed).toEqual([]);
    expect(rest.map((n) => n.id)).toEqual(['o']);
  });
});

/* ── …and it reads ONE coordinate space ──────────────────────────────────── */

/**
 * React Flow v12 positions are PARENT-RELATIVE, and `mergeMatch` copies a
 * matched node's `position` while spreading the PARSED node — so `positioned`
 * carries relative coordinates with NO parentId on them, and the group block
 * restores parentId afterwards and only for ids the old graph had. Reading
 * those numbers as absolute put a new material a whole group-origin away, and
 * ranking them against a root Output's absolute y picked the wrong anchor
 * outright.
 */
describe('the anchor is read in ABSOLUTE space', () => {
  const group = (id: string, x: number, y: number, parentId?: string) => ({
    ...makeNode(id, 'color'),
    type: 'group',
    position: { x, y },
    ...(parentId ? { parentId } : {}),
  }) as unknown as AppNode;

  it('a grouped anchor places the newcomer at the group origin plus its offset', () => {
    const g = group('g', 1000, 600);
    const a = { ...outputNode('a', 1, ['Body']), position: { x: 20, y: 40 }, parentId: 'g' } as AppNode;
    // What `mergeMatch` produces: the old node's position, no parentId.
    const merged = { ...outputNode('a', 1, ['Body']), position: { x: 20, y: 40 } } as AppNode;
    const fresh = outputNode('fresh', 2, ['Glass']);
    const { placed } = placeParsedOutputs([merged], [fresh], [g, a]);
    expect(placed[0].position).toEqual({ x: 1020, y: 640 + UNFOLD_DY });
    // Root-level: it does not inherit the frame (see the function's own doc).
    expect((placed[0] as { parentId?: string }).parentId).toBeUndefined();
  });

  it('the LOWEST anchor is chosen in ONE space, not across two', () => {
    const g = group('g', 0, 1500);
    const rootOut = { ...outputNode('root', 1, ['A']), position: { x: 0, y: 900 } } as AppNode;
    const inGroup = { ...outputNode('in', 2, ['B']), position: { x: 0, y: 100 }, parentId: 'g' } as AppNode;
    const mergedInGroup = { ...outputNode('in', 2, ['B']), position: { x: 0, y: 100 } } as AppNode;
    const fresh = outputNode('fresh', 3, ['C']);
    const { placed } = placeParsedOutputs([rootOut, mergedInGroup], [fresh], [g, rootOut, inGroup]);
    // The grouped one is at absolute y 1600, below the root one's 900. Read
    // relatively, 900 > 100 and the root node wins — the wrong anchor AND the
    // wrong space.
    expect(placed[0].position.y).toBe(1600 + UNFOLD_DY);
  });

  it('a nested chain sums the whole way up', () => {
    const outer = group('outer', 100, 100);
    const inner = group('inner', 50, 50, 'outer');
    const a = { ...outputNode('a', 1, ['Body']), position: { x: 10, y: 10 }, parentId: 'inner' } as AppNode;
    const merged = { ...outputNode('a', 1, ['Body']), position: { x: 10, y: 10 } } as AppNode;
    const { placed } = placeParsedOutputs([merged], [outputNode('fresh', 2, ['Glass'])], [outer, inner, a]);
    expect(placed[0].position).toEqual({ x: 160, y: 160 + UNFOLD_DY });
  });

  it('a parentId cycle terminates', () => {
    // A forward guard, not a reproduction: a chain comes out of a
    // `.fastshader` and may name itself, and the walk must not hang an Apply.
    const g1 = group('g1', 10, 10, 'g2');
    const g2 = group('g2', 20, 20, 'g1');
    const a = { ...outputNode('a', 1, ['Body']), position: { x: 0, y: 0 }, parentId: 'g1' } as AppNode;
    const merged = { ...outputNode('a', 1, ['Body']), position: { x: 0, y: 0 } } as AppNode;
    const { placed } = placeParsedOutputs([merged], [outputNode('fresh', 2, ['Glass'])], [g1, g2, a]);
    expect(placed).toHaveLength(1);
    expect(Number.isFinite(placed[0].position.y)).toBe(true);
  });
});

describe('source pin: the hook hands over the old graph', () => {
  it('passes oldNodes, the only place an anchor\u2019s frame still is', () => {
    // `useSyncEngine` is a React hook and the vitest env is `node`, so this one
    // line — which decides whether the fix is reachable at all — can only be
    // pinned.
    const hook = readFileSync(resolve(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');
    expect(hook).toContain('placeParsedOutputs(positioned, pairing.unpaired, oldNodes)');
  });
});

/* ── the per-key materialSettings carry ──────────────────────────────────── */

describe('materialSettings carry per key', () => {
  const FULL: MaterialSettings = {
    transparent: true,
    side: 'double',
    alphaTest: 0.5,
    depthWrite: false,
    displacementMode: 'offset',
    mergeVertices: false,
  };

  it('a TARGETED node takes the four emitted keys from the CODE and carries the other two', () => {
    // The user deleted `transparent` from the part's body: the parse produces a
    // node without it, and the carry must not put it back.
    const merged = outputNode('m', 1, ['Body'], { materialSettings: { side: 'double' } });
    carryMaterialSettings(merged, outputNode('old', 1, ['Body'], { materialSettings: FULL }));
    expect(dataOf(merged).materialSettings).toEqual({
      side: 'double',
      displacementMode: 'offset',
      mergeVertices: false,
    });
  });

  it('the UNTARGETED default carries all six — its settings are never in editor code', () => {
    const merged = outputNode('m', 0);
    carryMaterialSettings(merged, outputNode('old', 0, [], { materialSettings: FULL }));
    expect(dataOf(merged).materialSettings).toEqual(FULL);
  });

  it('never mutates either side, and adds no key when there is nothing to carry', () => {
    const old = outputNode('old', 1, ['Body'], { materialSettings: { transparent: true } });
    const oldSettings = dataOf(old).materialSettings;
    const merged = outputNode('m', 1, ['Body'], { materialSettings: { transparent: false } });
    const parsedSettings = dataOf(merged).materialSettings;
    carryMaterialSettings(merged, old);
    // Nothing to carry — the four are code-authoritative here — so the parse's
    // own object is left exactly as it was, by reference.
    expect(dataOf(merged).materialSettings).toBe(parsedSettings);
    expect(dataOf(old).materialSettings).toBe(oldSettings);

    const bare = outputNode('b', 1, ['Body']);
    carryMaterialSettings(bare, outputNode('o', 1, ['Body']));
    expect(dataOf(bare).materialSettings).toBeUndefined();
  });

  it('junk on either side is not carried — a string would spray index keys', () => {
    for (const junk of ['abc', 5, [1, 2], true, null]) {
      const merged = outputNode('m', 0);
      carryMaterialSettings(merged, outputNode('old', 0, [], { materialSettings: junk }));
      expect(dataOf(merged).materialSettings, JSON.stringify(junk)).toBeUndefined();
    }
    // …and a junk PARSED value is replaced rather than spread over.
    const merged = outputNode('m', 0, [], { materialSettings: 'abc' });
    carryMaterialSettings(merged, outputNode('old', 0, [], { materialSettings: { side: 'double' } }));
    expect(dataOf(merged).materialSettings).toEqual({ side: 'double' });
  });

  it('a whole-object overwrite would put the deleted key back — the old rule, shown failing', () => {
    const merged = outputNode('m', 1, ['Body'], { materialSettings: { side: 'double' } });
    const old = outputNode('old', 1, ['Body'], { materialSettings: FULL });
    // What the resync did before: `merged.data.materialSettings = old...`.
    const whole = { ...(dataOf(old).materialSettings as MaterialSettings) };
    expect(whole.transparent).toBe(true);
    carryMaterialSettings(merged, old);
    expect((dataOf(merged).materialSettings as MaterialSettings).transparent).toBeUndefined();
  });
});

/* ── the headline: apply∘apply on a real GLB document ────────────────────── */

async function builtGlb(bytes: Uint8Array): Promise<{ nodes: AppNode[]; edges: AppEdge[] }> {
  const m: GltfModelReport = readOk(bytes);
  const materials = m.materials.filter((x) => x.usage.primitives > 0).map((x) => x.index);
  const { requests } = encodeRequests(m, materials);
  const enc = await encodeGltfImages(m, requests, {
    modelName: 'model.glb',
    maxDim: null,
    deviceMaxDim: 2048,
    ignoreLimits: false,
    budgetChars: Infinity,
    encode: fakeEncoder([]),
    stash: fakeStash(),
  });
  const encoded: Map<number, GltfEncodedImage> = enc.encoded;
  const built = buildGltfSectionGraph(m, { materials, encoded });
  return { nodes: built.nodes, edges: built.edges };
}

describe('apply∘apply on a multi-material GLB document adds NO node and moves NOTHING', () => {
  // The FIRST Apply is not a fixed point by design — Image nodes are one-way
  // through `codeToGraph` — so the invariant is over two successive parses of
  // the emitted module, which is what a user pressing Apply twice does.
  it.each([['BLENDER', blenderGlb], ['SCAN', scanGlb]] as const)('%s', async (_name, glb) => {
    const built = await builtGlb(glb());
    const a = codeToGraph(graphToCode(built.nodes, built.edges).code);
    const b = codeToGraph(graphToCode(a.nodes, a.edges).code);
    expect(a.errors.filter((e) => e.severity !== 'warning')).toEqual([]);

    // Vacuity: the corpus really carries several index sections.
    expect(outs(a.nodes).length).toBeGreaterThan(2);
    expect(outs(a.nodes).slice(1).every((n) => isIndexSection(outputMaterials(n)[0]))).toBe(true);

    // Nothing was ADDED: the node and edge counts hold, and every OUTPUT pairs.
    const p = pairResyncNodes(a.nodes, b.nodes, outs(a.nodes)[0].id);
    expect(p.unpaired.filter(isOut)).toEqual([]);
    // …and nothing is CARRIED on top of them. Every Output here is rebuilt from
    // its own `materialParts` entry, so `carryInactiveSinks` must add none of
    // them beside the parse's copy — that is what stops a model import gaining
    // an Output per mesh on every Apply (utils/sinkCarry.ts).
    const carried = carryInactiveSinks(
      a.nodes, a.edges, outs(a.nodes)[0].id,
      new Set(p.paired.map((x) => x.match.id)), b.nodes.some(isOut),
    );
    expect(carried.nodes).toEqual([]);
    expect(b.nodes).toHaveLength(a.nodes.length);
    expect(b.edges).toHaveLength(a.edges.length);

    // Nothing MOVED: each material paired with the node holding the same
    // binding, in the same order.
    expect(bindings(b.nodes)).toEqual(bindings(a.nodes));
    for (const { node, match } of p.paired) {
      if (!isOut(node)) continue;
      expect(matchKey(match)).toBe(matchKey(node));
      expect(gltfIndexOf(outputMaterials(match)[0])).toBe(gltfIndexOf(outputMaterials(node)[0]));
    }
    // …and the module is a fixed point from here on, which is what makes the
    // graph one. BLENDER's flipped normal map is the pre-split exception the
    // import suite documents: its `unknown` fallback renames `normalMap1` to
    // `float5` ONCE, on this very pass. Nothing else in the text moves, and the
    // pass after it is exact.
    const second = graphToCode(a.nodes, a.edges).code;
    const third = graphToCode(b.nodes, b.edges).code;
    expect(third.replace(/\bfloat5\b/g, 'normalMap1')).toBe(second);
    const c = codeToGraph(third);
    expect(graphToCode(c.nodes, c.edges).code).toBe(third);
    expect(bindings(c.nodes)).toEqual(bindings(a.nodes));
  });

  /**
   * The WHOLE graph, so the group-preservation gate (`unpositioned.length === 0`
   * in useSyncEngine) provably cannot fire on a re-Apply: nothing at all is
   * unpaired, Output or feeder.
   *
   * SCAN only. BLENDER carries the documented pre-split exception — its flipped
   * normal map goes through the `unknown` fallback, whose synthetic name
   * RENAMES once (gltfSectionBuilder.test.ts says so), so one `float` comes
   * back under a different label and falls to the type pass with no free
   * partner. That is a `normalMap` naming quirk, not a property of the Output
   * split: the node COUNT above still holds, and every Output still pairs.
   */
  it('SCAN: nothing at all is unpaired, so the group frames survive a re-Apply', async () => {
    const built = await builtGlb(scanGlb());
    const a = codeToGraph(graphToCode(built.nodes, built.edges).code);
    const b = codeToGraph(graphToCode(a.nodes, a.edges).code);
    const p = pairResyncNodes(a.nodes, b.nodes, outs(a.nodes)[0].id);
    expect(p.unpaired).toEqual([]);
    // …and even if something were, only NON-Outputs could reach the relayout.
    expect(placeParsedOutputs(a.nodes, p.unpaired, a.nodes).rest).toEqual([]);
  });

  it('the OLD label-only key crosses the materials of the same document', async () => {
    const built = await builtGlb(blenderGlb());
    const a = codeToGraph(graphToCode(built.nodes, built.edges).code);
    // A layout gesture reorders the Outputs in the array — which is all it
    // takes, because under the old key they are one bucket labelled "Output".
    const reordered = [...a.nodes].reverse();
    const b = codeToGraph(graphToCode(a.nodes, a.edges).code);
    const old = labelPairing(reordered, b.nodes, outs(a.nodes)[0].id);
    const crossed = old.paired.filter((x) => isOut(x.node) && matchKey(x.match) !== matchKey(x.node));
    expect(crossed.length).toBeGreaterThan(0);
    // The real rule pairs every one of them by binding, whatever the order.
    const real = pairResyncNodes(reordered, b.nodes, outs(a.nodes)[0].id);
    expect(real.paired.filter((x) => isOut(x.node) && matchKey(x.match) !== matchKey(x.node))).toEqual([]);
  });
});
