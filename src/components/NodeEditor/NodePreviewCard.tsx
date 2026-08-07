import { memo, useEffect, useRef, useCallback, useState } from 'react';
import type { NodeDefinition, NodeCategory } from '@/types';
import { startTileDrag, tileGhostZoom, tileActivationProps } from './tileDrag';
import { getTypeColor, getCostColor, getCostTextColor, getCostScale, CATEGORY_COLORS, getContrastColor, hexToRgb01 } from '@/utils/colorUtils';
import { getFlowNodeType, displayDescription } from '@/registry/nodeRegistry';
import { formatNodeLabel, nodeDescription } from '@/i18n';
import { useAssetTooltip } from './AssetTooltip';
import { useAppStore } from '@/store/useAppStore';
import { NodeVisual } from './nodes/NodeVisual';
import { DragNumberInput } from './inputs/DragNumberInput';
import { nodeTextScale } from './nodes/glyphs/NodeGlyph';
import { renderMathPreview } from '@/utils/mathPreview';
import { renderNoisePreview, type NoiseType } from '@/utils/noisePreview';
import complexityData from '@/registry/complexity.json';
import { MIC_BODY_W, MIC_BODY_H, MIC_PARAM_TOPS, MIC_CHIP_H, MIC_BTN_TOP, MIC_OUT_TOPS } from './nodes/micGeometry';
import { CLOCK_SIZE, drawClockFace } from '@/utils/clockFace';
import { useFitText } from '@/hooks/useFitText';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import {
  COLOR_NODE_SIZE,
  LABEL_MAX_PX as COLOR_LABEL_MAX_PX,
  LABEL_MIN_PX as COLOR_LABEL_MIN_PX,
} from './nodes/ColorNode';
import './nodes/ColorNode.css';
import {
  PIXEL_PORTS as OUTPUT_PIXEL_PORTS,
  VERTEX_PORTS as OUTPUT_VERTEX_PORTS,
  OUTPUT_FLOAT_VALUE_PORTS,
  OUTPUT_COLOR_VALUE_PORTS,
} from './nodes/OutputNode';
import './nodes/ClockNode.css';
import './nodes/MicNode.css';
import './nodes/OutputNode.css';
import './NodePreviewCard.css';

interface NodePreviewCardProps {
  def: NodeDefinition;
  onDragStart: (event: React.DragEvent, def: NodeDefinition) => void;
}

interface ContentProps {
  def: NodeDefinition;
  catColor: string;
  costColor: string;
  costTextColor: string;
  costScale: number;
  cost: number;
  headerTextColor: string;
}

/* ============================================================
 * FitNodeHeading — uniform heading size, true proportions
 * ============================================================ */

/** Scales the exact ShaderNode replica uniformly so every asset card shows
 *  the HEADING at the same visual font size: the factor normalizes the
 *  title's effective size (9px x node text-scale x cost-scale) to a common
 *  target, so node widths/heights vary with their true proportions while the
 *  headers all read identically. Width/height caps keep extreme designs
 *  inside the drawer (those render with a smaller heading, still
 *  proportional). The scale is uniform — an undistorted miniature. */
// Target title size (pre 0.67 tile-zoom). 10px = --font-size-xs, matching the
// Textures-tab card headers, so every asset card's heading reads identically.
const CARD_HEADING_PX = 10;
/** The title size the normalizer's arithmetic assumes: `.node-base__title`'s
 *  `calc(9px * var(--node-text-scale, 1))` (NodeBase.css), which is what
 *  CardShell and NodeVisual render. A card whose heading is a DIFFERENT
 *  element must divide its own size by this and pass the ratio as `textScale`,
 *  or the normalization misses by exactly that ratio — see the output branch. */
const CARD_TITLE_BASE_PX = 9;
/** `.output-node__title` is a flat 10px (OutputNode.css) with no
 *  --node-text-scale hook, so the Output replica needs the ratio below. */
const OUTPUT_TITLE_PX = 10;
const CARD_NODE_MAX_W = 300;
const CARD_NODE_MAX_H = 270;
/**
 * Counter-scale for the colour swatch, the one card with NO header for
 * FitNodeHeading to normalize against. `.node-preview-card` carries
 * `zoom: 0.67`, so 1/0.67 renders the real COLOR_NODE_SIZE swatch at the size
 * it has on the canvas. Keep the two in step.
 */
const CARD_COLOR_SCALE = 1.5;
function FitNodeHeading({ visualScale, textScale, children }: { visualScale: number; textScale: number; children: React.ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.offsetWidth, h = el.offsetHeight;
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // visual size includes the replica's own cost-scale transform
  const vw = size ? Math.max(1, size.w * visualScale) : 0;
  const vh = size ? Math.max(1, size.h * visualScale) : 0;
  // heading-normalizing factor, clamped by the drawer-safety caps
  let f = CARD_HEADING_PX / (CARD_TITLE_BASE_PX * Math.max(0.1, textScale) * Math.max(0.1, visualScale));
  if (vw) f = Math.min(f, CARD_NODE_MAX_W / vw);
  if (vh) f = Math.min(f, CARD_NODE_MAX_H / vh);
  return (
    <div style={{ width: vw ? vw * f : undefined, height: vh ? vh * f : undefined, overflow: 'visible' }}>
      <div ref={innerRef} style={{ width: 'fit-content', transform: `scale(${f})`, transformOrigin: 'top left' }}>
        {children}
      </div>
    </div>
  );
}

/* ============================================================
 * ShaderCardContent — EXACT static replica of the live ShaderNode
 * ============================================================ */

function ShaderCardContent(props: ContentProps) {
  // The replica itself lives in NodeVisual — ONE component shared by these
  // cards, the node-editor.html overview (which renders these same cards) and
  // the Node Designer's stage, so every preview surface draws a node with the
  // same code the spec pins to ShaderNode. Rendered inert here — the card
  // wrapper has pointer-events: none; width acts as a FLOOR (exactWidth off)
  // so a long name in any language stretches the card instead of wrapping
  // into mid-word fragments.
  return (
    <NodeVisual
      {...props}
      wrapClassName="node-preview-card__node"
      cardClassName="node-preview-card__node--exact"
    />
  );
}

/* ============================================================
 * CardShell — shared card frame (badge, header, output handle)
 * ============================================================ */

function canvasCtx(canvas: HTMLCanvasElement | null) {
  return canvas?.getContext('2d') ?? null;
}

function CardShell({ def, catColor, costColor, costTextColor, costScale, cost, headerTextColor, hideOutput, children }: ContentProps & { children: React.ReactNode; hideOutput?: boolean }) {
  const language = useAppStore((s) => s.language);
  return (
    <div
      className="node-base node-preview-card__node"
      style={{ background: 'var(--node-bg)', border: `1.5px solid ${catColor}`, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" style={{ color: headerTextColor }}>{formatNodeLabel(def.label, def.type, language, false)}</span>
      </div>

      {children}

      {/* hideOutput: for content that places its own per-port handles (the mic
          replica) — this generic centre dot would render as a fifth, phantom
          output on top of them. */}
      {def.outputs[0] && !hideOutput && (
        <span
          className="node-preview-card__handle node-preview-card__handle--right-abs"
          style={{ background: getTypeColor(def.outputs[0].dataType) }}
        />
      )}
    </div>
  );
}

/* ============================================================
 * MathCardContent — waveform canvas (static)
 * ============================================================ */

function MathCardContent(props: ContentProps) {
  const { def } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasCtx(canvasRef.current);
    if (!ctx) return;

    const func = def.type === 'cos' ? Math.cos : Math.sin;
    renderMathPreview(ctx, {
      func,
      width: 72,
      height: 72,
      phase: 0,
      accentColor: '#6C63FF',
      inputValue: 0,
      funcLabel: def.type,
    });
  }, [def.type]);

  return (
    <CardShell {...props}>
      <div className="node-preview-card__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={72}
          height={72}
          className="node-preview-card__canvas--math"
        />
      </div>

      {/* The canvas node's bottom port row: socket AND the editable X value
          beside it (MathPreviewNode renders the number whenever `x` is
          unconnected — which is always true on a palette tile). The tile used
          to draw only a floating dot, so it was both missing the widget and
          shorter than the node by the row's height. */}
      <div className="node-preview-card__math-port-row">
        {def.inputs[0] && (
          <span
            className="node-preview-card__handle node-preview-card__handle--left-abs"
            style={{ background: getTypeColor(def.inputs[0].dataType) }}
          />
        )}
        <DragNumberInput compact value={0} onChange={() => {}} />
      </div>
    </CardShell>
  );
}

/* ============================================================
 * NoiseCardContent — CPU noise pattern (static)
 * ============================================================ */

function NoiseCardContent(props: ContentProps) {
  const { def } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasCtx(canvasRef.current);
    if (!ctx) return;

    const imageData = renderNoisePreview(
      def.type as NoiseType,
      96,
      def.defaultValues ?? {},
      0,
      {},
    );
    ctx.putImageData(imageData, 0, 0);
  }, [def.type, def.defaultValues]);

  return (
    <CardShell {...props}>
      <div className="node-preview-card__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={96}
          height={96}
          className="node-preview-card__canvas--noise"
        />
      </div>
    </CardShell>
  );
}

/* ============================================================
 * ClockCardContent — static clock face
 * ============================================================ */

function ClockCardContent(props: ContentProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasCtx(canvasRef.current);
    if (!ctx) return;
    // Phase 0 — the same hand position a Time node shows the instant it lands
    // on the canvas (ClockNode integrates from phaseRef = 0). This used to seed
    // from Date.now(), so the tile pointed somewhere arbitrary and no two
    // surfaces agreed. The face itself is drawn by the shared routine.
    drawClockFace(ctx, 0);
  }, []);

  return (
    <CardShell {...props}>
      <div className="node-preview-card__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={CLOCK_SIZE}
          height={CLOCK_SIZE}
          className="node-preview-card__canvas--clock"
        />
      </div>
      {/* The canvas node's speed row — always present there, so the tile shows
          it too or the two stop being the same node. Same stacked `×` over a
          centred box; inert via the card's pointer-events: none. */}
      <div className="clock-node__speed-row">
        <span className="clock-node__speed-x">×</span>
        <DragNumberInput
          compact
          value={Number(props.def.defaultValues?.speed ?? 1)}
          onChange={() => {}}
        />
      </div>
    </CardShell>
  );
}


/* ============================================================
 * MicCardContent — inert replica of the MicNode
 * ============================================================ */

function MicCardContent(props: ContentProps) {
  const { def } = props;
  // Geometry comes from micGeometry.ts — the SAME constants MicNode.tsx and
  // the auto-layout footprint read, so the tile is a true miniature by
  // construction (the old hand-copied twin of these values is the drift class
  // that let the tile and the node disagree).
  return (
    <CardShell {...props} hideOutput>
      <div className="mic-node__body" style={{ width: MIC_BODY_W, height: MIC_BODY_H }}>
        {def.inputs.map((inp, i) => (
          <div key={inp.id} className="mic-node__val" style={{ top: MIC_PARAM_TOPS[i] ?? 0, height: MIC_CHIP_H }}>
            {/* Inert by the card's pointer-events: none — kept a real widget so
                the tile matches the live node pixel for pixel. */}
            <DragNumberInput
              compact
              value={Number(def.defaultValues?.[inp.id] ?? 0)}
              onChange={() => {}}
            />
          </div>
        ))}
        {/* Inert: a plain div, never a <button>. A palette tile must not become
            another way to switch the microphone on — armMic has exactly two
            click paths and this is not one of them. */}
        <div className="mic-node__btn-wrap" style={{ top: MIC_BTN_TOP }}>
          {/* --inert stands in for :disabled, which a <div> can never match —
              a tile's mic is never armable, so it must read grey like the
              unwired canvas node rather than the enabled green. */}
          <div className="shader-node__mic-btn shader-node__mic-btn--inert" aria-hidden="true" />
        </div>
        {def.outputs.map((out, i) => (
          <span
            key={out.id}
            className="react-flow__handle react-flow__handle-right typed-handle"
            style={{ background: getTypeColor(out.dataType), top: MIC_OUT_TOPS[i] ?? 0 }}
          />
        ))}
      </div>
    </CardShell>
  );
}

/* (SliderCardContent is gone: it drew a hand-built div track + thumb + a
   min/value/max caption that NO other surface has. The canvas node and the
   Node Designer both render a real `<input type="range">` — ShaderNode.tsx and
   NodeVisual.tsx — and slider's flow type is 'shader', so deleting the special
   case routes it through the shared replica and the tile now shows the actual
   widget.) */

/* ============================================================
 * OutputCardContent — static replica of the OutputNode
 * ============================================================ */

function OutputCardContent({ def, cost, costColor, costTextColor, headerTextColor }: ContentProps) {
  // The Output node is the one flow type with NO branch in this dispatch, so it
  // used to fall through to the generic ShaderCardContent — which, from a def
  // with 7 inputs and no defaultValues, drew SEVEN editable number boxes,
  // including ones for the colour and vec3 channels. Clicking the same row in
  // the overview table then opened GraphModal, which renders the REAL
  // OutputNode: uppercase header, two labelled shader sections, a divider, and
  // only the DEFAULT-exposed channels with no number widgets anywhere. Card and
  // modal were unrecognizable as the same node.
  //
  // Mirrors OutputNode.tsx's markup and reuses its stylesheet outright, so the
  // two can only differ by the handles being inert dots here. It shows the
  // default-exposed channel set — what a freshly placed Output node looks like.
  const exposed = new Set<string>(OUTPUT_DEFAULT_EXPOSED);
  const section = (ids: string[]) => def.inputs.filter((p) => ids.includes(p.id) && exposed.has(p.id));
  // The stored-value widget cell, mirroring a FRESH node's unwired state:
  // unset color swatch, float channels at their material defaults. Real
  // widget markup (the classes ARE the look), rendered inert — a palette
  // tile must not be another place to edit a value, and a <span> wrapper
  // with pointer-events: none is what a card can honestly do (the mic tile's
  // inert-arm-light precedent).
  const valueCell = (portId: string) => {
    if (portId in OUTPUT_COLOR_VALUE_PORTS) {
      return (
        <span
          className="palette-swatch output-node__val"
          style={{ background: OUTPUT_COLOR_VALUE_PORTS[portId] }}
        />
      );
    }
    if (portId in OUTPUT_FLOAT_VALUE_PORTS) {
      return (
        <span className="output-node__val node-preview-card__inert">
          <DragNumberInput compact value={OUTPUT_FLOAT_VALUE_PORTS[portId]} onChange={() => {}} />
        </span>
      );
    }
    return null;
  };
  const rows = (ports: typeof def.inputs) =>
    ports.map((port) => (
      <div key={port.id} className="output-node__row">
        <span
          className="node-preview-card__handle node-preview-card__handle--left-abs"
          style={{ background: getTypeColor(port.dataType), top: '50%', transform: 'translateY(-50%)' }}
        />
        {valueCell(port.id)}
        <span className="output-node__port-label">{port.label}</span>
      </div>
    ));

  return (
    <div className="output-node node-preview-card__node" style={{ background: 'var(--node-bg)', border: '1.5px solid var(--cat-output)' }}>
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}
      <div className="output-node__header" style={{ background: costColor }}>
        <span className="output-node__title" style={{ color: headerTextColor }}>Output</span>
      </div>
      <div className="output-node__section">
        <div className="output-node__section-label">Pixel Shader</div>
        <div className="output-node__ports">{rows(section(OUTPUT_PIXEL_PORTS))}</div>
      </div>
      <div className="output-node__divider" />
      <div className="output-node__section">
        <div className="output-node__section-label">Vertex Shader</div>
        <div className="output-node__ports">{rows(section(OUTPUT_VERTEX_PORTS))}</div>
      </div>
    </div>
  );
}

/* ============================================================
 * ColorCardContent — color circle with contrast-aware label
 * ============================================================ */

function ColorCardContent({ def, cost, costTextColor }: { def: NodeDefinition; cost: number; costTextColor: string }) {
  const hex = String(def.defaultValues?.hex ?? '#ff0000');
  const [r, g, b] = hexToRgb01(hex);
  const labelColor = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45
    ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)';
  // Mirrors the canvas node: the constant is a circle, the named uniform a
  // rounded rectangle labelled with its default property name.
  const isProperty = def.type === 'property_color';
  const label = isProperty ? String(def.defaultValues?.name ?? 'color1') : 'Color';
  // Same shrink-to-fit the canvas swatch uses — the swatch is a fixed square
  // (its socket rides the perimeter), so a long name has to fit INSIDE it.
  const labelRef = useFitText<HTMLSpanElement>(label, COLOR_LABEL_MAX_PX, COLOR_LABEL_MIN_PX);

  return (
    // Real `.color-node` classes at the real COLOR_NODE_SIZE, counter-scaled to
    // undo the strip's zoom. The card used to carry a PARALLEL class set with
    // its own 84px / 2px / 15px numbers — reverse-engineered to land near the
    // canvas swatch after the zoom, i.e. two number sets to keep in step by
    // hand — and, because it re-implemented the label too, it silently lacked
    // every rule ColorNode.css added for long names (wrap-anywhere, clip at the
    // rim, the useFitText shrink), so a long property name spilled across the
    // tile while the canvas kept it inside the swatch.
    <div
      className="node-preview-card__color-scale"
      style={{
        width: COLOR_NODE_SIZE * CARD_COLOR_SCALE,
        height: COLOR_NODE_SIZE * CARD_COLOR_SCALE,
        transform: `scale(${CARD_COLOR_SCALE})`,
      }}
    >
      <div
        className={`color-node${isProperty ? ' color-node--rect' : ''}`}
        style={{ width: COLOR_NODE_SIZE, height: COLOR_NODE_SIZE, background: hex }}
      >
        {cost > 0 && (
          <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
        )}
        <span ref={labelRef} className="color-node__label" style={{ color: labelColor }}>
          {label}
        </span>
        {def.outputs[0] && (
          <span
            className="node-preview-card__handle node-preview-card__handle--right-abs"
            style={{ background: getTypeColor(def.outputs[0].dataType) }}
          />
        )}
      </div>
    </div>
  );
}

/* ============================================================
 * NodePreviewCard — main component with type dispatch
 * ============================================================ */

export const NodePreviewCard = memo(function NodePreviewCard({ def, onDragStart }: NodePreviewCardProps) {
  const costs = complexityData.costs as Record<string, number>;
  const cost = costs[def.type] ?? 0;
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const language = useAppStore((s) => s.language);
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const costScale = getCostScale(cost);
  const flowType = getFlowNodeType(def);

  const shared: ContentProps = { def, catColor, costColor, costTextColor, costScale, cost, headerTextColor };
  const { tooltip, tooltipHandlers } = useAssetTooltip(
    nodeDescription(displayDescription(def), def.type, language),
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      const tile = e.currentTarget as HTMLElement;
      startTileDrag(
        e.nativeEvent,
        { kind: 'node', nodeType: def.type },
        `<div class="node-preview-card" style="zoom: ${tileGhostZoom(tile)}">${tile.innerHTML}</div>`,
      );
    },
    [def.type],
  );

  return (
    <div
      className="node-preview-card"
      draggable
      onDragStart={(e) => onDragStart(e, def)}
      onPointerDown={onPointerDown}
      {...tileActivationProps({ kind: 'node', nodeType: def.type }, `Add ${def.label} node`)}
      {...tooltipHandlers}
    >
      {tooltip}
      {flowType === 'color' ? (
        <ColorCardContent def={def} cost={cost} costTextColor={costTextColor} />
      ) : flowType === 'mathPreview' ? (
        <FitNodeHeading visualScale={shared.costScale} textScale={1}><MathCardContent {...shared} /></FitNodeHeading>
      ) : flowType === 'preview' ? (
        <FitNodeHeading visualScale={shared.costScale} textScale={1}><NoiseCardContent {...shared} /></FitNodeHeading>
      ) : flowType === 'clock' ? (
        <FitNodeHeading visualScale={shared.costScale} textScale={1}><ClockCardContent {...shared} /></FitNodeHeading>
      ) : flowType === 'mic' ? (
        <FitNodeHeading visualScale={shared.costScale} textScale={1}><MicCardContent {...shared} /></FitNodeHeading>
      ) : flowType === 'output' ? (
        // textScale carries the Output header's own type size: its heading is
        // `.output-node__title` (10px), not the 9px `.node-base__title` the
        // normalizer assumes, so passing 1 here overshot by 10/9 and rendered
        // this card 11% larger than every neighbour in the overview table.
        <FitNodeHeading visualScale={shared.costScale} textScale={OUTPUT_TITLE_PX / CARD_TITLE_BASE_PX}><OutputCardContent {...shared} /></FitNodeHeading>
      ) : (
        <FitNodeHeading visualScale={shared.costScale} textScale={nodeTextScale(def.type)}><ShaderCardContent {...shared} /></FitNodeHeading>
      )}
    </div>
  );
});
