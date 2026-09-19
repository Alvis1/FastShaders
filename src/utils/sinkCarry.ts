import type { AppEdge, AppNode } from '@/types';
import { isSinkNode, isUntargetedOutput, isMarchOutput } from '@/utils/sdfPartition';

/**
 * The code→graph resync's carry of PARKED OUTPUT NODES: a node that emits
 * nothing is absent from the code BY CONSTRUCTION — never deleted by the user,
 * since it was never in the text — and the parse cannot rebuild it. The same
 * argument as the orphaned-property carry in useSyncEngine, plus one step that
 * carry never needs: the node's incoming edges come back with it.
 *
 * WHICH nodes that covers is the whole correctness of this function since the
 * Output split, and it takes two rules rather than one.
 *
 * A TARGETED plain Output is normally NOT carried. It CONTRIBUTES
 * (`contributingOutputs`: every targeted Output emits its own `parts` /
 * `materialParts` entry whatever the active flag says), so the parse re-creates
 * its material and its wiring from the code — carrying it too would add the
 * node BESIDE the parse's copy, and a GLB-imported document would gain one
 * Output per mesh on every Apply while emitting each part twice (first claim
 * wins, the rest shadowed). Its content is not lost: it comes back as a
 * material on the parsed node, and the next restore splits that back into
 * nodes.
 *
 * `parseHasPlainOutput` is the second rule, and it exists because that premise
 * — the module holds an entry to rebuild the node from — is false in one
 * state: a DRIVING Raymarch Output. `graphToCode` gates the whole Output
 * pass on it (`outputs = marchNode ? [] : contributingOutputs(nodes)`), so a
 * marching module carries no `parts`, no `materialParts` and no top-level
 * channels at all. Nothing pairs, and every targeted Output plus its incoming
 * edges was DELETED on Apply — silently, and only PARTIALLY, since the
 * untargeted default came back through this very carry, so the graph went on
 * working with some materials simply gone.
 *
 * The gate is what the PARSE holds and never what the old graph looks like. A
 * module with no plain Output has nothing a carried node could collide with, by
 * construction, which is what keeps the widening from re-opening the
 * duplication above; asking the old graph whether a march drives instead would
 * also resurrect a material the user had just deleted from the code panel by
 * hand, on every Apply.
 *
 * A section that emitted NOTHING (its name shadowed by an earlier claim, or
 * past `MAX_PART_ENTRIES`) is dropped with it — the same loss a shadowed
 * MATERIAL has always taken on an Apply, for the same reason: there is no entry
 * in the code to carry it back.
 *
 * NOT a complete answer to the march case, and the limit is the CALLER's:
 * useSyncEngine runs this inside `if (unpositioned.length === 0)`, so an Apply
 * that also adds a node reaches none of it and every parked Output goes, as it
 * always did. Two ordinary things land there — typing one new `const` into the
 * code panel, and a feeder SHARED between the march and an Output, which
 * `marchPartition` emits into both the per-step Fn and the flat body so the
 * parse returns it twice and one copy is unpaired. That gate also drops group
 * frames, waypoints and orphan properties, so it is a broad known limitation
 * (CLAUDE.md documents it) rather than anything march-specific — but the rule
 * above holds for the Apply that adds nothing, not for every Apply.
 *
 * Pure so apply∘apply stability is an executable test rather than a source
 * pin. `survivingIds` are the ids in the resync's final node list — a matched
 * feeder keeps its OLD id, so a carried edge can name it verbatim; an edge
 * whose source did not survive (deleted from the code) is dropped, mirroring
 * the group block's dangling-parentId rule. `realOldEdges` must be the
 * UNWRAPPED old edges (a feeder inside a collapsed group).
 */
export function carryInactiveSinks(
  oldNodes: readonly AppNode[],
  realOldEdges: readonly AppEdge[],
  activeOldId: string | null,
  survivingIds: ReadonlySet<string>,
  parseHasPlainOutput: boolean,
): { nodes: AppNode[]; edges: AppEdge[] } {
  const nodes = oldNodes.filter(
    (n) => isSinkNode(n)
      && (isMarchOutput(n) || isUntargetedOutput(n) || !parseHasPlainOutput)
      && n.id !== activeOldId
      && !survivingIds.has(n.id),
  );
  if (nodes.length === 0) return { nodes: [], edges: [] };
  const ids = new Set(nodes.map((n) => n.id));
  const edges = realOldEdges.filter((e) => ids.has(e.target) && survivingIds.has(e.source));
  return { nodes, edges };
}
