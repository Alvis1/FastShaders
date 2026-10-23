import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getCost, getBaseCosts } from '@/utils/costTable';
import { readRgbCurves } from '@/utils/rgbCurves';

/**
 * The price of a node TYPE, and the LUT nodes' value-dependent price — the
 * readers that need no graph. Split out of nodeCost.ts, which re-exports
 * them and sits in the store's import cycle: the device-comparison page
 * (src/compare) prices every type under several devices side by side and
 * must not boot the store.
 */

/** RGB Curves' ALU beyond its six fetches, AUTHORED (not measured) at the table's own per-op prices: each of the
 *  two stages of engine/lutHelperText.ts's expression is `v + min(v,0)·s0 + max(v−1,0)·s1` — add ×2, mul ×2, min,
 *  sub, max, 7 one-point ops — and the final `mix(base, post, fac)` is mix's 2: 7 + 7 + 2. The six taps' inset
 *  mul/add (`fsLut.at`) is inside colormap's price, as it is for the Colormap node. */
const RGB_CURVES_ALU = 16;
/** The identity RGB Curves form bakes no texture and emits a bare `vec3(col)`. */
const RGB_CURVES_IDENTITY_COST = 1;

/** The table a price is read from: `getCost` (the ACTIVE, override-aware one), the shipped complexity.json, or —
 *  on the compare page — any device's table laid over it. */
export type CostOf = (type: string) => number;

function baseCost(type: string): number {
  return getBaseCosts()[type] ?? 0;
}

/**
 * A LUT node that BAKES — Color Ramp, a non-identity RGB Curves — IS `fetches`
 * fetches of one 257-texel table (`fsLut.at`, the Colormap node's fetch + inset)
 * plus its own arithmetic, so it is charged at colormap's price: a measured
 * profile, which prices `colormap` and never these, reprices all three LUT
 * nodes together. Under the shipped table that sum IS the type's complexity.json
 * entry (pinned). A profile that moves the node's OWN entry off the shipped
 * price is charged that entry instead — only a hand-authored one can (the bench
 * never measures these), and "New profile…" seeds every entry at its shipped
 * price, so an untouched entry still follows colormap.
 */
function lutBakeCost(type: 'colorRamp' | 'rgbCurves', fetches: number, alu: number, cost: CostOf): number {
  const own = cost(type);
  return own !== baseCost(type) ? own : fetches * cost('colormap') + alu;
}

/** THE price of a Color Ramp or RGB Curves node holding `values` — null for any other type. Color Ramp is one
 *  fetch (Color/Alpha are swizzles of it); RGB Curves six (C per channel, then R/G/B) + RGB_CURVES_ALU, or 1 in
 *  its identity form, which bakes nothing. */
export function lutNodeCost(type: string, values: unknown, cost: CostOf): number | null {
  if (type === 'colorRamp') return lutBakeCost('colorRamp', 1, 0, cost);
  if (type === 'rgbCurves') {
    return readRgbCurves(values).identity ? RGB_CURVES_IDENTITY_COST : lutBakeCost('rgbCurves', 6, RGB_CURVES_ALU, cost);
  }
  return null;
}

/**
 * THE price of a node TYPE: what a FRESH node of it — one holding its
 * definition's defaults — is charged under the SELECTED device's table, in
 * table points (a surface prints it through utils/budgetPoints.ts). It is the
 * number the palette tile, the Add-node menu row, the Designer card and the
 * node-editor overview print (and the palette strip sorts by), and the
 * `data.cost` every creation path stamps — a snapshot nothing restamps on an
 * edit and no card draws any more (every card prices itself live, and
 * layoutEngine reserves it at that live price) — so the number a node is
 * picked by is the number it shows once dropped, on whichever device is
 * selected. The table entry, except for a type priced by its values: a fresh
 * RGB Curves node holds no curves, so it is the identity form (1) — its table
 * entry is what a node that BAKES is charged. undefined for a type the table
 * does not price; callers keep their fallback.
 */
export function freshNodeCost(type: string): number | undefined {
  return freshNodeCostUnder(type, getCost);
}

/** `freshNodeCost` under any table — the compare page's one device per column. */
export function freshNodeCostUnder(type: string, cost: CostOf): number | undefined {
  if (getBaseCosts()[type] === undefined) return undefined;
  return lutNodeCost(type, NODE_REGISTRY.get(type)?.defaultValues, cost) ?? cost(type);
}
