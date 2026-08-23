import { memo, type CSSProperties, type ReactNode } from 'react';
import { CUSTOM_GLYPHS } from './customGlyphs';
import { growsOperands } from '@/registry/nodeRegistry';
import type { NodeDefinition } from '@/types';

/**
 * One node's designer overrides — the value type of CUSTOM_GLYPHS, named so a
 * DRAFT design (the Node Designer's unsaved working state) can flow through the
 * same helpers the app uses for the saved table. Every helper below takes an
 * optional `design`; when present it REPLACES the saved entry outright (the
 * designer's draft is always a complete design, not a patch).
 */
export type GlyphDesign = (typeof CUSTOM_GLYPHS)[string];

/**
 * Light-theme node glyphs ported from the v14 design mockup
 * (`node-icon-variants-v14-master.html`). Each glyph is a presentational
 * 56×56 SVG illustration of what the node *does* — the operator symbol, the
 * function curve, the geometric construction, the input frame.
 *
 * These are decorative: real sockets + inline value editors still live in the
 * ShaderNode port rows below the glyph. Live-preview nodes (time, sin/cos,
 * noise) keep their own canvases and are intentionally NOT covered here.
 *
 * Colors are tuned for the app's light node body (dark-on-light), unlike the
 * mockup which drew on a dark tile.
 */

const AX = '#B4B7C0';        // plot axis
const PLOT = '#F57C00';      // primary curve / accent (orange)
const FILL = '#FF9800';      // area fill under curves (used at low opacity)
const INK = '#2B2B2B';       // strong dark strokes / glyph text
const CONSTRUCT = '#8A8F9C'; // construction / reference lines
const BLUE = '#2D6CDF';      // secondary operand vector
const GREEN = '#2E9E5B';     // cross-product result vector
const INT = '#1796A0';       // int knob accent (teal)

/** Filled-area math plots: `fill` = area path, `line` = curve. */
const MATH_PLOTS: Record<string, { fill?: string; line: string; poly?: boolean }> = {
  abs: { fill: 'M-20 -12 L0 0 L20 -12 L20 0 L-20 0 Z', line: '-20,-12 0,0 20,-12', poly: true },
  sqrt: { fill: 'M-20 0 Q-10 -10 0 -11 Q10 -12 20 -12 L20 0 Z', line: 'M-20 0 Q-10 -10 0 -11 Q10 -12 20 -12' },
  exp: { fill: 'M-20 12 Q0 10 12 0 Q18 -8 20 -13 L20 0 L-20 0 Z', line: 'M-20 12 Q0 10 12 0 Q18 -8 20 -13' },
  log2: { fill: 'M-20 13 Q-15 0 -5 -8 Q5 -12 20 -13 L20 0 L-20 0 Z', line: 'M-20 13 Q-15 0 -5 -8 Q5 -12 20 -13' },
  oneMinus: { fill: 'M-20 -12 L20 12 L20 0 L-20 0 Z', line: 'M-20 -12 L20 12' },
  clamp: { fill: 'M-20 10 L-10 10 L10 -10 L20 -10 L20 0 L-20 0 Z', line: '-20,10 -10,10 10,-10 20,-10', poly: true },
  min: { fill: 'M-20 10 L-10 10 L16 -16 L16 0 L-20 0 Z', line: '-20,10 -10,10 16,-16', poly: true },
  max: { fill: 'M-16 16 L10 -10 L20 -10 L20 0 L-16 0 Z', line: '-16,16 10,-10 20,-10', poly: true },
};

/** Centered operator/text glyphs (binary ops where the symbol carries meaning). */
const OPERATORS: Record<string, { text: string; serif?: boolean; size?: number }> = {
  add: { text: '+' },
  sub: { text: '−' },
  mul: { text: '×' },
  div: { text: '÷' },
  greaterThan: { text: '>' },
  lessThan: { text: '<' },
  equal: { text: '=' },
  mod: { text: '%' },
  pow: { text: 'xʸ', serif: true, size: 13 },
};

/** Registry types that have a glyph. Live-preview types are excluded on purpose. */
const NODE_GLYPH_TYPES = new Set<string>([
  ...Object.keys(MATH_PLOTS),
  ...Object.keys(OPERATORS),
  'floor', 'round', 'fract',
  'dot', 'cross', 'length', 'distance', 'normalize',
  'positionWorld', 'positionLocal', 'uv', 'cameraNear', 'cameraFar',
]);

/** True when the app ships BUILT-IN art for this type (ignores saved custom
 *  svg). The Node Designer's "Built-in" restore uses this to know whether
 *  there is anything to restore. */
export function hasBuiltinGlyph(type: string): boolean {
  return NODE_GLYPH_TYPES.has(type);
}

export function hasNodeGlyph(type: string, design?: GlyphDesign): boolean {
  // A draft design decides by its own svg alone: the designer previews exactly
  // what the draft holds (a cleared draft shows an empty node), while the app
  // falls back to built-in art.
  if (design) return !!design.svg;
  return NODE_GLYPH_TYPES.has(type) || !!CUSTOM_GLYPHS[type]?.svg;
}

/**
 * Does this node render through the OPERATOR layout (glyph between two sockets,
 * flipping to the vertical list at 3+ operands) rather than the rows layout?
 *
 * The gate used to be `hasNodeGlyph(type) && def.inputs.length === 2` at all
 * four call sites, which quietly made "has art" the test for "grows sockets".
 * That is wrong for exactly one node and it was the node that needed it most:
 * `append` is DELIBERATELY glyphless (glyphCoverage.test.ts's exempt list — its
 * socket set is its whole meaning), so it fell into the rows layout, and the
 * rows layout is the only branch that never calls `effectiveInputs`. Result: a
 * node the registry, the splice, the compaction, the evaluator and codegen had
 * all been taught to grow showed two sockets forever, with no UI path to a
 * third — while `revealGrowth`, `opSocketCount` and `chainListMode` were
 * computed for it and read by nothing it could reach.
 *
 * So the test is now "glyph OR grows": art decides how the node is DRAWN, the
 * registry decides how it BEHAVES. `growsOperands` covers add/sub/mul/div
 * (already glyphed, so unchanged) plus `append`.
 *
 * Keep all four gates on this one predicate — ShaderNode, NodeVisual (the
 * one-node-one-look replica), layoutEngine's footprint estimate, and the Node
 * Designer's `layoutIsOp` (which mirrors it over its own draft state).
 */
export function usesOperatorLayout(
  def: NodeDefinition | undefined,
  design?: GlyphDesign,
): boolean {
  if (!def || def.inputs.length !== 2) return false;
  return hasNodeGlyph(def.type, design) || growsOperands(def);
}

/** Input-value alignment for a node (designer override; default 'center'). */
export function nodeJustify(type: string, design?: GlyphDesign): 'left' | 'center' | 'right' {
  const j = (design ?? CUSTOM_GLYPHS[type])?.justify;
  return j === 'left' || j === 'right' ? j : 'center';
}

/** Per-node glyph scale (designer override; default 1). Scales the glyph art
 *  ONLY — socket/value spacing is fixed; the operator-layout body grows just
 *  enough to contain a larger glyph. */
export function nodeScale(type: string, design?: GlyphDesign): number {
  const s = (design ?? CUSTOM_GLYPHS[type])?.scale;
  return typeof s === 'number' && s > 0 ? s : 1;
}

/** Per-node box override: EXACT node width in px (≥24; default auto/fit).
 *  Exact — not a minimum — so nodes can be made narrower than their natural
 *  content width (the header wraps and auto-grows; the operator body's
 *  54px floor applies only in auto mode). The node frame style (corner
 *  radius, border thickness) is fixed app-wide; border color stays the
 *  category color. */
export function nodeBox(type: string, design?: GlyphDesign): { width?: number; height?: number } {
  const d = design ?? CUSTOM_GLYPHS[type];
  const w = typeof d?.width === 'number' && d.width > 0 ? Math.max(24, d.width) : undefined;
  // Body height (px, ≥28): EXACT in both layouts — shorter than content
  // shrinks the node and the content simply overflows (dx/dy places art).
  // Independent of glyph scale — resizing the node never scales the glyph
  // (and vice versa). Default auto: op = max(52, glyphPx + 10), rows = flow.
  const h = typeof d?.height === 'number' && d.height > 0 ? Math.max(28, d.height) : undefined;
  return { width: w, height: h };
}

/** Per-node text scale (designer override; default 1, clamped 0.4–2.5).
 *  Multiplies the node's text sizes — header title, value boxes, edge value
 *  labels — via the `--node-text-scale` CSS variable. Purely typographic:
 *  layout metrics (header height, socket math) stay fixed, so oversized
 *  header text may clip. */
export function nodeTextScale(type: string, design?: GlyphDesign): number {
  const t = (design ?? CUSTOM_GLYPHS[type])?.text;
  return typeof t === 'number' && t > 0 ? Math.max(0.4, Math.min(2.5, t)) : 1;
}

/** Per-socket vertical offsets for the operator layout (designer override).
 *  Px relative to the body center; keys are input port ids plus 'out'.
 *  Missing keys fall back to the defaults (a −12.5, b +12.5, out 0). */
export function nodeSockets(type: string, design?: GlyphDesign): Record<string, number> {
  const s = (design ?? CUSTOM_GLYPHS[type])?.sockets;
  return s && typeof s === 'object' ? s : {};
}

/**
 * Per-node ART transform, for nodes whose visualization is a real DOM element
 * rather than an SVG glyph — today the Colormap node's ramp strip. The SAME
 * stored design fields the glyph uses (`dx`/`dy` nudge + `scale`) drive it, so
 * the designer's existing Nudge/Scale controls and drag-to-nudge gesture apply
 * unchanged. Purely visual, per the glyph-nudge convention: a CSS transform
 * moves/grows the art while its layout slot — and therefore every socket and
 * row — stays put (overflow stays visible, exactly like an over-tall glyph).
 *
 * Units: CSS px, NOT glyph-space units — the element lives in page space, not
 * the `0 0 56 56` canvas. The two meanings can't collide on one node: art
 * nodes have no glyph (glyphCoverage.test.ts pins colormap's exemption), so
 * dx/dy always mean exactly one thing per node.
 */
export function nodeArtStyle(type: string, design?: GlyphDesign): CSSProperties | undefined {
  const d = design ?? CUSTOM_GLYPHS[type];
  const dx = typeof d?.dx === 'number' ? d.dx : 0;
  const dy = typeof d?.dy === 'number' ? d.dy : 0;
  const s = typeof d?.scale === 'number' && d.scale > 0 ? d.scale : 1;
  if (dx === 0 && dy === 0 && s === 1) return undefined;
  return { transform: `translate(${dx}px, ${dy}px) scale(${s})` };
}

/** Renaissance one-point-perspective ground plane (place inside translate(28 28)). */
function PerspectiveGround() {
  return (
    <g stroke={CONSTRUCT} strokeWidth={0.6} fill="none">
      <line x1={-22} y1={-18} x2={22} y2={-18} strokeWidth={0.8} />
      <circle cx={0} cy={-18} r={1.2} fill={CONSTRUCT} stroke="none" />
      <line x1={-22} y1={20} x2={0} y2={-18} />
      <line x1={-11} y1={20} x2={0} y2={-18} />
      <line x1={0} y1={20} x2={0} y2={-18} />
      <line x1={11} y1={20} x2={0} y2={-18} />
      <line x1={22} y1={20} x2={0} y2={-18} />
      <line x1={-22} y1={20} x2={22} y2={20} />
      <line x1={-17} y1={10} x2={17} y2={10} />
      <line x1={-13} y1={2} x2={13} y2={2} />
      <line x1={-10} y1={-4} x2={10} y2={-4} />
    </g>
  );
}

function MathPlot({ spec }: { spec: { fill?: string; line: string; poly?: boolean } }) {
  return (
    <g transform="translate(28 28)">
      <line x1={-20} y1={0} x2={20} y2={0} stroke={AX} strokeWidth={0.6} />
      {spec.fill && <path d={spec.fill} fill={FILL} fillOpacity={0.16} stroke="none" />}
      {spec.poly ? (
        <polyline points={spec.line} fill="none" stroke={PLOT} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d={spec.line} fill="none" stroke={PLOT} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </g>
  );
}

function Knob({ value, accent, ticks }: { value: number; accent: string; ticks?: boolean }) {
  const txt = ticks ? String(Math.round(value)) : (Number.isFinite(value) ? value.toFixed(2) : '0.00');
  return (
    <g transform="translate(28 28)">
      <circle r={16} fill="#F1F1F1" stroke="#D5D5D5" />
      <path d="M-11 9 A 14 14 0 1 1 11 9" stroke="#B4B7C0" strokeWidth={1.6} fill="none" strokeLinecap="round" />
      {ticks && (
        <g stroke="#C2C2C2" strokeWidth={0.8}>
          <line x1={0} y1={-15} x2={0} y2={-13} />
          <line x1={13} y1={-7} x2={11} y2={-6} />
          <line x1={15} y1={0} x2={13} y2={0} />
          <line x1={13} y1={7} x2={11} y2={6} />
          <line x1={-13} y1={7} x2={-11} y2={6} />
          <line x1={-15} y1={0} x2={-13} y2={0} />
          <line x1={-13} y1={-7} x2={-11} y2={-6} />
        </g>
      )}
      <path d="M-11 9 A 14 14 0 1 1 9 -11" stroke={accent} strokeWidth={1.6} fill="none" strokeLinecap="round" />
      <text y={3} textAnchor="middle" fill={INK} style={{ font: '600 8.5px "JetBrains Mono", monospace' }}>{txt}</text>
    </g>
  );
}

/** Built-in art for a node type, or null. Exported so the Node Designer can
 *  serialize the REAL art (via renderToStaticMarkup) instead of keeping the
 *  hand-copied string table that used to drift from this file. */
export function renderArt(type: string, value: number): ReactNode {
  if (MATH_PLOTS[type]) return <MathPlot spec={MATH_PLOTS[type]} />;

  if (OPERATORS[type]) {
    const op = OPERATORS[type];
    return (
      <text
        x={28}
        y={op.serif ? 34 : 35}
        textAnchor="middle"
        fill={INK}
        style={{ font: `${op.serif ? 'italic ' : ''}700 ${op.size ?? 17}px ${op.serif ? 'Georgia, serif' : '"Inter", sans-serif'}` }}
      >
        {op.text}
      </text>
    );
  }

  switch (type) {
    case 'floor':
      return (
        <g transform="translate(28 28)" stroke={PLOT} strokeWidth={1.4} strokeLinecap="round">
          <line x1={-20} y1={0} x2={20} y2={0} stroke={AX} strokeWidth={0.6} />
          <line x1={-20} y1={10} x2={-10} y2={10} />
          <line x1={-10} y1={3} x2={0} y2={3} />
          <line x1={0} y1={-4} x2={10} y2={-4} />
          <line x1={10} y1={-11} x2={20} y2={-11} />
        </g>
      );
    case 'round':
      return (
        <g transform="translate(28 28)" stroke={PLOT} strokeWidth={1.4} strokeLinecap="round">
          <line x1={-20} y1={0} x2={20} y2={0} stroke={AX} strokeWidth={0.6} />
          <line x1={-20} y1={10} x2={-15} y2={10} />
          <line x1={-15} y1={3} x2={-5} y2={3} />
          <line x1={-5} y1={-4} x2={5} y2={-4} />
          <line x1={5} y1={-11} x2={15} y2={-11} />
          <line x1={15} y1={-15} x2={20} y2={-15} />
        </g>
      );
    case 'fract':
      return (
        <g transform="translate(28 28)">
          <line x1={-20} y1={0} x2={20} y2={0} stroke={AX} strokeWidth={0.6} />
          <g fill={FILL} fillOpacity={0.16} stroke="none">
            <path d="M-20 0 L-20 10 L-10 -10 L-10 0 Z" />
            <path d="M-10 0 L-10 10 L0 -10 L0 0 Z" />
            <path d="M0 0 L0 10 L10 -10 L10 0 Z" />
            <path d="M10 0 L10 10 L20 -10 L20 0 Z" />
          </g>
          <g stroke={PLOT} strokeWidth={1.4} strokeLinecap="round">
            <line x1={-20} y1={10} x2={-10} y2={-10} />
            <line x1={-10} y1={10} x2={0} y2={-10} />
            <line x1={0} y1={10} x2={10} y2={-10} />
            <line x1={10} y1={10} x2={20} y2={-10} />
          </g>
        </g>
      );

    case 'dot':
      return (
        <g transform="translate(15 36)">
          <line x1={0} y1={0} x2={26} y2={0} stroke={CONSTRUCT} strokeWidth={1.4} />
          <polygon points="26,0 22,-2 22,2" fill={CONSTRUCT} />
          <line x1={0} y1={0} x2={13} y2={-16} stroke={BLUE} strokeWidth={1.8} />
          <polygon points="13,-16 9,-15 12,-12" fill={BLUE} />
          <line x1={13} y1={-16} x2={13} y2={0} stroke={CONSTRUCT} strokeWidth={0.9} strokeDasharray="1.4 1.4" />
          <polyline points="11,0 11,-2 13,-2" stroke={CONSTRUCT} strokeWidth={0.7} fill="none" />
          <line x1={0} y1={0} x2={13} y2={0} stroke={PLOT} strokeWidth={3} strokeLinecap="round" />
        </g>
      );
    case 'cross':
      return (
        <g>
          <path d="M 16 44 L 28.1 37 L 40.2 44 L 28.1 51 Z" fill={BLUE} fillOpacity={0.16} stroke="none" />
          <line x1={28.1} y1={37} x2={40.2} y2={44} stroke={CONSTRUCT} strokeWidth={0.9} strokeDasharray="1.4 1.4" />
          <line x1={28.1} y1={51} x2={40.2} y2={44} stroke={CONSTRUCT} strokeWidth={0.9} strokeDasharray="1.4 1.4" />
          <line x1={16} y1={44} x2={28.1} y2={37} stroke={BLUE} strokeWidth={2.2} />
          <polygon points="28.1,37 25,37.4 25.9,40.4" fill={BLUE} />
          <line x1={16} y1={44} x2={28.1} y2={51} stroke={PLOT} strokeWidth={2.2} />
          <polygon points="28.1,51 25,50.6 25.9,47.6" fill={PLOT} />
          <line x1={16} y1={44} x2={16} y2={14} stroke={GREEN} strokeWidth={2.2} />
          <polygon points="16,14 13,19 19,19" fill={GREEN} />
        </g>
      );
    case 'length':
      return (
        <g transform="translate(28 28)">
          <line x1={-15} y1={-9} x2={-15} y2={9} stroke={INK} strokeWidth={1.2} />
          <line x1={15} y1={-9} x2={15} y2={9} stroke={INK} strokeWidth={1.2} />
          <line x1={-15} y1={0} x2={15} y2={0} stroke={PLOT} strokeWidth={1.6} />
          <polygon points="-15,0 -10,-3 -10,3" fill={PLOT} />
          <polygon points="15,0 10,-3 10,3" fill={PLOT} />
        </g>
      );
    case 'distance':
      return (
        <g transform="translate(28 28)">
          <PerspectiveGround />
          <line x1={-12} y1={17} x2={14} y2={11} stroke={INK} strokeDasharray="1.4 1.4" strokeWidth={1.1} />
          <circle cx={-12} cy={17} r={3.5} fill={BLUE} />
          <circle cx={14} cy={11} r={3.5} fill={PLOT} />
        </g>
      );
    case 'normalize':
      return (
        <g transform="translate(28 32)">
          <line x1={-14} y1={8} x2={14} y2={-10} stroke={AX} strokeDasharray="2 2" strokeWidth={1} />
          <line x1={-14} y1={8} x2={-2} y2={0} stroke={PLOT} strokeWidth={2} />
          <polygon points="-2,0 -5,-1 -3,2" fill={PLOT} />
        </g>
      );

    case 'float':
      return <Knob value={value} accent={PLOT} />;
    case 'int':
      return <Knob value={value} accent={INT} ticks />;

    case 'positionWorld':
      return (
        <g transform="translate(28 28)">
          <PerspectiveGround />
          <circle cx={-4} cy={14} r={3.5} fill={PLOT} />
        </g>
      );
    case 'positionLocal':
      return (
        <g transform="translate(28 28)">
          <PerspectiveGround />
          <rect x={-12} y={4} width={24} height={12} fill="rgba(0,0,0,0.04)" stroke={INK} strokeWidth={1.4} />
          <circle cx={0} cy={10} r={3} fill={PLOT} />
        </g>
      );
    case 'uv':
      return (
        <g transform="translate(28 28)">
          <g stroke={PLOT} strokeWidth={0.6} opacity={0.6}>
            {[-14, -10, -6, -2, 2, 6, 10, 14].map((x) => <line key={`v${x}`} x1={x} y1={-14} x2={x} y2={14} />)}
            {[-14, -10, -6, -2, 2, 6, 10, 14].map((y) => <line key={`h${y}`} x1={-14} y1={y} x2={14} y2={y} />)}
          </g>
          <g stroke={INK} strokeWidth={1.6} fill="none" strokeLinejoin="round">
            <rect x={-2} y={-10} width={8} height={8} />
            <rect x={-10} y={-2} width={8} height={8} />
            <rect x={-2} y={-2} width={8} height={8} />
            <rect x={6} y={-2} width={8} height={8} />
            <rect x={-2} y={6} width={8} height={8} />
          </g>
        </g>
      );
    case 'cameraNear':
    case 'cameraFar': {
      const near = type === 'cameraNear';
      return (
        <g>
          <line x1={19} y1={28} x2={47} y2={10} stroke={CONSTRUCT} strokeWidth={0.8} />
          <line x1={19} y1={28} x2={47} y2={46} stroke={CONSTRUCT} strokeWidth={0.8} />
          <line x1={36} y1={20} x2={36} y2={36} stroke={near ? PLOT : INK} strokeWidth={near ? 1.2 : 2.6} strokeLinecap="round" />
          <line x1={24} y1={25.6} x2={24} y2={30.4} stroke={near ? INK : PLOT} strokeWidth={near ? 2.6 : 1.2} strokeLinecap="round" />
          <ellipse cx={13} cy={28} rx={6} ry={3.5} fill="none" stroke={INK} strokeWidth={1.6} />
          <circle cx={13} cy={28} r={2} fill={INK} />
        </g>
      );
    }
    default:
      return null;
  }
}

export const NodeGlyph = memo(function NodeGlyph({
  type,
  value = 0,
  size = 50,
  design: designProp,
}: {
  type: string;
  value?: number;
  size?: number;
  /** Draft design override (Node Designer). Replaces the saved entry outright:
   *  its `svg` is the ONLY art considered (a cleared draft renders nothing). */
  design?: GlyphDesign;
}) {
  // A custom glyph (authored in node-designer.html, stored in customGlyphs.ts)
  // wins over the built-in art. It's developer-authored build-time source, so
  // rendering its inner SVG via dangerouslySetInnerHTML is safe here. An optional
  // per-node `scale` is applied about the tile centre (28,28).
  const design = designProp ?? CUSTOM_GLYPHS[type];
  const scale = design?.scale ?? 1;
  const art: ReactNode = design?.svg
    ? <g dangerouslySetInnerHTML={{ __html: design.svg }} />
    : designProp
      ? null
      : renderArt(type, value);
  if (!art) return null;
  // Scale grows the rendered size (so the glyph gets bigger and the node grows),
  // rather than transforming art inside a fixed box (which would just clip).
  const px = Math.round(size * scale);
  // Optional designer nudge: translate the art in glyph space (purely visual,
  // never affects layout). `overflow: visible` keeps nudged art from clipping.
  const dx = typeof design?.dx === 'number' ? design.dx : 0;
  const dy = typeof design?.dy === 'number' ? design.dy : 0;
  return (
    <svg viewBox="0 0 56 56" width={px} height={px} style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
      {dx !== 0 || dy !== 0 ? <g transform={`translate(${dx} ${dy})`}>{art}</g> : art}
    </svg>
  );
});
