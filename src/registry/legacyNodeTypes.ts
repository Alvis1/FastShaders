import { getNodeValues } from '@/types';
import type { AppNode } from '@/types';

/** The React Flow `type` a migrated node must adopt — the union React Flow itself is keyed on. */
type FlowType = AppNode['type'];

/**
 * Registry types that were FOLDED into another node — a graph saved by an
 * earlier version may still carry them, and a saved group or a project block
 * too. Each maps onto the surviving node with the `values` that select the same
 * behaviour; port ids were kept so every edge survives untouched. Applied on
 * every restore path beside the other node migrations. The generated CODE of
 * such a file is covered separately: old helper CALLS parse back through
 * `HELPER_ALIASES`, and the live-audio nodes are one-way through codeToGraph
 * anyway.
 *
 * `flow` is set only where the fold also changes which COMPONENT draws the node
 * (`getFlowNodeType`). `node.type` is persisted, so without it a migrated node
 * would keep rendering through a component that no longer exists — React Flow
 * falls back to its own default node, a bare white box with top/bottom handles.
 * loadGraph carries a standing re-derivation for `soundNode` specifically, but
 * that one loop does not cover applyProjectToStore, loadSavedGroups or
 * instantiateSavedGroup, and this map does.
 */
export const LEGACY_NODE_TYPES: ReadonlyMap<
  string,
  { type: string; values?: Record<string, string | number>; flow?: FlowType }
> = new Map([
  ['sdBox2', { type: 'sdBox' }],
  ['sdBox3', { type: 'sdBox' }],
  ['smoothUnion', { type: 'sdCombine', values: { mode: 'union' } }],
  ['sdSubtract', { type: 'sdCombine', values: { mode: 'subtract' } }],
  // The Audio Input node was folded into the Sound node (2026-09-08): one
  // capture session, one analyser and one node, with the absorbed node's
  // source picker moved onto it. The two defs were identical in ports and
  // defaults, so every edge and every stored value survives the swap; only the
  // emitted uniform base changes (`aud1_*` -> `mic1_*`), which is invisible
  // because these nodes never parse back out of generated code.
  ['audioInput', { type: 'soundNode', flow: 'sound' }],
]);

/** Same array back when nothing needed migrating. */
export function migrateLegacyNodeTypes(nodes: AppNode[]): AppNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    const to = LEGACY_NODE_TYPES.get(n.data.registryType);
    if (!to) return n;
    changed = true;
    // Through the mandated accessor, never a raw `n.data as …` cast: this runs on
    // every restore path, so it is one of the first things to touch a graph that
    // came out of a `.fastshader` / `fs:graph` / `fs:savedGroups`, and
    // `getNodeValues` is where the "values may be a tampered primitive" rule
    // lives (see node.types.ts — `?? {}` guards nullish and nothing else). None
    // none of the folded types was ever an output/group/note node, so the
    // accessor's hard `{}` for those cannot bite here.
    const values = { ...getNodeValues(n), ...(to.values ?? {}) };
    const migrated = { ...n, data: { ...n.data, registryType: to.type, values } };
    if (to.flow) migrated.type = to.flow;
    return migrated as AppNode;
  });
  return changed ? out : nodes;
}
