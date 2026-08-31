import type { AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { HEX6 } from '@/utils/colorUtils';

/**
 * Writing tuned preview-uniform values back into the graph as the authored
 * defaults ("Set as default" in the Uniforms overlay).
 *
 * Pure and node-testable — the panel itself has no test coverage (the vitest
 * env is `node`, no jsdom), so the mapping that decides WHICH node gets WHICH
 * value lives here rather than inline in the .tsx.
 */

/** One row of the Uniforms overlay. Mirrors ShaderPreview's UniformInfo. */
export interface UniformRow {
  name: string;
  kind: 'float' | 'color';
}

/** Node ids → the `values` patch to merge into that node. */
export type UniformDefaultPlan = Map<string, Record<string, string | number>>;

/**
 * Float defaults are rounded before they are written: the overlay's slider
 * step is `span/200`, which produces values like 0.30500000000000005 that
 * would land verbatim in the generated TSL and in `export const schema`.
 *
 * toPrecision, not toFixed: significant digits scale with the magnitude, so a
 * legitimately tiny uniform (1e-7) survives instead of being flattened to 0 —
 * which a fixed 6-decimal round would do silently.
 */
export const FLOAT_PRECISION = 9;
/**
 * Exported because uniformOverride's "is this an override?" comparison MUST
 * round at exactly this precision — it decides whether to show a ↺ chip beside
 * a button (`planUniformDefaults`) that would then refuse to plan anything.
 * The two used to hold separate copies of the constant with a comment saying
 * they must agree; the import is what makes that true.
 */
export const roundFloat = (n: number) => Number(n.toPrecision(FLOAT_PRECISION));

/**
 * Decide what "make these the defaults" should change.
 *
 * @param nodes     current graph nodes
 * @param varNames  nodeId → generated variable name, as returned by
 *                  graphToCode. MUST come from a fresh run: the overlay's row
 *                  name IS the generated variable name, and recomputing it
 *                  from `values.name` would drop the `2`/`3` collision suffix
 *                  graphToCode appends, writing one tuned value into several
 *                  nodes.
 * @param uniforms  the rows the overlay is actually showing
 * @param values    tuned values by uniform name (absent = still at default)
 *
 * Rows with no tuned value, no backing property node, or a value whose type
 * doesn't match the row's kind are skipped, as are values already equal to
 * what the node holds — so an unchanged graph yields an empty plan and the
 * caller can avoid pushing a no-op undo entry.
 */
export function planUniformDefaults(
  nodes: AppNode[],
  varNames: ReadonlyMap<string, string>,
  uniforms: UniformRow[],
  values: Record<string, number | string>,
): UniformDefaultPlan {
  // varName → node, restricted to the two uniform-producing registry types.
  const byVar = new Map<string, AppNode>();
  for (const n of nodes) {
    const t = n.data.registryType;
    if (t !== 'property_float' && t !== 'property_color') continue;
    const v = varNames.get(n.id);
    if (v) byVar.set(v, n);
  }

  const plan: UniformDefaultPlan = new Map();
  for (const u of uniforms) {
    const value = values[u.name];
    if (value === undefined) continue;
    const node = byVar.get(u.name);
    if (!node) continue;

    const current = getNodeValues(node);
    if (u.kind === 'float' && node.data.registryType === 'property_float') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const next = roundFloat(value);
      // Round the stored side too: an untuned overlay is seeded with the
      // node's own full-precision double, so comparing it raw against the
      // rounded tuned value would plan a "change" (and cost an undo entry +
      // an iframe rebuild) for a click that changed nothing.
      if (roundFloat(Number(current.value)) === next) continue;
      plan.set(node.id, { value: next });
    } else if (u.kind === 'color' && node.data.registryType === 'property_color') {
      // 6-digit hex only: hexLiteral() in graphToCode silently degrades
      // anything else to 0x000000.
      if (typeof value !== 'string' || !HEX6.test(value)) continue;
      const next = value.toLowerCase();
      if (String(current.hex).toLowerCase() === next) continue;
      plan.set(node.id, { hex: next });
    }
  }
  return plan;
}

/** Apply a plan immutably. Returns the SAME array identity when empty. */
export function applyUniformDefaults(nodes: AppNode[], plan: UniformDefaultPlan): AppNode[] {
  if (plan.size === 0) return nodes;
  return nodes.map((n) => {
    const patch = plan.get(n.id);
    if (!patch) return n;
    return { ...n, data: { ...n.data, values: { ...getNodeValues(n), ...patch } } } as AppNode;
  });
}
