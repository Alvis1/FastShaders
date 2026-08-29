/**
 * Element-shape gate for the untrusted graph restore paths.
 *
 * Three surfaces reconstruct a graph from bytes the app did not write:
 * `loadGraph` (the `fs:graph` autosave), `applyProjectToStore` /
 * `extractProjectState` (an imported `.js` / `.zip`), and `loadSavedGroups`
 * (`fs:savedGroups`). All three are the same trust level — localStorage is
 * writable by anything at this origin and a `.fastshader` is explicitly
 * adversarial input — and all three hand their result straight to React Flow.
 *
 * The failure this closes is not a wrong picture, it is DATA LOSS. React Flow's
 * `@xyflow/system` dereferences `node.position.x` unguarded while committing,
 * and there is no error boundary above the canvas, so one element shaped
 * `{ id: 'a', data: {} }` throws out of render and blanks the page — and the
 * store's 300 ms autosave, armed by zustand's SYNCHRONOUS notify before React
 * ever renders, then writes that same graph back to `fs:graph`. Every
 * subsequent boot blanks again, with no in-app way back. The sanitizers
 * downstream (`sanitizeImageNodes`, `sanitizeDataNodes`, …) have the mirror
 * problem: they deref `n.data.registryType`, so a null element throws inside
 * `loadGraph`'s outer catch, which returns null — and the demo graph plus that
 * same autosave overwrite the user's real work.
 *
 * The policy is deliberately asymmetric, matching what each caller can afford:
 *   - `loadGraph` / `loadSavedGroups` REPAIR. This is the user's own work; the
 *     only thing worse than a node at the wrong coordinates is no graph at all.
 *   - `extractProjectState` REJECTS the whole block and lets the caller fall
 *     back to importing the file as a plain shader script. That is the
 *     behaviour its existing gate already documents, and a foreign file has no
 *     claim on being repaired.
 *
 * LEAF MODULE: this imports nothing, not even types. `useAppStore` calls it at
 * module scope, and `src/utils/costTable.ts` documents at length what happens
 * when a module reachable during store initialisation sits in an import cycle
 * (a TDZ ReferenceError that surfaced as 5-11 of 152 vitest files failing
 * differently every run). Keep it a leaf.
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The minimum a node needs to survive being handed to React Flow and to the
 * value sanitizers. `data` must be a record because every sanitizer reads
 * `n.data.registryType`, and `id` must be a string because it keys the node
 * lookup, the edge endpoints and `CSS.escape` selectors.
 */
export function hasUsableNodeShape(n: unknown): boolean {
  return isRecord(n) && typeof n.id === 'string' && n.id.length > 0 && isRecord(n.data);
}

/** A React-Flow-renderable position: a record with two FINITE numbers. */
export function hasUsablePosition(n: unknown): boolean {
  if (!isRecord(n)) return false;
  const p = n.position;
  return isRecord(p) && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Both halves — what `extractProjectState`'s reject-the-block gate asks. */
export function isRenderableNode(n: unknown): boolean {
  return hasUsableNodeShape(n) && hasUsablePosition(n);
}

/**
 * Deliberately does NOT require `id`. Every path in the app mints one through
 * `generateEdgeId`, so an id-less edge is only reachable from a hand-edited
 * file — and silently dropping a real wire is worse than whatever React Flow
 * does with a missing key. Endpoints are what this gate exists to guarantee.
 */
export function isUsableEdge(e: unknown): boolean {
  return isRecord(e) && typeof e.source === 'string' && typeof e.target === 'string';
}

export interface GraphShapeResult<N, E> {
  nodes: N[];
  edges: E[];
  /** Nodes removed because id/data were unusable — nothing could repair them. */
  droppedNodes: number;
  /** Nodes kept but given a finite position. */
  repairedPositions: number;
  /** Edges removed: malformed, or pointing at a dropped node. */
  droppedEdges: number;
}

/**
 * Repair-in-place-ish shape pass for the two paths that own the user's data.
 * Returns the SAME arrays when nothing needed changing — the autosave
 * subscriber and `selectionOnlyGraphChange` compare by reference, so a fresh
 * array on every boot would arm a full-graph JSON.stringify for no reason.
 */
export interface GraphShapeOptions {
  /**
   * Drop edges whose endpoints name no surviving node. Correct for a WHOLE
   * graph (`loadGraph`), wrong for a SAVED GROUP: a group records its boundary
   * wiring, so an edge whose source is a node OUTSIDE the group is the normal
   * case and `instantiateSavedGroup` re-resolves it against the graph the group
   * lands in. Defaults to false — the conservative answer for a data-loss gate.
   */
  pruneDanglingEdges?: boolean;
}

export function sanitizeGraphShape<N, E>(
  rawNodes: unknown[],
  rawEdges: unknown[],
  options: GraphShapeOptions = {},
): GraphShapeResult<N, E> {
  let droppedNodes = 0;
  let repairedPositions = 0;
  let droppedEdges = 0;

  const keptIds = new Set<string>();
  const nodes: unknown[] = [];
  for (const n of rawNodes) {
    if (!hasUsableNodeShape(n)) {
      droppedNodes++;
      continue;
    }
    keptIds.add((n as Record<string, unknown>).id as string);
    if (hasUsablePosition(n)) {
      nodes.push(n);
      continue;
    }
    // Keep the node and its wiring; a coordinate is recoverable by dragging,
    // a deleted node is not. Origin rather than a spread guess: several
    // repaired nodes overlapping is legible as damage, scattered ones are not.
    repairedPositions++;
    nodes.push({ ...(n as Record<string, unknown>), position: { x: 0, y: 0 } });
  }

  const edges: unknown[] = [];
  for (const e of rawEdges) {
    if (!isUsableEdge(e)) {
      droppedEdges++;
      continue;
    }
    if (options.pruneDanglingEdges) {
      const r = e as Record<string, unknown>;
      if (!keptIds.has(r.source as string) || !keptIds.has(r.target as string)) {
        droppedEdges++;
        continue;
      }
    }
    edges.push(e);
  }

  return {
    nodes: (droppedNodes === 0 && repairedPositions === 0 ? rawNodes : nodes) as N[],
    edges: (droppedEdges === 0 ? rawEdges : edges) as E[],
    droppedNodes,
    repairedPositions,
    droppedEdges,
  };
}
