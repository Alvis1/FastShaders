/**
 * THE cross-node Output plans, and the property that made them a module.
 *
 * Every plan here answers a question about the node SET, so the answer is the
 * same for every Output card asking — but each card computed its own, because
 * `allOutputs` was a per-instance `useMemo` and every derivation hung off its
 * array identity. That is O(N²): a 16-material GLB import mints ~17 cards, each
 * running the same six plans over the same 17 nodes.
 *
 * A source pin could never have caught it — `useMemo(() =>
 * planNamedPartsAcross(contributing), [contributing])` reads perfectly correct
 * in isolation — which is exactly why this file exists and why the headline
 * test COUNTS the shared walk rather than grepping for it.
 *
 * `isolate: false` (vite.config.ts) shares this module's memos between every
 * test file in a worker, so NO assertion here may assume a cold memo: each
 * identity test establishes its own baseline by calling twice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import {
  contributingOutputs,
  defaultOutput,
  firstNamedOutputId,
  indexSectionCoverageAcross,
  moduleSignatureOf,
  outputNodes,
  planIndexPartsAcross,
  planNamedPartsAcross,
  type LoadedModel,
} from '@/utils/outputMaterials';
import {
  defaultContributesOf,
  indexClaimLabels,
  meshNamesOf,
  outputBindingsKey,
  outputPlansFor,
} from './outputNodePlans';
import { isActiveSinkSelector } from './activeSinkSelector';

const SIGNATURE = ['MatA', 'MatB', 'MatC'];

/** An Output NODE in the post-split shape. */
function out(
  id: string,
  rank: number,
  extra: Record<string, unknown> = {},
): AppNode {
  const n = makeNode(id, 'output');
  const d = n.data as Record<string, unknown>;
  d.emitOrder = rank;
  Object.assign(d, extra);
  return n;
}

const named = (id: string, rank: number, meshTargets: string[]) => out(id, rank, { meshTargets });
const indexed = (id: string, rank: number, gltfMaterialIndex: number) =>
  out(id, rank, { gltfMaterialIndex, modelSignature: { materials: SIGNATURE.slice() } });

/** A `gltf` LoadedModel whose `meshMaterials` COUNTS every iteration of it. */
function countingModel(meshes: number): { loaded: LoadedModel; walks: () => number } {
  const real = new Map<string, { materials: number[] }>();
  for (let i = 0; i < meshes; i++) real.set(`Mesh${i}`, { materials: [i % SIGNATURE.length] });
  let walks = 0;
  const proxy = new Proxy(real, {
    get(t, p, r) {
      if (p === Symbol.iterator) {
        walks++;
        return Map.prototype[Symbol.iterator].bind(t);
      }
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return {
    loaded: {
      kind: 'gltf',
      signature: SIGNATURE,
      meshMaterials: proxy as unknown as LoadedModel & { kind: 'gltf' } extends never ? never
        : Extract<LoadedModel, { kind: 'gltf' }>['meshMaterials'],
    },
    walks: () => walks,
  };
}

/** A 16-material import's shape: an untargeted default plus N index nodes. */
function importedDoc(n: number): AppNode[] {
  const nodes: AppNode[] = [out('gi_output', 0)];
  for (let i = 0; i < n; i++) nodes.push(indexed(`gi_output_m${i}`, i + 1, i % SIGNATURE.length));
  return nodes;
}

describe('the plans are computed ONCE for the canvas', () => {
  it('N cards asking share ONE coverage walk', () => {
    const nodes = importedDoc(3);
    const { loaded, walks } = countingModel(64);
    // Establish the baseline: `isolate: false` means the memo may already hold
    // another file's entry, and the FIRST call here is the one that fills it.
    outputPlansFor(nodes, loaded);
    const after = walks();
    // Sixteen more cards rendering in the same pass.
    for (let i = 0; i < 16; i++) outputPlansFor(nodes, loaded);
    expect(walks()).toBe(after);
  });

  it('every card gets the SAME object, so every memo keyed on it stays put', () => {
    const nodes = importedDoc(3);
    const { loaded } = countingModel(8);
    const first = outputPlansFor(nodes, loaded);
    expect(outputPlansFor(nodes, loaded)).toBe(first);
    expect(outputPlansFor(nodes, loaded).contributing).toBe(first.contributing);
  });
});

describe('what moves the plans, and what does not', () => {
  it('a DRAG frame is free — new node objects, the same `data`', () => {
    const nodes = importedDoc(3);
    const { loaded } = countingModel(8);
    const first = outputPlansFor(nodes, loaded);
    // Exactly what `applyNodeChanges` produces for a position-only change.
    const moved = nodes.map((n) => ({ ...n, position: { x: n.position.x + 7, y: n.position.y } }));
    expect(outputPlansFor(moved, loaded)).toBe(first);
  });

  it('a COLOUR SCRUB is free — new `data`, the same bindings', () => {
    const nodes = importedDoc(2);
    const { loaded } = countingModel(8);
    const first = outputPlansFor(nodes, loaded);
    const scrubbed = nodes.map((n) => ({
      ...n,
      data: { ...n.data, values: { color: '#ff0000' } },
    })) as AppNode[];
    // The key folds bindings only, so a value edit does not move it…
    expect(outputBindingsKey(scrubbed)).toBe(outputBindingsKey(nodes));
    // …and therefore does not re-run six whole-graph derivations on 17 cards.
    expect(outputPlansFor(scrubbed, loaded)).toBe(first);
  });

  it('a BINDING change recomputes, and MOVES the answer', () => {
    const { loaded } = countingModel(8);
    const before = [out('def', 0), named('a', 1, ['Body'])];
    const first = outputPlansFor(before, loaded);
    expect(first.named.entries.map((e) => e.name)).toEqual(['Body']);

    const after = [out('def', 0), named('a', 1, ['Glass'])];
    const next = outputPlansFor(after, loaded);
    expect(next).not.toBe(first);
    expect(next.named.entries.map((e) => e.name)).toEqual(['Glass']);
  });

  it('`loaded` is part of the key — it is the one input the string cannot fold', () => {
    const nodes = importedDoc(2);
    const a = countingModel(4);
    const b = countingModel(4);
    const first = outputPlansFor(nodes, a.loaded);
    const second = outputPlansFor(nodes, b.loaded);
    expect(second).not.toBe(first);
  });

  it('never answers about a DIFFERENT document that reuses the same ids', () => {
    const { loaded } = countingModel(8);
    const first = outputPlansFor([out('def', 0), named('a', 1, ['Body'])], loaded);
    const other = outputPlansFor([out('def', 0), named('a', 1, ['Wheel'])], loaded);
    expect(other).not.toBe(first);
    expect(other.named.entries.map((e) => e.name)).toEqual(['Wheel']);
  });
});

describe('the plans equal what EMISSION walks', () => {
  // The whole point of sharing them is that the card's marks and the emitted
  // module cannot disagree; a memo that drifted would be invisible otherwise.
  const cases: Record<string, AppNode[]> = {
    'import-built': importedDoc(3),
    'named + default': [out('def', 0), named('a', 1, ['Body']), named('b', 2, ['Glass'])],
    'mixed': [out('def', 0), indexed('i', 1, 0), named('n', 2, ['Body'])],
    // Array order REVERSED: `emitRank` decides, never the array, and the plans
    // must agree with emission on a document a layout gesture has reordered.
    'outputsReversed': [named('b', 2, ['Glass']), named('a', 1, ['Body']), out('def', 0)],
    'all targeted (no default)': [named('a', 1, ['Body']), named('b', 2, ['Glass'])],
  };

  for (const [name, nodes] of Object.entries(cases)) {
    it(`${name}: every field matches a direct derivation`, () => {
      const { loaded } = countingModel(16);
      const plans = outputPlansFor(nodes, loaded);
      const outs = outputNodes(nodes);
      const contributing = contributingOutputs(outs);
      const sig = moduleSignatureOf(contributing);
      const namedPlan = planNamedPartsAcross(contributing);

      expect(plans.contributing.map((n) => n.id)).toEqual(contributing.map((n) => n.id));
      expect(plans.defaultId).toEqual(defaultOutput(outs)?.id ?? null);
      expect(plans.firstNamedId).toEqual(firstNamedOutputId(outs));
      expect(plans.moduleSignature).toEqual(sig);
      expect(plans.named.entries).toEqual(namedPlan.entries);
      expect(plans.index.entries).toEqual(planIndexPartsAcross(contributing, sig).entries);
      expect(plans.coverage).toEqual(
        indexSectionCoverageAcross(contributing, sig, loaded, namedPlan),
      );
    });
  }
});

describe('indexClaimLabels', () => {
  it('is keyed on the plans AND the language, and on nothing else', () => {
    const nodes = importedDoc(3);
    const { loaded } = countingModel(16);
    const plans = outputPlansFor(nodes, loaded);
    const en = indexClaimLabels(plans, 'en');
    expect(indexClaimLabels(plans, 'en')).toBe(en);
    const lv = indexClaimLabels(plans, 'lv');
    expect(lv).not.toBe(en);
    // …and back again: a single entry, so the language switch re-words rather
    // than accumulating one map per language per document.
    expect(indexClaimLabels(plans, 'en')).not.toBe(lv);
  });

  it('language is NOT in the plans key — the plans stay language-free', () => {
    const nodes = importedDoc(2);
    const { loaded } = countingModel(8);
    const first = outputPlansFor(nodes, loaded);
    indexClaimLabels(first, 'lv');
    expect(outputPlansFor(nodes, loaded)).toBe(first);
  });
});

describe('the two per-notify selector helpers', () => {
  it('meshNamesOf shares ONE array per inventory object', () => {
    const inv = { meshes: [{ name: 'Body' }, { name: 'Glass' }] };
    const first = meshNamesOf(inv);
    expect(meshNamesOf(inv)).toBe(first);
    expect(first.names).toEqual(['Body', 'Glass']);
    expect(first.key).toBe('Body\u0000Glass');
  });

  it('meshNamesOf takes an absent inventory, and a new report moves it', () => {
    expect(meshNamesOf(null).names).toEqual([]);
    expect(meshNamesOf(undefined).names).toEqual([]);
    const a = meshNamesOf({ meshes: [{ name: 'A' }] });
    const b = meshNamesOf({ meshes: [{ name: 'A' }] });
    expect(b).not.toBe(a);
    expect(b.key).toBe(a.key);
  });

  it('defaultContributesOf is shared per (nodes, edges) pair', () => {
    const nodes = [out('def', 0)];
    const edges: never[] = [];
    const first = defaultContributesOf(nodes, edges);
    expect(defaultContributesOf(nodes, edges)).toBe(first);
    expect(first).toBe(false);
  });
});

describe('the active-sink selector is answered once per notify', () => {
  it('N cards asking scan the node list ONCE', () => {
    // Every Output and Raymarch card asks, and the answer is a property of the
    // SET. Worse than it reads on the common path: the active-FLAG shortcut
    // only fires once someone has clicked a preview socket, and an
    // import-built document never has — so all seventeen fell through to
    // `activeSink`, each allocating the whole unwrapped edge array, per drag
    // frame.
    const nodes = importedDoc(3);
    let scans = 0;
    const counted = new Proxy(nodes, {
      get(t, p, r) {
        if (p === Symbol.iterator) scans++;
        const v = Reflect.get(t, p, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as AppNode[];
    const state = { nodes: counted, edges: [] as never[] };
    // Baseline: the first ask is the miss that fills the memo.
    isActiveSinkSelector('gi_output')(state);
    const after = scans;
    for (let i = 0; i < 16; i++) isActiveSinkSelector(`gi_output_m${i % 3}`)(state);
    expect(scans).toBe(after);
  });

  it('still answers per node, and moves when the graph does', () => {
    const a = [out('def', 0), out('other', 1, { activeOutput: true })];
    expect(isActiveSinkSelector('other')({ nodes: a, edges: [] })).toBe(true);
    expect(isActiveSinkSelector('def')({ nodes: a, edges: [] })).toBe(false);
    const b = [out('def', 0, { activeOutput: true }), out('other', 1)];
    expect(isActiveSinkSelector('def')({ nodes: b, edges: [] })).toBe(true);
    expect(isActiveSinkSelector('other')({ nodes: b, edges: [] })).toBe(false);
  });
});

describe('the _01 suffix that tells several Output cards apart', () => {
  const ordinalsOf = (nodes: AppNode[]) => {
    const { loaded } = countingModel(4);
    return outputPlansFor(nodes, loaded).ordinals;
  };

  it('is SILENT on a document with one Output', () => {
    // Every document that predates per-material shading, and every simple
    // shader — the header must not gain a number that says nothing.
    expect(ordinalsOf([out('only', 0)]).size).toBe(0);
  });

  it('numbers every Output once there are several', () => {
    const got = ordinalsOf([out('def', 0), named('a', 1, ['Body']), named('b', 2, ['Glass'])]);
    expect(got.get('def')).toBe('_01');
    expect(got.get('a')).toBe('_02');
    expect(got.get('b')).toBe('_03');
  });

  it('follows EMIT order, not array order', () => {
    // The nodes array is spliced by a drag-into-a-group and reordered by every
    // Apply, so an array-order number would renumber the whole column after a
    // gesture that changed nothing visible.
    const reversed = [named('b', 2, ['Glass']), named('a', 1, ['Body']), out('def', 0)];
    const got = ordinalsOf(reversed);
    expect(got.get('def')).toBe('_01');
    expect(got.get('a')).toBe('_02');
    expect(got.get('b')).toBe('_03');
  });

  it('pads to two digits and grows past 99', () => {
    const many = Array.from({ length: 100 }, (_, i) => out(`n${String(i).padStart(3, '0')}`, i));
    const got = ordinalsOf(many);
    expect(got.get('n000')).toBe('_01');
    expect(got.get('n008')).toBe('_09');
    expect(got.get('n098')).toBe('_99');
    expect(got.get('n099')).toBe('_100');
  });

  it('is DISPLAY ONLY — it never reaches node data', () => {
    const nodes = [out('def', 0), named('a', 1, ['Body'])];
    const before = nodes.map((n) => JSON.stringify(n.data));
    const got = ordinalsOf(nodes);
    expect(got.size).toBe(2);
    // The number describes a node's place in the CURRENT document, so baking it
    // in would make a saved file disagree with itself the moment an Output is
    // added or deleted. Nothing in `data` moves.
    expect(nodes.map((n) => JSON.stringify(n.data))).toEqual(before);
    for (const b of before) expect(b).not.toContain('_0');
  });
});

describe('source pins: the header and the mesh row', () => {
  const NODE = readFileSync(resolve(__dirname, 'OutputNode.tsx'), 'utf8');

  it('the header appends the ordinal, and nothing else does', () => {
    expect(NODE).toContain("{formatNodeLabel(def.label, 'output', language, false)}{plans.ordinals.get(id) ?? ''}");
  });

  it('the mesh row appears as soon as a MODEL is on screen', () => {
    // `hasMeshes` alone reads the SANDBOX inventory, which the GLB import has
    // just nulled and which only comes back seconds later from the rebuilt
    // preview — so the default Output showed no mesh control at all in between,
    // and never at all when the report is empty or the model is swapped away.
    expect(NODE).toContain('const showMeshRow = hasMeshes || !!shownMesh || targets.length > 0 || indexSection || parked;');
  });
});

/* ── the settings menu says what it is ────────────────────────────────────── */

describe('the Output settings menu is titled for what it edits', () => {
  const MENU = readFileSync(
    resolve(__dirname, '../menus/ShaderSettingsMenu.tsx'),
    'utf8',
  );

  it('is MATERIAL Settings — the menu is scoped to ONE Output, which is one material', () => {
    expect(MENU).toContain("{t('Material Settings', language)}");
    expect(MENU).not.toContain("{t('Shader Settings', language)}");
  });

  it('the three WHOLE-DOCUMENT figures say so under their own heading', () => {
    // Total Cost seeds every contributing Output, the budget is a device
    // setting, and the texture figure widened past one material deliberately —
    // filing them under "Material" would be a lie about three rows.
    expect(MENU).toContain("{t('Shader (whole document)', language)}");
    const at = MENU.indexOf("{t('Shader (whole document)', language)}");
    const block = MENU.slice(at, at + 1600);
    expect(block).toContain("t('Total Cost:', language)");
    expect(block).toContain("t('Budget:', language)");
    expect(block).toContain('textureMemoryLine(texBytes, texCount, language)');
  });

  it('the two MODULE-level geometry rows render only where they apply', () => {
    // `mergeVertices` is a module-level directive and `displacementMode` has no
    // loader key: `buildShaderModule` takes both from `moduleSettingsOutput`,
    // so anywhere else these checkboxes wrote a field nothing read.
    expect(MENU).toContain("{exposedSet.has('position') && ownsModuleSettings && (");
    expect(MENU).toContain('moduleSettingsOutput(s.nodes)?.id === outputNode.id');
  });

  it('does not stack a third "Material" heading under the new title', () => {
    expect(MENU).toContain("{t('Rendering', language)}");
    expect(MENU).not.toMatch(/context-menu__category">\{t\('Material', language\)\}/);
  });
});

describe('the Latvian side moved with it', () => {
  // The English literal IS the i18n key, so a rename that misses lv.json makes
  // Latvian silently fall back to English.
  const LV = JSON.parse(readFileSync(resolve(__dirname, '../../../i18n/lv.json'), 'utf8')) as {
    ui?: Record<string, string>;
  } & Record<string, unknown>;
  const ui = (LV.ui ?? LV) as Record<string, string>;

  it('carries every key the menu now asks for, and drops the old one', () => {
    expect(ui['Material Settings']).toBe('Materiāla iestatījumi');
    expect(ui['Shader (whole document)']).toBeTruthy();
    expect(ui['Rendering']).toBeTruthy();
    expect(ui['Shader Settings']).toBeUndefined();
  });
});

describe('the Shading row (Blender’s Shade Smooth / Shade Flat)', () => {
  const MENU = readFileSync(
    resolve(__dirname, '../menus/ShaderSettingsMenu.tsx'),
    'utf8',
  );

  it('names BOTH states, beside Side', () => {
    // A select and not a checkbox: "Flat Shading" unticked does not say
    // "smooth", and the user is looking for both Blender words.
    expect(MENU).toContain("{t('Shading', language)}");
    expect(MENU).toContain('<option value="smooth">{t(\'Smooth\', language)}</option>');
    expect(MENU).toContain('<option value="flat">{t(\'Flat\', language)}</option>');
  });

  it('stores only the FLAT case — smooth clears the key', () => {
    // Absent is three's default, which is what keeps every graph made before
    // this byte-identical; an explicit `false` would change every export.
    expect(MENU).toContain("updateSettings({ flatShading: e.target.value === 'flat' ? true : undefined })");
    expect(MENU).toContain("value={settings.flatShading ? 'flat' : 'smooth'}");
  });

  it('is in the Material Settings menu, not the whole-document block', () => {
    // It is a THREE.Material property, so two materials on one model may differ —
    // it belongs beside Transparent / Side, under "Rendering".
    const rendering = MENU.slice(MENU.indexOf("{t('Rendering', language)}"));
    expect(rendering).toContain("{t('Shading', language)}");
  });

  it('carries its Latvian', () => {
    const LV = JSON.parse(readFileSync(resolve(__dirname, '../../../i18n/lv.json'), 'utf8')) as Record<string, unknown>;
    const ui = ((LV as { ui?: Record<string, string> }).ui ?? LV) as Record<string, string>;
    for (const k of ['Shading', 'Smooth', 'Flat']) expect(ui[k]).toBeTruthy();
  });
});
