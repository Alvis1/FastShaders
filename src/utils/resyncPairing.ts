/**
 * The code→graph resync's PAIRING half: which old node each freshly parsed one
 * keeps the identity of. Pure, so its rules are executable tests.
 * See docs/dev/outputs-and-materials.md § Per-mesh materials, rule (3).
 */
import type { AppNode } from '@/types';
import { PART_SETTING_KEYS } from '@/engine/materialSettingsCode';
import { isCustomSink, isSinkNode, isUntargetedOutput } from './sdfPartition';
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
 * THE key a parsed node pairs on: `registryType + label`, except for an Output,
 * which pairs on its BINDING. Every parsed Output is labelled `"Output"`, so a
 * label key pairs them by array order and an Apply moves one material's
 * identity onto another mesh, with `errors: []` and byte-identical output.
 * The named form SORTS its meshes: the same set in another order is the same
 * material. A custom sink keeps the label form (it has no binding).
 */
export function matchKey(n: AppNode): string {
  if (!isOutputNode(n)) return `${n.data.registryType}\0${n.data.label}`;
  const index = gltfIndexOf(outputMaterials(n)[0]);
  if (index !== null) return `output\0i${index}`;
  const names = materialTargetNames(outputMaterials(n)[0]);
  return names.length === 0 ? 'output\0default' : `output\0n${[...names].sort().join('\u0001')}`;
}

/**
 * May this OLD node be paired at all? Every CONTRIBUTING Output may (the
 * untargeted default and every targeted one). A PARKED sink may not: it is
 * absent from the code, `carryInactiveSinks` brings it back whole, and in the
 * buckets it would absorb the wiring of the node the parse really produced.
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
 * Two passes: exact key first, then registryType alone. Pass 2 is what lets a
 * RE-BOUND Output (a mesh renamed in the code panel) keep its position and
 * ports; the binding is pass 1 so only the ambiguous ones fall through.
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
 * Give an unpaired plain OUTPUT a position instead of handing it to the
 * whole-graph relayout, which deletes every group frame on the canvas. The
 * newcomers go BELOW the lowest positioned Output, `UNFOLD_DY` apart, in emit
 * order, at ROOT level and in ABSOLUTE coordinates. With no positioned Output
 * to anchor to, `placed` is empty and the relayout takes them.
 * See docs/dev/outputs-and-materials.md § Per-mesh materials, rule (3).
 */
export function placeParsedOutputs(
  positioned: readonly AppNode[],
  unpaired: readonly AppNode[],
  oldNodes: readonly AppNode[],
): { placed: AppNode[]; rest: AppNode[] } {
  const newOutputs = unpaired.filter((n) => isOutputNode(n) && !isCustomSink(n));
  if (newOutputs.length === 0) return { placed: [], rest: [...unpaired] };
  const anchors = positioned.filter(isOutputNode);
  if (anchors.length === 0) return { placed: [], rest: [...unpaired] };

  // `positioned` holds PARENT-RELATIVE coordinates with no parentId (mergeMatch
  // copies id and position alone); only the OLD graph still knows the frame.
  const byId = new Map(oldNodes.map((n) => [n.id, n]));
  let anchor = absoluteNodePosition(anchors[0], byId);
  for (const a of anchors) {
    const p = absoluteNodePosition(a, byId);
    if (p.y > anchor.y) anchor = p;
  }

  const placedIds = new Set(newOutputs.map((n) => n.id));
  // Never parented to the anchor's frame: the user drags it in if they want it in.
  const placed = outputsInEmitOrder(newOutputs).map((n, i) => ({
    ...n,
    position: { x: anchor.x, y: anchor.y + (i + 1) * UNFOLD_DY },
  }) as AppNode);
  return { placed, rest: unpaired.filter((n) => !placedIds.has(n.id)) };
}

/**
 * The resync's `materialSettings` carry, PER KEY. The four `PART_SETTING_KEYS`
 * are CODE-AUTHORITATIVE on a targeted node (they are in its `parts` entry) and
 * inherited on an untargeted one; `displacementMode` and `mergeVertices` are
 * always carried. Always a FRESH object: subscribers compare by reference.
 * See docs/dev/outputs-and-materials.md § Per-mesh materials.
 */
export function carryMaterialSettings(merged: AppNode, match: AppNode): void {
  if (!isOutputNode(merged)) return;
  // Both sides are ADVERSARIAL (a `.fastshader`, the autosave): objects only.
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const parsed = obj((merged.data as Record<string, unknown>).materialSettings);
  const old = obj((match.data as Record<string, unknown>).materialSettings);
  if (!old) return;
  // Only a node UNTARGETED after the parse inherits the four emitted keys.
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
