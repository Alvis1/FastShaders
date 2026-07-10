import { memo, useEffect, useRef, useCallback, useState, type CSSProperties } from 'react';
import type { NodeDefinition, NodeCategory } from '@/types';
import { startTileDrag, tileGhostZoom } from './tileDrag';
import { getTypeColor, getCostColor, getCostTextColor, getCostScale, CATEGORY_COLORS, getContrastColor, hexToRgb01 } from '@/utils/colorUtils';
import { getFlowNodeType, displayDescription } from '@/registry/nodeRegistry';
import { useAssetTooltip } from './AssetTooltip';
import { useAppStore } from '@/store/useAppStore';
import { buildRows } from './nodes/ShaderNode';
import { DragNumberInput } from './inputs/DragNumberInput';
import { hasNodeGlyph, NodeGlyph, nodeBox, nodeSockets, nodeTextScale, nodeJustify, nodeScale } from './nodes/glyphs/NodeGlyph';
import { renderMathPreview } from '@/utils/mathPreview';
import { renderNoisePreview, type NoiseType } from '@/utils/noisePreview';
import complexityData from '@/registry/complexity.json';
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

function ShaderCardContent({ def, catColor, costColor, costTextColor, costScale, cost , headerTextColor }: ContentProps) {
  // EXACT static replica of the live ShaderNode: same classes, same widgets
  // (real DragNumberInput, real handle styling via the react-flow/typed-handle
  // classes), same structure, and all per-node designer overrides (operator
  // layout, width/height, justify, text scale, glyph scale/nudge, moved
  // sockets). Rendered inert — the card wrapper has pointer-events: none.
  const box = nodeBox(def.type);
  const textScale = nodeTextScale(def.type);
  const sockets = nodeSockets(def.type);
  const justify = nodeJustify(def.type);
  const gScale = nodeScale(def.type);
  const dv = def.defaultValues ?? {};

  // Mirrors ShaderNode's wrapper (cost scale) + card (border/width/text) split.
  const wrapStyle: CSSProperties = {
    position: 'relative',
    width: 'fit-content',
    transform: `scale(${costScale})`,
    transformOrigin: 'top left',
  };
  const nodeStyle: CSSProperties = {
    background: 'var(--bg-panel)',
    border: `1.5px solid ${catColor}`,
  };
  if (box.width) {
    nodeStyle.width = box.width;
    nodeStyle.minWidth = box.width;
  }
  if (textScale !== 1) (nodeStyle as Record<string, string | number>)['--node-text-scale'] = textScale;

  const calcTop = (off: number) => `calc(50% ${off < 0 ? '-' : '+'} ${Math.abs(off)}px)`;
  const num = (k: string) => Number(dv[k] ?? 0);
  const noop = () => {};

  /** Static socket dot with the live handle's exact classes/geometry. */
  const StaticHandle = ({ side, dataType, label, style }: {
    side: 'left' | 'right';
    dataType: Parameters<typeof getTypeColor>[0];
    label?: string;
    style?: CSSProperties;
  }) => (
    <span
      className={`react-flow__handle react-flow__handle-${side} typed-handle`}
      title={label}
      style={{ background: getTypeColor(dataType), ...style }}
    />
  );

  const header = (
    <>
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}
      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" style={{ color: headerTextColor }}>
          {def.type === 'property_float' ? String(dv.name ?? def.label) : def.label}
        </span>
      </div>
    </>
  );

  // ── Operator layout (2-input glyph nodes) ──
  if (hasNodeGlyph(def.type) && def.inputs.length === 2) {
    const BODY_H = box.height ?? Math.max(52, Math.round(34 * gScale) + 10);
    const DEF_OFF = [-12.5, 12.5];
    const offOf = (id: string, i: number) => sockets[id] ?? DEF_OFF[i] ?? 0;
    const outOff = sockets['out'] ?? 0;
    return (
      <div className="node-preview-card__node" style={wrapStyle}>
        <div className="node-base node-preview-card__node--exact" style={nodeStyle}>
          {header}
          <div className="shader-node__op" style={{ height: BODY_H, ...(box.width ? { minWidth: 0 } : null) }}>
            <div className="shader-node__op-glyph">
              <NodeGlyph type={def.type} value={num('value')} size={34} />
            </div>
            {def.inputs.map((inp, i) => (
              <div
                key={`v-${inp.id}`}
                className={`shader-node__op-val shader-node__op-val--${justify}`}
                style={{ top: BODY_H / 2 + offOf(inp.id, i) }}
              >
                <DragNumberInput compact value={num(inp.id)} onChange={noop} />
              </div>
            ))}
            {def.inputs.map((inp, i) => (
              <StaticHandle key={`h-${inp.id}`} side="left" dataType={inp.dataType} label={inp.label}
                style={{ top: `${BODY_H / 2 + offOf(inp.id, i)}px` }} />
            ))}
            {def.outputs[0] && (
              <StaticHandle side="right" dataType={def.outputs[0].dataType} label={def.outputs[0].label}
                style={{ top: `${BODY_H / 2 + outOff}px` }} />
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Rows layout (ShaderNode's rows branch with every input unconnected) ──
  const rows = buildRows(def);
  const outMoved = sockets['out'] != null && !!def.outputs[0];
  return (
    <div className="node-preview-card__node" style={wrapStyle}>
      <div className="node-base node-preview-card__node--exact" style={nodeStyle}>
        {header}
        <div style={{ position: 'relative', ...(box.height ? { height: box.height } : null) }}>
          {hasNodeGlyph(def.type) && (
            <div className="shader-node__glyph">
              <NodeGlyph type={def.type} value={num('value')} size={30} />
            </div>
          )}

          <div className="node-base__body">
            {rows.map((row, i) => {
              const inputMoved = row.input ? sockets[row.input.id] != null : false;
              const showInlineValue = row.input && !row.settingKey;
              if (inputMoved) {
                return (
                  <div key={i} className="node-base__row shader-node__row">
                    <div className="shader-node__left" />
                    <div className="shader-node__right">
                      {row.output && !(outMoved && row.output === def.outputs[0]) && (
                        <StaticHandle side="right" dataType={row.output.dataType} label={row.output.label} />
                      )}
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="node-base__row shader-node__row">
                  <div className="shader-node__left">
                    {row.input && (
                      <StaticHandle side="left" dataType={row.input.dataType} label={row.input.label} />
                    )}
                    {def.type === 'slider' && row.settingKey === 'value' && (
                      <input type="range" className="shader-node__slider nodrag"
                        min={num('min')} max={Number(dv.max ?? 1)} step={0.01}
                        defaultValue={Number(dv.value ?? 0.5)} readOnly />
                    )}
                    {row.settingKey && row.settingType === 'number' && !(def.type === 'slider' && row.settingKey === 'value') && (
                      <DragNumberInput compact value={num(row.settingKey)} onChange={noop} />
                    )}
                    {row.settingKey && row.settingType === 'color' && (
                      <input type="color" className="shader-node__input-color nodrag"
                        defaultValue={String(dv[row.settingKey] ?? '#ff0000')} />
                    )}
                    {row.settingType === 'vec3' && row.vecBaseKey && (
                      <span className="shader-node__vec-group">
                        {['x', 'y', 'z'].map((a) => (
                          <DragNumberInput key={a} compact value={num(`${row.vecBaseKey}_${a}`)} onChange={noop} />
                        ))}
                      </span>
                    )}
                    {row.settingType === 'vec2' && row.vecBaseKey && (
                      <span className="shader-node__vec-group">
                        {['x', 'y'].map((a) => (
                          <DragNumberInput key={a} compact value={num(`${row.vecBaseKey}_${a}`)} onChange={noop} />
                        ))}
                      </span>
                    )}
                    {showInlineValue && (
                      <DragNumberInput compact value={num(row.input!.id)} onChange={noop} />
                    )}
                  </div>
                  <div className="shader-node__right">
                    {row.output && !(outMoved && row.output === def.outputs[0]) && (
                      <StaticHandle side="right" dataType={row.output.dataType} label={row.output.label} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Detached (designer-moved) inputs: value follows its socket */}
          {def.inputs.map((inp) => {
            const off = sockets[inp.id];
            if (off == null) return null;
            return (
              <div key={`mv-${inp.id}`} style={{ display: 'contents' }}>
                <div className={`shader-node__op-val shader-node__op-val--${justify}`} style={{ top: calcTop(off) }}>
                  <DragNumberInput compact value={num(inp.id)} onChange={noop} />
                </div>
                <StaticHandle side="left" dataType={inp.dataType} label={inp.label} style={{ top: calcTop(off) }} />
              </div>
            );
          })}
          {outMoved && (
            <StaticHandle side="right" dataType={def.outputs[0].dataType} label={def.outputs[0].label}
              style={{ top: calcTop(sockets['out']) }} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * MathCardContent — waveform canvas (static)
 * ============================================================ */

function MathCardContent({ def, catColor, costColor, costTextColor, costScale, cost , headerTextColor }: ContentProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
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
    <div
      className="node-base node-preview-card__node"
      style={{ background: 'var(--bg-panel)', border: `1.5px solid ${catColor}`, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" style={{ color: headerTextColor }}>{def.label}</span>
      </div>

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
 * NoiseCardContent — CPU noise pattern (static)
 * ============================================================ */

function NoiseCardContent({ def, catColor, costColor, costTextColor, costScale, cost , headerTextColor }: ContentProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
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
    <div
      className="node-base node-preview-card__node"
      style={{ background: 'var(--bg-panel)', border: `1.5px solid ${catColor}`, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" style={{ color: headerTextColor }}>{def.label}</span>
      </div>

      <div className="node-preview-card__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={96}
          height={96}
          className="node-preview-card__canvas--noise"
        />
      </div>

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
 * ClockCardContent — static clock face
 * ============================================================ */

function ClockCardContent({ def, catColor, costColor, costTextColor, costScale, cost , headerTextColor }: ContentProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
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
    <div
      className="node-base node-preview-card__node"
      style={{ background: 'var(--bg-panel)', border: `1.5px solid ${catColor}`, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" style={{ color: headerTextColor }}>{def.label}</span>
      </div>

      <div className="node-preview-card__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={56}
          height={56}
          className="node-preview-card__canvas--clock"
        />
      </div>

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
 * SliderCardContent — slider with range track preview
 * ============================================================ */

function SliderCardContent({ def, catColor, costColor, costTextColor, costScale, cost , headerTextColor }: ContentProps) {
  const val = Number(def.defaultValues?.value ?? 0.5);
  const min = Number(def.defaultValues?.min ?? 0);
  const max = Number(def.defaultValues?.max ?? 1);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 50;

  return (
    <div
      className="node-base node-preview-card__node"
      style={{ background: 'var(--bg-panel)', border: `1.5px solid ${catColor}`, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" style={{ color: headerTextColor }}>{def.label}</span>
      </div>

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
 * ColorCardContent — color circle with contrast-aware label
 * ============================================================ */

function ColorCardContent({ def, cost, costTextColor }: { def: NodeDefinition; cost: number; costTextColor: string }) {
  const hex = String(def.defaultValues?.hex ?? '#ff0000');
  const [r, g, b] = hexToRgb01(hex);
  const labelColor = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45
    ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)';

  return (
    <div className="node-preview-card__color-node" style={{ background: hex }}>
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}
      <span className="node-preview-card__color-label" style={{ color: labelColor }}>Color</span>
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
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const costScale = getCostScale(cost);
  const flowType = getFlowNodeType(def);

  const shared: ContentProps = { def, catColor, costColor, costTextColor, costScale, cost, headerTextColor };
  const { tooltip, tooltipHandlers } = useAssetTooltip(displayDescription(def));

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
      ) : def.type === 'slider' ? (
        <FitNodeHeading visualScale={shared.costScale} textScale={1}><SliderCardContent {...shared} /></FitNodeHeading>
      ) : (
        <FitNodeHeading visualScale={shared.costScale} textScale={nodeTextScale(def.type)}><ShaderCardContent {...shared} /></FitNodeHeading>
      )}
    </div>
  );
});
