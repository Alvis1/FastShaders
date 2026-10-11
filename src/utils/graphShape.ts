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
 * The characters a node id, an edge endpoint or a handle id may not hold.
 *
 * React Flow builds UNESCAPED attribute selectors from these strings:
 * `useUpdateNodeInternals` runs `.react-flow__node[data-id="${id}"]` on mount
 * (ShaderNode and eight other node components call it), and the connection
 * drag's `isValidHandle` interpolates the node and handle ids the same way.
 * Measured in Chrome (2026-10-11), inside a double-quoted CSS string:
 *  - `"`, CR, LF and FF THROW a SyntaxError. Thrown from a node's mount
 *    effect, with no error boundary, it unmounts the whole app — and the
 *    autosave has already written the id back, so every reload blanks again
 *    (reproduced through `fs:graph` and through a shared project opened with
 *    Open). A `"` is also how an id smuggles a selector LIST in.
 *  - `\` and NUL never throw but silently MISS, so React Flow never re-measures
 *    that node's handles; NUL misses even through `CSS.escape` (it becomes
 *    U+FFFD), so `nodeEl` cannot find it either.
 *  - U+2028/U+2029 are not CSS newlines and match like any other character.
 * No id or handle the app mints holds one: `generateId` (codeToGraph's ids
 * too), `<id>#m01`, `gi_output_m<n>`, registry and `colN` handles, `m<n>:`
 * namespaces and group sockets `__in_<memberId>_<handle>` (whose parts pass
 * this same rule).
 */
const SELECTOR_UNSAFE = /["\\\r\n\f\0]/;

/** A string React Flow can interpolate into its attribute selectors. */
export function isSelectorSafeId(id: string): boolean {
  return !SELECTOR_UNSAFE.test(id);
}

/**
 * A node's or an edge's flow `type`: absent (React Flow's `default`) or a
 * string that names no `Object.prototype` member.
 *
 * React Flow resolves it in OUR map and then in its OWN builtin map, a plain
 * object literal (`nodeTypes?.[t] || builtinNodeTypes[t]`, the same for
 * edges), so `constructor`, `valueOf`, `hasOwnProperty` or `__proto__`
 * resolves to a non-component: rendering it throws ("Objects are not valid as
 * a React child", "Cannot convert undefined or null to object", an invalid
 * element type), and with no error boundary and the autosave keeping the graph
 * the app stayed BLANK on every reload (measured in Chrome 2026-10-11, node and
 * edge alike). A non-string would be ToPropertyKey'd, which throws on
 * `{"toString":1}`. Any other unknown string falls back to React Flow's default
 * node or edge, as it always did. The app mints only its own names (`shader`,
 * `group`, `typed`, …), none of which is a prototype member.
 */
export function isUsableFlowType(t: unknown): boolean {
  return t === undefined || t === null || (typeof t === 'string' && !(t in Object.prototype));
}

/** Absent, a string or a number: a text field a component renders as a child,
 *  an attribute or inside a template literal — all three throw on an object
 *  (`{"toString":1}`), none on these. */
const isOptionalText = (v: unknown): boolean =>
  v === undefined || v === null || typeof v === 'string' || typeof v === 'number';
const isSafeIdString = (v: unknown): boolean => typeof v === 'string' && isSelectorSafeId(v);
/** Absent, or an array whose every entry passes `item`. */
const isListOf = (v: unknown, item: (x: unknown) => boolean): boolean =>
  v === undefined || v === null || (Array.isArray(v) && v.every(item));

/** One Data node column socket (`data.dynamicOutputs`, minted `{ id: 'colN', label, dataType: 'float' }`). */
const isUsableDataPort = (o: unknown): boolean =>
  isRecord(o) && isSafeIdString(o.id) && isOptionalText(o.label) && isOptionalText(o.dataType) && isOptionalText(o.hint);

/** One collapsed-group socket (`data.collapsedInputs` / `collapsedOutputs`, a BoundarySocket). */
const isUsableBoundarySocket = (s: unknown): boolean =>
  isRecord(s) &&
  isSafeIdString(s.socketId) &&
  isSafeIdString(s.originalNodeId) &&
  isSafeIdString(s.originalHandleId) &&
  isOptionalText(s.dataType) &&
  isOptionalText(s.name);

/**
 * The socket lists a node renders from its DATA rather than from the registry:
 * a Data node's `dynamicOutputs` (ShaderNode's rows, `portShapeForHandle` on
 * every wire's render) and a collapsed group's `collapsedInputs` /
 * `collapsedOutputs` (GroupNode, `unwrapCollapsedGroupEdges` in every engine
 * pass). Every reader iterates them unguarded, so a number, a string or a
 * `null` entry threw out of render and blanked the app for good, and their ids
 * become HANDLE ids React Flow interpolates unescaped (SELECTOR_UNSAFE). The
 * app mints these lists itself (`makeDataNodeData`, `toggleGroupCollapsed`),
 * so a malformed one only arrives in a file or a tampered `fs:*` value.
 */
function hasUsableDataSockets(data: Record<string, unknown>): boolean {
  return (
    // Not a socket list, but the same class: React Flow's own fallback node
    // (any type it does not know, isUsableFlowType) renders `data.label` as a
    // child, and toggleGroupCollapsed copies a member's label into a socket
    // `name` GroupNode renders — an object there blanked the app (Chrome,
    // 2026-10-11). The app mints only string labels.
    isOptionalText(data.label) &&
    isListOf(data.dynamicOutputs, isUsableDataPort) &&
    isListOf(data.collapsedInputs, isUsableBoundarySocket) &&
    isListOf(data.collapsedOutputs, isUsableBoundarySocket)
  );
}

/**
 * The minimum a node needs to survive being handed to React Flow and to the
 * value sanitizers. `data` must be a record because every sanitizer reads
 * `n.data.registryType`, and `id` must be a string because it keys the node
 * lookup, the edge endpoints and `CSS.escape` selectors — and selector-safe,
 * because React Flow's own selectors do not escape it (see SELECTOR_UNSAFE).
 * The flow `type` must resolve to a component (isUsableFlowType), and the
 * socket lists carried in `data`, and its `label`, must be renderable
 * (hasUsableDataSockets). Each of those was a whole-app crash, not a wrong
 * picture, and none is repairable without guessing what was meant, so the
 * node is dropped (a loss `loadGraph` reports in its console warning).
 */
export function hasUsableNodeShape(n: unknown): boolean {
  return (
    isRecord(n) &&
    typeof n.id === 'string' &&
    n.id.length > 0 &&
    isSelectorSafeId(n.id) &&
    isUsableFlowType(n.type) &&
    isRecord(n.data) &&
    hasUsableDataSockets(n.data)
  );
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
 *
 * Endpoints and string HANDLE ids must also be selector-safe (SELECTOR_UNSAFE):
 * an endpoint that is not names a node the node gate already dropped, and a
 * handle that is not names no socket the node gate lets render (registry
 * ports, and the data-borne lists hasUsableDataSockets checks) — and a
 * collapsed group's socket `__in_<memberId>_<handle>` is minted FROM the edge's
 * handle, which would put the `"` into React Flow's connection-drag selector.
 * A missing or null handle (the `out`/`in` default) passes as before. The
 * edge's flow `type` must resolve to a component (isUsableFlowType).
 */
export function isUsableEdge(e: unknown): boolean {
  return (
    isRecord(e) &&
    typeof e.source === 'string' &&
    typeof e.target === 'string' &&
    isSelectorSafeId(e.source) &&
    isSelectorSafeId(e.target) &&
    isUsableFlowType(e.type) &&
    (typeof e.sourceHandle !== 'string' || isSelectorSafeId(e.sourceHandle)) &&
    (typeof e.targetHandle !== 'string' || isSelectorSafeId(e.targetHandle))
  );
}

export interface GraphShapeResult<N, E> {
  nodes: N[];
  edges: E[];
  /** Nodes removed because id/type/data were unusable — nothing could repair them. */
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
