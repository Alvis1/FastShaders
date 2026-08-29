import complexityData from '@/registry/complexity.json';

/**
 * The GPU cost TABLE — the authored prices, the measured override layered over
 * them, and the sanitizer that decides what an override is allowed to say.
 *
 * ============================================================================
 * WHY THIS IS ITS OWN MODULE, AND WHY IT MUST STAY A LEAF
 * ============================================================================
 * This file imports NOTHING but the JSON. That is the whole point, and it is
 * load-bearing rather than tidiness.
 *
 * `useAppStore` calls `sanitizeCostMap` and `setCostOverrides` at MODULE SCOPE
 * (see its `loadCostProfiles()` / `setCostOverrides(...)` boot lines) so the
 * first CostBar and the first node badge already reflect the selected device.
 * Those two functions used to live in `nodeCost.ts`, which sits in a genuine
 * import cycle:
 *
 *     nodeCost -> outputMaterials -> exposedPorts -> edgeUtils -> useAppStore
 *                                                                     |
 *                     (module-scope setCostOverrides / sanitizeCostMap)|
 *                     <---------------------------------------------- +
 *
 * A cycle is harmless until something EVALUATES across it during module
 * initialisation, and those two calls were exactly that. Whichever module the
 * entry point happened to reach first got re-entered while its own body was
 * still running, and read a `const`/`let` that had not been initialised yet:
 *
 *   - entered via nodeCost      -> `Cannot access 'overrides' before initialization`
 *   - entered via exposedPorts  -> `Cannot access 'OUTPUT_DEFAULT_EXPOSED' ...`
 *   - entered via useAppStore   -> `Cannot access 'saveTimer' ...`,
 *                                  `Cannot read properties of undefined (reading 'setState')`
 *
 * MEASURED: on a clean tree that failed 5-11 of 152 vitest files, DIFFERENTLY
 * on every run — `vite.config.ts` sets `isolate: false`, so module instances are
 * shared across every suite in a worker and vitest's file-to-worker assignment
 * decides which module wins the race. `release.yml` runs `npm test` before it
 * builds binaries, so this could fail a release for no reason.
 *
 * A leaf module can never be caught mid-initialisation: it has no imports to
 * suspend on, so by the time anything can call into it, its body has run. That
 * is the entire fix — the cycle above still exists, but nothing evaluates
 * across it any more, which is what makes a cycle benign.
 *
 * So: keep this file free of imports. Anything needing `AppNode`, the registry,
 * or graph traversal belongs in `nodeCost.ts`, which is free to sit in the
 * cycle because nothing calls it during module initialisation.
 */

/**
 * The authored, build-time cost table — the source of truth shipped in the
 * bundle. `ACTIVE` is what every cost reader actually consults: it's `BASE`
 * until a measured-benchmark override is applied (drag a complexity patch onto
 * the cost bar → `setCostOverrides`), then it's `BASE` with the override keys
 * layered on top. Kept module-scope (a singleton) so all consumers — the CostBar
 * BFS, node badges, the asset-browser sort — see one table without prop-drilling.
 */
const BASE_COSTS = complexityData.costs as Record<string, number>;
let overrides: Record<string, number> = {};
let ACTIVE: Record<string, number> = BASE_COSTS;

/** Sane per-node cost ceiling. Real prices are ≤ ~1000; this only exists to
 *  stop an adversarial huge value from overflowing to Infinity downstream. */
export const MAX_NODE_COST = 1_000_000;

/** Keys the override is allowed to touch — only real node types already in the
 *  authored table. A dropped file is adversarial, so unknown keys are dropped
 *  rather than trusted, and values must be finite, non-negative, and clamped. */
export function sanitizeCostMap(map: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!map || typeof map !== 'object') return out;
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(BASE_COSTS, k)) continue;
    // Accept only real numbers or numeric strings — never null/boolean/object,
    // which Number() would silently coerce to 0 and inject a free cost.
    let n: number;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
    else continue;
    // Upper clamp: no single node price can plausibly exceed this. Without it a
    // crafted 1e308 cost overflows to Infinity once a chainable node multiplies
    // it (base × operands), corrupting the total and any exported complexity.json.
    if (Number.isFinite(n) && n >= 0) out[k] = Math.min(n, MAX_NODE_COST);
  }
  return out;
}

/**
 * Layer a measured override over the authored table (or clear it with an empty
 * map / null). Returns the sanitized override actually applied, so the caller
 * can persist exactly what took effect.
 */
export function setCostOverrides(map: Record<string, number> | null | undefined): Record<string, number> {
  overrides = sanitizeCostMap(map);
  ACTIVE = Object.keys(overrides).length ? { ...BASE_COSTS, ...overrides } : BASE_COSTS;
  return overrides;
}

/** Cost for one node type from the ACTIVE (override-aware) table. */
export function getCost(type: string | undefined): number {
  return type ? (ACTIVE[type] ?? 0) : 0;
}

/** The authored table with no override applied. */
export function getBaseCosts(): Record<string, number> { return BASE_COSTS; }
