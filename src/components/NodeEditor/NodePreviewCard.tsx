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
import './nodes/MicNode.css';
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
const CARD_NODE_MAX_W = 300;
const CARD_NODE_MAX_H = 270;
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
  let f = CARD_HEADING_PX / (9 * Math.max(0.1, textScale) * Math.max(0.1, visualScale));
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

function CardShell({ def, catColor, costColor, costTextColor, costScale, cost, headerTextColor, children }: ContentProps & { children: React.ReactNode }) {
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

      {def.outputs[0] && (
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

      {def.inputs[0] && (
        <span
          className="node-preview-card__handle node-preview-card__handle--left-abs"
          style={{ background: getTypeColor(def.inputs[0].dataType), bottom: 8 }}
        />
      )}
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

    const size = 56;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 4;
    const now = Date.now() / 1000;

    // Clock face
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Hour marks
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const inner = r - 4;
      const outer = r - 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Seconds hand (frozen at mount time)
    const secAngle = ((now % 60) / 60) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(secAngle) * (r - 6), cy + Math.sin(secAngle) * (r - 6));
    ctx.strokeStyle = '#e74c3c';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#e74c3c';
    ctx.fill();
  }, []);

  return (
    <CardShell {...props}>
      <div className="node-preview-card__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={56}
          height={56}
          className="node-preview-card__canvas--clock"
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
  // Mirrors MicNode.tsx's geometry so the tile is a true miniature of the node.
  const PARAM_TOPS = [26, 54];
  const OUT_TOPS = [86, 108, 130, 152];
  return (
    <CardShell {...props}>
      <div className="mic-node__body" style={{ height: 172, position: 'relative' }}>
        {def.inputs.map((inp, i) => (
          <div key={inp.id} className="mic-node__val" style={{ top: PARAM_TOPS[i] ?? 0 }}>
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
        <div className="shader-node__mic-btn" aria-hidden="true" />
        {def.outputs.map((out, i) => (
          <span
            key={out.id}
            className="react-flow__handle react-flow__handle-right typed-handle"
            style={{ background: getTypeColor(out.dataType), top: OUT_TOPS[i] ?? 0 }}
          />
        ))}
      </div>
    </CardShell>
  );
}

/* ============================================================
 * SliderCardContent — slider with range track preview
 * ============================================================ */

function SliderCardContent(props: ContentProps) {
  const { def } = props;
  const val = Number(def.defaultValues?.value ?? 0.5);
  const min = Number(def.defaultValues?.min ?? 0);
  const max = Number(def.defaultValues?.max ?? 1);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 50;

  return (
    <CardShell {...props}>
      <div className="node-preview-card__slider-wrap">
        <div className="node-preview-card__slider-track">
          <div className="node-preview-card__slider-fill" style={{ width: `${pct}%` }} />
          <div className="node-preview-card__slider-thumb" style={{ left: `${pct}%` }} />
        </div>
        <div className="node-preview-card__slider-labels">
          <span>{min}</span>
          <span className="node-preview-card__slider-val">{val}</span>
          <span>{max}</span>
        </div>
      </div>
    </CardShell>
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

  return (
    <div
      className={`node-preview-card__color-node${isProperty ? ' node-preview-card__color-node--rect' : ''}`}
      style={{ background: hex }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}
      <span className="node-preview-card__color-label" style={{ color: labelColor }}>
        {isProperty ? String(def.defaultValues?.name ?? 'color1') : 'Color'}
      </span>
      {def.outputs[0] && (
        <span
          className="node-preview-card__handle node-preview-card__handle--right-abs"
          style={{ background: getTypeColor(def.outputs[0].dataType) }}
        />
      )}
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
      ) : def.type === 'slider' ? (
        <FitNodeHeading visualScale={shared.costScale} textScale={1}><SliderCardContent {...shared} /></FitNodeHeading>
      ) : (
        <FitNodeHeading visualScale={shared.costScale} textScale={nodeTextScale(def.type)}><ShaderCardContent {...shared} /></FitNodeHeading>
      )}
    </div>
  );
});
