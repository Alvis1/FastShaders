/**
 * THE cross-node Output plans, computed ONCE for the whole canvas.
 *
 * Every question in this family is about the node SET — who owns the module's
 * default, whose mesh claim wins, what each index material still shades, does
 * anything emit a part at all — so the ANSWER is the same for every card
 * asking. Computed per component instance it was O(N²): a 16-material GLB
 * import mints ~17 Output cards, each running the same six plans over the same
 * 17 nodes. MEASURED on a 256-mesh model, the coverage walk alone is ~31 µs, so
 * the set cost ≈0.8 ms per binding change and per mount — a dropped frame
 * inside every mesh tick, socket activation and Output add.
 *
 * It is a MODULE and not module scope inside `OutputNode.tsx` because the
 * vitest env is `node`: anything in the component can only ever be guarded by a
 * source pin, and a source pin is exactly what missed this — a per-instance
 * `useMemo(() => planNamedPartsAcross(contributing), [contributing])` reads
 * perfectly correct in isolation. Here the "computed once for N cards"
 * property is executable.
 *
 * THREE memo layers, each keyed on what the layer below cannot fold:
 *
 *  - `outputsWithKey` on the `nodes` ARRAY identity, then on each Output's
 *    `data` identity, producing a cheap STRING. That is what makes a drag frame
 *    free: NodeEditor replaces the nodes array every frame, but
 *    `applyNodeChanges` REUSES `data` for a node that only moved, so the key is
 *    rebuilt only when a binding really changed.
 *  - `outputPlansFor` on that KEY plus the `LoadedModel` identity. The key
 *    folds exactly what the plans read, so keying on it is not weaker than
 *    keying on the node array — it is the SAME gate every per-instance
 *    `useMemo` already sat behind, moved one level up so the instances share
 *    one result.
 *  - `indexClaimLabels` on the plans identity plus the language, because
 *    `language` must NOT enter the plans key: the plans are language-free by
 *    construction (they carry labels as DATA, the PreviewLink rule).
 *
 * `loaded` enters by IDENTITY and may: `loadedModelOf` returns one of three
 * frozen module constants or a WeakMap-cached object per facts object, so every
 * instance in one render pass holds the same reference and `===` is exact.
 *
 * STRICTMODE: pure, single-entry, no effects, no subscription. A double render
 * calls this twice with identical arguments and the second hits the memo; the
 * worst any interleaving can do is THRASH (recompute), never answer wrong,
 * because each memo is keyed on the whole of its input.
 *
 * STORE RESETS: every memo must stay a SINGLE entry. A Map keyed by document or
 * node id would grow without bound across `loadGraph`, across undo, and —
 * because `vite.config.ts` sets `isolate: false` — across every test file in a
 * worker. One entry retains one document's worth, exactly as the two memos it
 * absorbed and ShaderSettingsMenu's `textureMemoryMemo` already do, and a stale
 * entry can never be SERVED to a different document: a hit needs an equal
 * bindings key AND the same `loaded` object, and the plans are a pure function
 * of both.
 *
 * WHAT MAY NOT BE READ OFF `plans.contributing`: `values`, `exposedPorts` and
 * `materialSettings`. The plans hold the node objects of whichever array last
 * MOVED the key, so a colour scrub leaves them one generation behind — which is
 * deliberate (it is what stops a scrub re-rendering 17 siblings at pointer
 * rate) and is byte-for-byte the contract the per-instance `allOutputs` already
 * had. Every field the plans DO read is folded into the key.
 *
 * The returned object and everything in it is treated as IMMUTABLE: it is
 * shared by every card on the canvas, so one `Map.set` on a plan would rewrite
 * what emission's mirror-image derivation says about a different node.
 */
import {
  contributingOutputs,
  defaultOutput,
  emitRank,
  firstNamedOutputId,
  indexSectionCoverageAcross,
  moduleSignatureOf,
  outputDefaultContributes,
  outputMaterials,
  outputNodes,
  outputsInEmitOrder,
  planIndexPartsAcross,
  planNamedPartsAcross,
  readModelSignature,
  sectionLabel,
  type IndexCoverage,
  type IndexPartsPlanAcross,
  type LoadedModel,
  type NamedPartsPlanAcross,
} from '@/utils/outputMaterials';
import { hasActiveFlag } from '@/utils/sdfPartition';
import { formatSectionLabel } from './sectionLabelText';
import type { Language } from '@/i18n';
import type { AppNode, AppEdge } from '@/types';

/** Everything about the Output node SET that no single node can answer. */
export interface OutputPlans {
  /** Every Output node, array order. */
  outputs: readonly AppNode[];
  /** The set EMISSION walks, in emit order (`contributingOutputs`). */
  contributing: readonly AppNode[];
  /** Who owns the module's TOP-LEVEL channels. `null` is a real answer — a
   *  document whose every Output is targeted emits `parts` alone. */
  defaultId: string | null;
  /** Who may claim the loader-0.6 single-mesh-fallback exemption. */
  firstNamedId: string | null;
  named: NamedPartsPlanAcross;
  /** The signature governing the module's `materialParts` table. */
  moduleSignature: string[] | null;
  index: IndexPartsPlanAcross;
  coverage: ReadonlyMap<string, ReadonlyMap<number, IndexCoverage>>;
  /** node id -> the `_01` suffix its header wears, EMPTY on a document with a
   *  single Output. See `outputOrdinals`. */
  ordinals: ReadonlyMap<string, string>;
}

/**
 * The header suffix that tells several Output cards apart.
 *
 * One Output node is one MATERIAL, so a document built from a GLB is a column
 * of cards all headed "Output" — `OutputNode` renders the registry LABEL, not
 * the generated var name a ShaderNode shows, so there is nothing else on the
 * header to distinguish them. Numbered `_01`, `_02`, … and SILENT on a document
 * with one Output, which is every document that predates per-material shading.
 *
 * In EMIT ORDER, never array order: that is the module's own order (the one the
 * code panel's `parts` map is written in), and the nodes array is reordered by
 * an ordinary drag-into-a-group and by every Apply — so an array-order number
 * would renumber the whole column after a gesture that changed nothing visible.
 *
 * DISPLAY ONLY. It never reaches `data.label`, the generated code, the export
 * or anything persisted: the number describes a node's position in the current
 * document, and baking it in would make a saved file disagree with itself the
 * moment an Output is added or deleted. Two digits, matching `unfoldedId`'s
 * `#m01`, and it simply grows past 99.
 */
function outputOrdinals(outs: readonly AppNode[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const plain = outputsInEmitOrder(outs);
  if (plain.length < 2) return out;
  plain.forEach((n, i) => out.set(n.id, `_${String(i + 1).padStart(2, '0')}`));
  return out;
}

/* ── layer 1: the bindings key ────────────────────────────────────────────── */

let outputsMemo: { nodes: readonly AppNode[]; outs: AppNode[]; key: string } | null = null;

/** The key AND the Output list it was built from — one walk for both, so the
 *  plans below never re-filter the array the key already describes. */
function outputsWithKey(nodes: readonly AppNode[]): { outs: AppNode[]; key: string } {
  if (outputsMemo && outputsMemo.nodes === nodes) return outputsMemo;
  const outs = outputNodes(nodes as AppNode[]);
  const same = outputsMemo !== null
    && outputsMemo.outs.length === outs.length
    && outputsMemo.outs.every((p, i) => p.id === outs[i].id && p.data === outs[i].data);
  const key = same ? outputsMemo!.key : bindingsKeyOf(outs);
  outputsMemo = { nodes, outs, key };
  return outputsMemo;
}

/**
 * The SELECTOR form: a primitive, so zustand's `Object.is` bail still works and
 * a graph notify that moved no binding re-renders nothing.
 *
 * It folds exactly what the cross-node plans read: id, `emitRank` (the emitted
 * order), the active flag, the mesh names, the glTF material index and the
 * model signature. Stored values, exposed ports and material settings are
 * deliberately absent — no plan reads them, and including them would put a
 * colour scrub back on every sibling's render path.
 */
export function outputBindingsKey(nodes: readonly AppNode[]): string {
  return outputsWithKey(nodes).key;
}

function bindingsKeyOf(outs: readonly AppNode[]): string {
  let key = '';
  for (const n of outs) {
    const d = n.data as { meshTargets?: unknown; meshTarget?: { name?: unknown }; gltfMaterialIndex?: unknown };
    const names = Array.isArray(d.meshTargets)
      ? d.meshTargets.map(String).join('\u0002')
      : String(d.meshTarget?.name ?? '');
    // NUL between fields and \u0002 inside a list: a mesh name may legally
    // contain spaces and colons (`isUsableMeshName` refuses control chars), so
    // an ordinary separator could be spelled by the data it separates.
    key += `${n.id}\u0000${emitRank(n)}\u0000${hasActiveFlag(n) ? 1 : 0}\u0000${names}`
      + `\u0000${String(d.gltfMaterialIndex ?? '')}`
      + `\u0000${(readModelSignature(n.data) ?? []).join('\u0002')}\u0001`;
  }
  return key;
}

/* ── layer 2: the plans ───────────────────────────────────────────────────── */

let plansMemo: { key: string; loaded: LoadedModel; plans: OutputPlans } | null = null;

export function outputPlansFor(nodes: readonly AppNode[], loaded: LoadedModel): OutputPlans {
  const { outs, key } = outputsWithKey(nodes);
  if (plansMemo && plansMemo.key === key && plansMemo.loaded === loaded) return plansMemo.plans;
  const contributing = contributingOutputs(outs);
  const named = planNamedPartsAcross(contributing);
  const moduleSignature = moduleSignatureOf(contributing);
  const index = planIndexPartsAcross(contributing, moduleSignature);
  const plans: OutputPlans = {
    outputs: outs,
    contributing,
    defaultId: defaultOutput(outs)?.id ?? null,
    firstNamedId: firstNamedOutputId(outs),
    named,
    moduleSignature,
    index,
    coverage: indexSectionCoverageAcross(contributing, moduleSignature, loaded, named),
    ordinals: outputOrdinals(outs),
  };
  plansMemo = { key, loaded, plans };
  return plans;
}

/* ── layer 3: the worded double claim ─────────────────────────────────────── */

let hintsMemo: { plans: OutputPlans; language: Language; hints: ReadonlyMap<string, string> } | null = null;

/**
 * The double claim on the NAME side, WORDED: mesh → the label of the index
 * material that also covers it, for the mesh picker's row titles.
 *
 * `byId` rather than `contributing.find(…)`: the old form was an O(N) scan
 * inside an O(N) loop — a second quadratic hidden inside the first.
 */
export function indexClaimLabels(plans: OutputPlans, language: Language): ReadonlyMap<string, string> {
  if (hintsMemo && hintsMemo.plans === plans && hintsMemo.language === language) return hintsMemo.hints;
  const byId = new Map(plans.contributing.map((n) => [n.id, n]));
  const hints = new Map<string, string>();
  for (const [nodeId, byNode] of plans.coverage) {
    const node = byId.get(nodeId);
    if (!node) continue;
    const mats = outputMaterials(node);
    const sig = readModelSignature(node.data);
    for (const [i, c] of byNode) {
      if (c.state !== 'covered' && c.state !== 'overridden') continue;
      const lbl = formatSectionLabel(sectionLabel(mats, i, sig), language);
      for (const n of c.meshes) if (!hints.has(n)) hints.set(n, lbl);
    }
  }
  hintsMemo = { plans, language, hints };
  return hints;
}

/* ── the two per-notify selector helpers ──────────────────────────────────── */

/**
 * Does the MODULE's default material contribute a channel?
 *
 * Rule 2 of `dormantIndicesForPreview` (the loader-0.6 single-mesh fallback
 * mirror) asks it, and after the split the default is usually a SIBLING of the
 * node asking — so it cannot be read off the node's own wires. Memoized on the
 * raw store arrays so every Output instance shares one computation per notify.
 */
let defaultContributesMemo: { nodes: readonly AppNode[]; edges: readonly AppEdge[]; value: boolean } | null = null;
export function defaultContributesOf(nodes: readonly AppNode[], edges: readonly AppEdge[]): boolean {
  if (defaultContributesMemo && defaultContributesMemo.nodes === nodes && defaultContributesMemo.edges === edges) {
    return defaultContributesMemo.value;
  }
  const def = defaultOutput(nodes);
  const value = def ? outputDefaultContributes(def, edges) : false;
  defaultContributesMemo = { nodes, edges, value };
  return value;
}

/**
 * The loaded model's sub-mesh names, as ONE array shared by every card.
 *
 * It was mapped and joined INSIDE each instance's selector — so at 256 meshes
 * and 17 cards, 4 352 string allocations and 17 joins per store notify, i.e.
 * per drag frame, for a value that cannot differ between them. The inventory
 * object's identity changes only when the sandbox reports, so one entry keyed
 * on it serves the whole canvas.
 *
 * Returns the ARRAY as well as the key: the key is the cheap render signal, and
 * the array is what `dormantIndicesForPreview` and `defaultSectionUnusedAcross`
 * take — splitting the key back apart per instance would give each card its own
 * array identity again and re-run every memo keyed on it.
 *
 * NUL-joined, not space-joined: an OBJ mesh name may legally contain spaces
 * (they skip three's sanitizer), while `isUsableMeshName` refuses control
 * characters — so this separator cannot occur inside a name.
 */
let meshNamesMemo: { inventory: unknown; names: string[]; key: string } | null = null;
export function meshNamesOf(inventory: { meshes?: { name: string }[] } | null | undefined): {
  names: string[];
  key: string;
} {
  if (meshNamesMemo && meshNamesMemo.inventory === inventory) return meshNamesMemo;
  const names = (inventory?.meshes ?? []).map((m) => m.name);
  meshNamesMemo = { inventory, names, key: names.join('\u0000') };
  return meshNamesMemo;
}
