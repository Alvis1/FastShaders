/**
 * The code→graph resync's PAIRING half — which old node each freshly parsed one
 * keeps the identity of — and the two rules the Output split forced on it.
 *
 * Pure so the failure below is an executable attack rather than a source pin:
 * `useSyncEngine` is a React hook and the vitest env is `node`, so everything
 * this file used to hold could only ever be grepped for.
 */
import type { AppNode } from '@/types';
import { PART_SETTING_KEYS } from '@/engine/materialSettingsCode';
import { isMarchOutput, isSinkNode, isUntargetedOutput } from './sdfPartition';
import { absoluteNodePosition } from './groupFrame';
import {
  UNFOLD_DY,
  gltfIndexOf,
  isOutputNode,
  materialTargetNames,
  outputMaterials,
  outputsInEmitOrder,
} from './outputMaterials';

/**
 * THE key a parsed node pairs on.
 *
 * For everything but an Output it is `registryType + label`, which is what it
 * has always been. **For an Output it is the node's BINDING**, and that is the
 * whole correctness of this file since one Output node became one material.
 *
 * Every parsed Output is labelled the literal string `"Output"` (`createNode`
 * in codeToGraph), so `registryType + label` puts every one of them in ONE
 * bucket and they pair by ARRAY ORDER — which means an Apply on a multi-mesh
 * document silently moves one material's id, position, exposedPorts, stored
 * values and settings ONTO ANOTHER MESH, with `errors: []` and byte-identical
 * emitted output. Nothing downstream notices: the module is the same text, the
 * preview renders the same picture, and the only evidence is that the node the
 * user had been editing is now shading something else. The label carries no
 * information for this type at all, so the binding replaces it rather than
 * joining it.
 *
 * A Raymarch Output keeps the label form: it has no binding, and the parse
 * mints at most one of them.
 *
 * The named form sorts its meshes, so a material naming the same set in a
 * different order is the same material — the parse rebuilds `meshTargets` in
 * `parts` key order, which is emission order, which the user can change by
 * re-ordering the code panel's text without meaning to re-bind anything.
 */
export function matchKey(n: AppNode): string {
  if (!isOutputNode(n)) return `${n.data.registryType}\0${n.data.label}`;
  const index = gltfIndexOf(outputMaterials(n)[0]);
  if (index !== null) return `output\0i${index}`;
  const names = materialTargetNames(outputMaterials(n)[0]);
  return names.length === 0 ? 'output\0default' : `output\0n${[...names].sort().join('\u0001')}`;
}

/**
 * May this OLD node be paired at all?
 *
 * Every CONTRIBUTING Output is a candidate, because the parse mints one node
 * per contributing material (`contributingOutputs`): the untargeted default,
 * and every TARGETED Output whatever the active flag says.
 *
 * `contributingOutputs` is march-BLIND — graphToCode gates it separately
 * (`outputs = marchNode ? [] : contributingOutputs(nodes)`) — so under a
 * DRIVING Raymarch Output such a node stays pairable while contributing
 * nothing to the module. Harmless, and deliberately not special-cased here:
 * the parse mints no plain Output to pair it with, pass 2 keys on
 * `registryType` and `'output'` never matches `'raymarchOutput'`, so it falls
 * through to `carryInactiveSinks`, which is exactly where that state belongs.
 *
 * A PARKED sink is not — an inactive Raymarch Output, or an untargeted Output
 * that is not the active one. It emits nothing, so it is absent from the code
 * BY CONSTRUCTION and `carryInactiveSinks` brings it back whole; leaving it in
 * the buckets would let it absorb the wiring of the node the parse really did
 * produce while the real one came back as a stranger.
 */
function pairable(old: AppNode, activeOldId: string | null): boolean {
  if (!isSinkNode(old)) return true;
  if (old.id === activeOldId) return true;
  return isOutputNode(old) && !isUntargetedOutput(old);
}

export interface ResyncPairing {
  /** Paired nodes in the resync's own order: every EXACT (pass-1) match in
   *  parse order, then every type-only (pass-2) one. */
  readonly paired: readonly { readonly node: AppNode; readonly match: AppNode }[];
  /** Parsed nodes with no partner at all, in parse order. */
  readonly unpaired: readonly AppNode[];
}

/**
 * The two passes, unchanged in shape: exact key first, then registryType alone.
 *
 * Pass 2 is what lets a RE-BOUND Output keep its identity — rename a mesh in
 * the code panel and the parsed node finds the old one by type and inherits its
 * position and ports, which is the desirable outcome. It is also why the binding
 * tier has to be pass 1 rather than an extra tier below it: with the binding in
 * pass 1 the unchanged materials pair exactly and only the genuinely ambiguous
 * ones fall through, where array order is the honest answer.
 */
export function pairResyncNodes(
  oldNodes: readonly AppNode[],
  newNodes: readonly AppNode[],
  activeOldId: string | null,
): ResyncPairing {
  const byExactKey = new Map<string, AppNode[]>();
  const byType = new Map<string, AppNode[]>();
  for (const old of oldNodes) {
    if (!pairable(old, activeOldId)) continue;
    const key = matchKey(old);
    (byExactKey.get(key) ?? byExactKey.set(key, []).get(key)!).push(old);
    const type = old.data.registryType;
    (byType.get(type) ?? byType.set(type, []).get(type)!).push(old);
  }
  const used = new Set<string>();
  const paired: { node: AppNode; match: AppNode }[] = [];
  const takeFrom = (candidates: AppNode[] | undefined): AppNode | undefined =>
    candidates?.find((old) => !used.has(old.id));

  for (const node of newNodes) {
    const match = takeFrom(byExactKey.get(matchKey(node)));
    if (match) {
      used.add(match.id);
      paired.push({ node, match });
    }
  }
  const done = new Set(paired.map((p) => p.node.id));
  const unpaired: AppNode[] = [];
  for (const node of newNodes) {
    if (done.has(node.id)) continue;
    const match = takeFrom(byType.get(node.data.registryType));
    if (match) {
      used.add(match.id);
      paired.push({ node, match });
    } else {
      unpaired.push(node);
    }
  }
  return { paired, unpaired };
}

/**
 * Give an unpaired plain OUTPUT a position, instead of letting it trigger the
 * whole-graph relayout.
 *
 * `useSyncEngine` re-lays out EVERY node the moment any parsed node has no
 * partner, and the orphan-property carry, the parked-sink carry and the ENTIRE
 * group-preservation block sit behind the same `unpositioned.length === 0`
 * gate — so one unpaired node DELETES EVERY GROUP FRAME on the canvas. That was
 * tolerable while a new node meant one Multiply typed into the code panel; with
 * one Output per material the ordinary GLB-import path mints a dozen at once,
 * and a single retyped mesh name would take the user's frames with it.
 *
 * It is scoped to PLAIN Outputs on purpose. They are the one node type the
 * parse mints as a SET whose size follows the module's material count, and the
 * one type with a natural anchor — its own siblings, which are the same kind of
 * node doing the same job. A Multiply has neither, so it keeps today's path.
 *
 * WHERE, exactly, is the canvas's question and not this function's (the same
 * answer `unfoldOutputMaterials` gives): the newcomers go BELOW the lowest
 * positioned Output, `UNFOLD_DY` apart — the unfold's own pitch, one definition
 * — in emit order, so the column keeps its shape and two runs of one module
 * place them identically. With no positioned Output to anchor to there is
 * nothing on the canvas to be near, so they are handed back for the relayout,
 * which is also exactly what happens today for a graph that had no Output.
 *
 * Returns the placed nodes and the ones still to lay out; `placed` is empty
 * whenever nothing applies, so the caller's arrays are untouched.
 */
export function placeParsedOutputs(
  positioned: readonly AppNode[],
  unpaired: readonly AppNode[],
  oldNodes: readonly AppNode[],
): { placed: AppNode[]; rest: AppNode[] } {
  const newOutputs = unpaired.filter((n) => isOutputNode(n) && !isMarchOutput(n));
  if (newOutputs.length === 0) return { placed: [], rest: [...unpaired] };
  const anchors = positioned.filter(isOutputNode);
  if (anchors.length === 0) return { placed: [], rest: [...unpaired] };

  // The OLD graph is the ONLY place an anchor's FRAME still is. `mergeMatch`
  // spreads the PARSED node and copies `id` and `position` — so `positioned`
  // carries PARENT-RELATIVE coordinates with NO parentId on them, and
  // useSyncEngine's group block restores parentId LATER and only for ids the
  // old graph had.
  const byId = new Map(oldNodes.map((n) => [n.id, n]));

  // ABSOLUTE, because "the lowest Output" is a question about the CANVAS. Read
  // off `position` directly it compared a grouped Output's parent-relative y
  // against a root one's absolute y — two different coordinate spaces — and so
  // picked whichever frame happened to sit nearest the origin.
  let anchor = absoluteNodePosition(anchors[0], byId);
  for (const a of anchors) {
    const p = absoluteNodePosition(a, byId);
    if (p.y > anchor.y) anchor = p;
  }

  const placedIds = new Set(newOutputs.map((n) => n.id));
  // ROOT-LEVEL and ABSOLUTE, deliberately. A parsed node has no parentId and it
  // does not inherit the anchor's:
  //  - `unpositioned.length > 0` sends it through `autoLayout`, which knows
  //    nothing about parentId and writes ABSOLUTE positions, while the group
  //    block that would re-add the frame is gated OFF on that same condition —
  //    so the parentId would name a group no longer in the list;
  //  - that block restores parentId only for ids present in the OLD graph, and
  //    a freshly parsed id never is, so a parented placement would be the one
  //    exception to the single rule it states;
  //  - a COLLAPSED anchor group hides its members with a className this node
  //    would not carry, drawing a new material on top of the pill;
  //  - and nothing grows a frame around nodes added to it programmatically
  //    outside `unfoldOutputMaterials`, so the column would hang out of it.
  // The user drags it in if they want it in, and React Flow's own
  // drop-into-group does the adoption with the frame maths that goes with it.
  const placed = outputsInEmitOrder(newOutputs).map((n, i) => ({
    ...n,
    position: { x: anchor.x, y: anchor.y + (i + 1) * UNFOLD_DY },
  }) as AppNode);
  return { placed, rest: unpaired.filter((n) => !placedIds.has(n.id)) };
}

/**
 * The resync's `materialSettings` carry, PER KEY.
 *
 * It was a whole-object overwrite from the old node, which is right for exactly
 * one of the six keys' worth of reasons and wrong for the rest once each
 * material is its own node:
 *
 *  - the four the loader applies per part (`PART_SETTING_KEYS`) ARE in the code
 *    for a TARGETED node — `graphToCode` writes them inside its `parts` entry —
 *    so they are CODE-AUTHORITATIVE there: unticking Transparent in the code
 *    panel and pressing Apply must not have the old node put it back;
 *  - for the UNTARGETED default they are not in the editor code at all (they
 *    ride `buildShaderModule`'s options), so the parse can never have seen
 *    them and they must be carried, exactly as they always were;
 *  - `displacementMode` and `mergeVertices` are never in the editor code for
 *    ANY node (one has no loader key, the other is a module-level geometry
 *    directive), so they are always carried — which is the known loss this
 *    closes for an added material.
 *
 * ALWAYS a fresh object, never a mutation of either side: ShaderPreview,
 * CodeEditor and this hook all subscribe to `materialSettings` BY REFERENCE and
 * bail on `Object.is`, so an in-place update leaves the preview and the A-Frame
 * tab showing the old settings with no error (the rule
 * `materialSettingsFromSource` states). Absent on both sides stays absent, so a
 * node that never had settings gains no key.
 */
export function carryMaterialSettings(merged: AppNode, match: AppNode): void {
  if (!isOutputNode(merged)) return;
  // Both sides are read as ADVERSARIAL: the old node's settings come from a
  // `.fastshader` or the autosave, and `Object.entries('abc')` would otherwise
  // spray index keys into a MaterialSettings. Same shape `cleanSettings`
  // (utils/outputMaterials.ts) applies on every restore path.
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const parsed = obj((merged.data as Record<string, unknown>).materialSettings);
  const old = obj((match.data as Record<string, unknown>).materialSettings);
  if (!old) return;
  // A targeted node's part body is where the four emitted keys live, so only a
  // node that is UNTARGETED after the parse inherits them.
  const inheritsEmitted = isUntargetedOutput(merged);
  const next: Record<string, unknown> = { ...(parsed ?? {}) };
  let changed = false;
  for (const [k, v] of Object.entries(old)) {
    if (PART_SETTING_KEYS.has(k) && !inheritsEmitted) continue;
    if (next[k] !== undefined) continue;
    next[k] = v;
    changed = true;
  }
  if (!changed) return;
  (merged.data as Record<string, unknown>).materialSettings = next;
}
