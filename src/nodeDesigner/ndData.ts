/**
 * Node Designer data layer — the LIVE registry, shaped for the designer app.
 *
 * The designer used to carry an inline `const NODES=[...]` snapshot plus its
 * own COSTS / colour tables, and `designerCoverage.test.ts` existed solely to
 * catch that copy drifting (stripes/dataviz were missing for their whole
 * lifetime; colormap rendered as a blank box). This module replaces the
 * snapshots with imports: the designer now covers exactly the ShaderNode-
 * rendered registry BY CONSTRUCTION — `getFlowNodeType(def) === 'shader'`,
 * the same rule ShaderNode routing and glyphCoverage.test.ts use.
 *
 * Pure data (no React, no CSS imports) so it stays node-env testable.
 */
import { getAllDefinitions, getFlowNodeType, growsOperands, NODE_REGISTRY } from '@/registry/nodeRegistry';
import complexityData from '@/registry/complexity.json';
import { CAT_HEX, getTypeColor, getCostColor, getCostScale, getContrastColor, COUNT_EDGE_COLORS } from '@/utils/colorUtils';
import { useAppStore } from '@/store/useAppStore';
import type { NodeCategory, NodeDefinition, TSLDataType } from '@/types';

/** The designer app's node model — port tuples, like the old snapshot, so the
 *  ported app logic (preview states, socket clamps, search) reads naturally. */
export interface NdNodeInfo {
  type: string;
  label: string;
  cat: string;
  in: [string, string][];
  out: [string, string][];
  def: Record<string, string | number> | null;
  /**
   * Does this node grow operand sockets? The designer's `layoutIsOp()` mirrors
   * ShaderNode's `usesOperatorLayout`, which is "glyph OR grows" — `append` is
   * glyphless and would otherwise be measured against a `.shader-node__region`
   * the replica no longer renders for it.
   */
  grows: boolean;
}

/** Every designable node = every ShaderNode-rendered definition. */
export function designerNodes(): NdNodeInfo[] {
  return getAllDefinitions()
    .filter((d) => getFlowNodeType(d) === 'shader')
    .map((d) => ({
      type: d.type,
      label: d.label,
      cat: d.category,
      in: d.inputs.map((p) => [p.id, p.dataType] as [string, string]),
      out: d.outputs.map((p) => [p.id, p.dataType] as [string, string]),
      def: d.defaultValues ?? null,
      grows: growsOperands(d),
    }));
}

export function definitionOf(type: string): NodeDefinition | undefined {
  return NODE_REGISTRY.get(type);
}

/** Live per-node GPU cost (complexity.json — the same file the app prices from). */
export const NODE_COSTS: Record<string, number> = complexityData.costs as Record<string, number>;

export function categoryHex(cat: string): string {
  return CAT_HEX[cat as NodeCategory] ?? CAT_HEX.unknown;
}

export function typeColor(dataType: string): string {
  return getTypeColor(dataType as TSLDataType);
}

/** Cost colours honour the USER'S preference: the designer page mounts the
 *  same store, which reads fs:costColorLow/High from the shared localStorage —
 *  so the header gradient here is the one their editor actually shows. */
export function costColorOf(cost: number): string {
  const s = useAppStore.getState();
  return getCostColor(cost, s.costColorLow, s.costColorHigh);
}

export const costScaleOf = getCostScale;
export const contrastColor = getContrastColor;

/** Nodes whose visualization is a real ART element (NodeVisual renders it;
 *  nodeArtStyle moves it). The movable-art contract REQUIRES these to stay
 *  glyph-less — dx/dy means CSS px here vs glyph-space units on glyph nodes —
 *  so the designer refuses to author an svg for them (and glyphCoverage.test.ts
 *  would fail if one were saved anyway). */
export const ART_NODE_TYPES = new Set<string>(['colormap']);

/** Default channel count per socket data type (preview-state seeding only). */
export const TYPE_CHANNELS: Record<string, number> = {
  float: 1, int: 1, any: 1, vec2: 2, vec3: 3, color: 3, vec4: 4,
};

/** Per-channel stub colours — the REAL table TypedEdge draws from. */
export { COUNT_EDGE_COLORS };
