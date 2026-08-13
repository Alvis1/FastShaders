/**
 * Node Designer ↔ React bridge.
 *
 * The designer's STAGE renders the app's own NodeVisual — the same static
 * replica the asset cards and the node-editor overview use — so the node being
 * edited is drawn by the code that draws it everywhere else. The designer app
 * (designerApp.ts, ported from the old inline script) keeps owning the chrome,
 * gestures and save paths; this module is the narrow seam between the two:
 *
 *   · renderNodePreview() — mount/re-render the live preview with the DRAFT
 *     design + per-socket preview states; onRendered fires after every commit
 *     so the app can re-measure overlays (edge stubs, resize handle, ruler).
 *   · builtinGlyphSvg() — the REAL built-in art serialized to an SVG string
 *     (renderToStaticMarkup over NodeGlyph's renderArt), replacing the
 *     hand-copied art table that used to drift.
 *   · label helpers — the app's own i18n, replacing the public/node-i18n.json
 *     fetch (and the vite sync plugin that existed only to feed it).
 */
import { useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodeVisual, type PortPreviewState } from '@/components/NodeEditor/nodes/NodeVisual';
import { renderArt, hasBuiltinGlyph, type GlyphDesign } from '@/components/NodeEditor/nodes/glyphs/NodeGlyph';
import { CUSTOM_GLYPHS } from '@/components/NodeEditor/nodes/glyphs/customGlyphs';
import { formatNodeLabel, formatCategoryLabel, type Language } from '@/i18n';
import { getCostColor, getCostScale, getContrastColor } from '@/utils/colorUtils';
import { useAppStore } from '@/store/useAppStore';
import { definitionOf, NODE_COSTS, categoryHex } from './ndData';

export type { PortPreviewState, GlyphDesign };
// One import surface for designerApp.ts: the data layer rides along.
export * from './ndData';

/** The saved designs, as the running app sees them. Used as the designer's
 *  baseline when neither the dev endpoint nor a linked folder can provide the
 *  on-disk file text (e.g. the deployed copy) — the old page showed registry
 *  DEFAULTS in that case, silently hiding every saved design. */
export function savedDesignsBaseline(): Record<string, GlyphDesign> {
  return JSON.parse(JSON.stringify(CUSTOM_GLYPHS)) as Record<string, GlyphDesign>;
}

/** Built-in art for a node type as an inner-SVG string ('' when none). */
export function builtinGlyphSvg(type: string): string {
  if (!hasBuiltinGlyph(type)) return '';
  const art = renderArt(type, 0);
  return art == null ? '' : renderToStaticMarkup(<>{art}</>);
}

export function baseLabel(type: string, lang: Language): string {
  const en = definitionOf(type)?.label ?? type;
  return formatNodeLabel(en, type, lang, false);
}

/** Bilingual display label — "Latviešu (English)" in LV mode. The header the
 *  designer sizes glyph widths against, so it must be the real rendered one. */
export function displayLabel(type: string, lang: Language): string {
  const en = definitionOf(type)?.label ?? type;
  return formatNodeLabel(en, type, lang, true);
}

/** Latvian name (EN fallback) — feeds the search corpus in either mode. */
export function lvName(type: string): string {
  const en = definitionOf(type)?.label ?? type;
  return formatNodeLabel(en, type, 'lv', false);
}

/**
 * RAW Latvian name — '' when the node is untranslated, where `lvName` would hand
 * back the English one. The Name (LV) field has to tell those apart: a fallback
 * would show "Multiply" in the Latvian box and saving it would write English into
 * node-i18n.json as if someone had translated it.
 */
export { nodeLabelLV } from '@/i18n';

export function catLabel(cat: string, lang: Language): string {
  return formatCategoryLabel(cat, cat, lang, true);
}

export interface NdPreviewInput {
  type: string;
  /** The COMPLETE draft design (svg/justify/scale/dx/dy/width/height/text/sockets). */
  design: GlyphDesign;
  /** Per-input preview states ('un' | 'live' | 'inf' + channels + value text). */
  ins: Record<string, PortPreviewState>;
  headerText: string;
  /** Display values for unconnected inputs / settings rows (session-only). */
  values: Record<string, string | number>;
  snapCol: 'l' | 'r' | null;
  onValueChange: (key: string, value: number | string) => void;
  /** Fires after every React commit — re-measure overlays and stubs here. */
  onRendered: () => void;
}

function NdPreview(p: NdPreviewInput) {
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  // Layout effect, not a passive one: the vanilla overlays (corner grip, snap
  // ruler, edge stubs) are positioned from this callback, and a passive effect
  // runs AFTER paint — during a corner-resize drag the grip would visibly
  // trail the card by a frame.
  useLayoutEffect(() => {
    p.onRendered();
  });
  const def = definitionOf(p.type);
  if (!def) return null;
  const cost = NODE_COSTS[def.type] ?? 0;
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  return (
    <NodeVisual
      def={def}
      design={p.design}
      interactive
      exactWidth
      headerText={p.headerText}
      portStates={p.ins}
      values={p.values}
      onValueChange={p.onValueChange}
      snapCol={p.snapCol}
      catColor={categoryHex(def.category)}
      cost={cost}
      costColor={costColor}
      // Overridden by the stage's `--node-cost-text` var rule (the same
      // mechanism the React Flow canvas uses), so the badge auto-contrasts
      // against the pickable stage background.
      costTextColor="#000000"
      costScale={getCostScale(cost)}
      headerTextColor={getContrastColor(costColor)}
    />
  );
}

let root: Root | null = null;
let rootContainer: HTMLElement | null = null;

/** Mount (once) and render the stage preview. Call again on ANY change of the
 *  draft/state — React reconciles; onRendered fires after the commit. */
export function renderNodePreview(container: HTMLElement, props: NdPreviewInput): void {
  if (!root || rootContainer !== container) {
    root = createRoot(container);
    rootContainer = container;
  }
  root.render(<NdPreview {...props} />);
}
