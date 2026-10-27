/**
 * The Apply half of the connected-only code panel (engine/panelCode.ts): the
 * panel's text holds only the nodes that feed an Output, so a parse of it can
 * rebuild only those — and an Apply must not delete the rest. Every old node
 * outside the text's EMITTED set (the store's `codeEmitted`) is carried back
 * whole, with the wires into it.
 *
 * Precise for the same reason the orphan-property carry is: a node that was
 * never in the text cannot have been deleted from it. A node the user deletes
 * from the text WAS in it, so it is in the emitted set and stays deleted.
 *
 * The text's NAMES are its nodes' identities (the store's `codeNames`): a
 * carried wire's feeder is the parsed node declared under the name its old
 * feeder had in the text — as if the hidden node's line were still there —
 * never the old id, which type-only pairing may have handed to another node
 * (two Adds swap ids; a pasted shader's Float takes a hidden one's feeder's).
 *
 * Pure and node-tested; useSyncEngine's `doCodeSync` is the one caller.
 * See docs/dev/codegen.md § The code panel shows only the nodes that feed an Output.
 */
import type { AppEdge, AppNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { isSinkNode } from '@/utils/sdfPartition';
import { COLLAPSED_MEMBER_CLASS } from '@/utils/groupFrame';
import { generateEdgeId } from '@/utils/idGenerator';

/**
 * The old nodes an Apply carries: everything the panel's text did not emit,
 * except group frames (the resync's group block keeps those) and sinks (every
 * sink is emitted, and a parked one is `carryInactiveSinks`'). A null set — a
 * study session, a graph with no sink, a bare-script import — carries nothing,
 * which is today's Apply exactly.
 */
export function panelCarryIds(
  oldNodes: readonly AppNode[],
  emitted: ReadonlySet<string> | null,
): Set<string> {
  const ids = new Set<string>();
  if (!emitted) return ids;
  for (const n of oldNodes) {
    if (n.type === 'group' || isSinkNode(n) || emitted.has(n.id)) continue;
    ids.add(n.id);
  }
  return ids;
}

/** A carried node with no frame: under a relayout every position is absolute
 *  and the group block keeps no frame, so a parent link would dangle. */
function withoutFrame(n: AppNode): AppNode {
  const { parentId: _p, extent: _e, className, ...rest } = n as AppNode & { extent?: unknown };
  void _p; void _e;
  if (typeof className !== 'string') return rest as AppNode;
  const kept = className.split(/\s+/).filter((c) => c && c !== COLLAPSED_MEMBER_CLASS).join(' ');
  return (kept ? { ...rest, className: kept } : rest) as AppNode;
}

/**
 * Where a carried wire from a NON-carried feeder lands: the final id of the
 * parsed node declared under the name that feeder had in the text (`names`,
 * the store's `codeNames`), whatever its type — a feeder retyped in the panel
 * (`add` → `sub`) is still the line the hidden node read — or null when the
 * text declares no such name (it was deleted) or declares it twice. A retyped
 * feeder must still have the socket the wire left from. `parsed` carries the
 * FINAL ids (a paired node keeps its old one) and the parse's labels, which
 * are the declared names. Without names (none recorded), the old id itself
 * when the parse kept it — the id is the only identity left.
 */
export function panelFeederResolver(
  oldNodes: readonly AppNode[],
  parsed: readonly AppNode[],
  names: ReadonlyMap<string, string> | null,
): (oldSourceId: string, sourceHandle: string | null | undefined) => string | null {
  const parseIds = new Set(parsed.map((n) => n.id));
  if (!names) return (id) => (parseIds.has(id) ? id : null);
  const byName = new Map<string, AppNode | null>();
  for (const n of parsed) {
    const label = n.data.label;
    if (typeof label !== 'string' || label === '') continue;
    byName.set(label, byName.has(label) ? null : n);
  }
  const oldById = new Map(oldNodes.map((n) => [n.id, n] as const));
  return (oldId, sourceHandle) => {
    const name = names.get(oldId);
    if (name === undefined) return parseIds.has(oldId) ? oldId : null;
    const to = byName.get(name);
    if (!to) return null;
    const old = oldById.get(oldId);
    if (old && old.data.registryType !== to.data.registryType) {
      const handle = sourceHandle ?? 'out';
      if (!NODE_REGISTRY.get(to.data.registryType)?.outputs.some((o) => o.id === handle)) return null;
    }
    return to.id;
  };
}

/**
 * The carried nodes and the wires INTO them, from the UNWRAPPED old edges (a
 * collapsed group's boundary edges name its synthetic sockets). A wire from a
 * carried node is kept as it is; one from a node the text held is re-attached
 * to `feederOf`'s answer (panelFeederResolver — by NAME), or dropped when
 * there is none, leaving that socket unwired. One wire per socket.
 *
 * Nothing else can clash: a wire from a carried node INTO a parsed node cannot
 * exist (whatever feeds an emitted node is emitted), and a carried id is never
 * paired (`pairResyncNodes`' `carried`), so no parsed node holds one.
 */
export function carryPanelHidden(
  oldNodes: readonly AppNode[],
  realOldEdges: readonly AppEdge[],
  carriedIds: ReadonlySet<string>,
  feederOf: (oldSourceId: string, sourceHandle: string | null | undefined) => string | null,
  relayout: boolean,
): { nodes: AppNode[]; edges: AppEdge[] } {
  if (carriedIds.size === 0) return { nodes: [], edges: [] };
  const nodes = oldNodes.filter((n) => carriedIds.has(n.id)).map((n) => (relayout ? withoutFrame(n) : n));
  const seen = new Set<string>();
  const edges: AppEdge[] = [];
  for (const e of realOldEdges) {
    if (!carriedIds.has(e.target)) continue;
    const source = carriedIds.has(e.source) ? e.source : feederOf(e.source, e.sourceHandle);
    if (source === null) continue;
    const socket = `${e.target}\0${e.targetHandle ?? ''}`;
    if (seen.has(socket)) continue;
    seen.add(socket);
    const id = generateEdgeId(source, e.sourceHandle ?? 'out', e.target, e.targetHandle ?? 'in');
    if (relayout && e.className !== undefined) {
      const { className: _c, ...rest } = e;
      void _c;
      edges.push({ ...rest, source, id } as AppEdge);
    } else {
      edges.push({ ...e, source, id });
    }
  }
  return { nodes, edges };
}

/**
 * `nodes` back in the OLD array's order: every node the old graph held at its
 * old place, a new one right after the node it follows in `nodes`. The array
 * order is the namer's (topologicalSort queues roots in array order), so an
 * Apply that appended the carried nodes after the parsed ones renamed them
 * against each other on the next pass — two Perlins swapped `noise1`/`noise2`
 * and the panel text changed under an unchanged Apply.
 */
export function inOldOrder(nodes: readonly AppNode[], oldNodes: readonly AppNode[]): AppNode[] {
  const oldIndex = new Map(oldNodes.map((n, i) => [n.id, i] as const));
  let key = -1;
  let sub = 0;
  const keyed = nodes.map((n, i) => {
    const at = oldIndex.get(n.id);
    if (at !== undefined) {
      key = at;
      sub = 0;
      return { n, key: at, sub: 0, i };
    }
    sub += 1;
    return { n, key, sub, i };
  });
  keyed.sort((a, b) => a.key - b.key || a.sub - b.sub || a.i - b.i);
  return keyed.map((k) => k.n);
}
