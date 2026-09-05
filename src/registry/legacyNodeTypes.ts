import type { AppNode } from '@/types';

/**
 * Registry types that were FOLDED into a node with a mode or a width dispatch
 * (2026-09-03) — a graph saved by v0.3.29 may still carry them, and a saved
 * group or a project block from that version too. Each maps onto the folded
 * node with the `values` that select the same behaviour; port ids were kept
 * so every edge survives untouched. Applied on every restore path beside the
 * other node migrations. The generated CODE of such a file is covered
 * separately: its old helper CALLS parse back through `HELPER_ALIASES`.
 */
export const LEGACY_NODE_TYPES: ReadonlyMap<string, { type: string; values?: Record<string, string | number> }> = new Map([
  ['sdBox2', { type: 'sdBox' }],
  ['sdBox3', { type: 'sdBox' }],
  ['smoothUnion', { type: 'sdCombine', values: { mode: 'union' } }],
  ['sdSubtract', { type: 'sdCombine', values: { mode: 'subtract' } }],
]);

/** Same array back when nothing needed migrating. */
export function migrateLegacyNodeTypes(nodes: AppNode[]): AppNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    const to = LEGACY_NODE_TYPES.get(n.data.registryType);
    if (!to) return n;
    changed = true;
    const values = { ...((n.data as { values?: Record<string, string | number> }).values ?? {}), ...(to.values ?? {}) };
    return { ...n, data: { ...n.data, registryType: to.type, values } } as AppNode;
  });
  return changed ? out : nodes;
}
