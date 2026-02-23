import { memo, useEffect, useRef, useState } from 'react';
import type { NodeDefinition, NodeCategory } from '@/types';
import { getTypeColor, getCostColor, getCostTextColor, getCostScale, CATEGORY_COLORS, hexToRgb01 } from '@/utils/colorUtils';
import { getFlowNodeType } from '@/registry/nodeRegistry';
import { buildRows } from './nodes/ShaderNode';
import { renderMathPreview } from '@/utils/mathPreview';
import { renderNoisePreview, type NoiseType } from '@/utils/noisePreview';
import { ensureInit, renderPreview, dispose, isAvailable } from '@/utils/texturePreviewRenderer';
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
}

/* ============================================================
 * ShaderCardContent — generic node (header + port rows + fake handles)
 * ============================================================ */

function ShaderCardContent({ def, catColor, costColor, costTextColor, costScale, cost }: ContentProps) {
  const rows = buildRows(def);

  return (
    <div
      className="node-base node-preview-card__node"
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">{def.label}</span>
      </div>

      <div className="node-base__body">
        {rows.map((row, i) => (
          <div key={i} className="node-base__row node-preview-card__row">
            <div className="node-preview-card__left">
              {row.input && (
                <>
                  <span
                    className="node-preview-card__handle node-preview-card__handle--left"
                    style={{ background: getTypeColor(row.input.dataType) }}
                  />
                  <span className="node-base__port-label">{row.input.label}</span>
                </>
              )}
              {row.settingKey && row.settingType === 'number' && (
                <span className="node-preview-card__value">
                  {def.defaultValues?.[row.settingKey] ?? 0}
                </span>
              )}
              {row.settingKey && row.settingType === 'color' && (
                <span
                  className="node-preview-card__color-swatch"
                  style={{ background: String(def.defaultValues?.[row.settingKey] ?? '#ff0000') }}
                />
              )}
              {row.settingType === 'vec3' && row.vecBaseKey && (
                <span className="node-preview-card__value">
                  {['x', 'y', 'z'].map((a) => def.defaultValues?.[`${row.vecBaseKey}_${a}`] ?? 0).join(', ')}
                </span>
              )}
              {row.settingType === 'vec2' && row.vecBaseKey && (
                <span className="node-preview-card__value">
                  {['x', 'y'].map((a) => def.defaultValues?.[`${row.vecBaseKey}_${a}`] ?? 0).join(', ')}
                </span>
              )}
            </div>

            <div className="node-preview-card__right">
              {row.output && (
                <>
                  <span className="node-base__port-label">{row.output.label}</span>
                  <span
                    className="node-preview-card__handle node-preview-card__handle--right"
                    style={{ background: getTypeColor(row.output.dataType) }}
                  />
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
 * TextureCardContent — GPU-rendered preview (lazy via IntersectionObserver)
 * ============================================================ */

function TextureCardContent({ def, catColor, costColor, costTextColor, costScale, cost }: ContentProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [gpuReady, setGpuReady] = useState(false);
  const renderedRef = useRef(false);
  const cacheId = `card_${def.type}`;

  useEffect(() => {
    ensureInit().then((ok) => setGpuReady(ok));
  }, []);

  useEffect(() => {
    if (!gpuReady || !canvasRef.current || !containerRef.current) return;
    if (renderedRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && canvasRef.current) {
          renderedRef.current = true;
          renderPreview(cacheId, def.type, def.defaultValues ?? {}, false, canvasRef.current);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 300px' },
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [gpuReady, def.type, cacheId]);

  useEffect(() => () => dispose(cacheId), [cacheId]);

  return (
    <div
      ref={containerRef}
      className="node-base node-preview-card__node"
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">{def.label}</span>
      </div>

      <div className="node-preview-card__canvas-wrap">
        {gpuReady ? (
          <canvas
            ref={canvasRef}
            width={96}
            height={96}
            className="node-preview-card__canvas--texture"
          />
        ) : (
          <div className="node-preview-card__placeholder">
            {isAvailable() ? 'Loading\u2026' : 'No WebGPU'}
          </div>
        )}
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
 * MathCardContent — waveform canvas (static)
 * ============================================================ */

function MathCardContent({ def, catColor, costColor, costTextColor, costScale, cost }: ContentProps) {
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
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">{def.label}</span>
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

function NoiseCardContent({ def, catColor, costColor, costTextColor, costScale, cost }: ContentProps) {
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
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">{def.label}</span>
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

function ClockCardContent({ def, catColor, costColor, costTextColor, costScale, cost }: ContentProps) {
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
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}

      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">{def.label}</span>
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
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(cost);
  const costTextColor = getCostTextColor(cost);
  const costScale = getCostScale(cost);
  const flowType = getFlowNodeType(def);

  const shared: ContentProps = { def, catColor, costColor, costTextColor, costScale, cost };

  return (
    <div className="node-preview-card" draggable onDragStart={(e) => onDragStart(e, def)}>
      {flowType === 'color' ? (
        <ColorCardContent def={def} cost={cost} costTextColor={costTextColor} />
      ) : flowType === 'texturePreview' ? (
        <TextureCardContent {...shared} />
      ) : flowType === 'mathPreview' ? (
        <MathCardContent {...shared} />
      ) : flowType === 'preview' ? (
        <NoiseCardContent {...shared} />
      ) : flowType === 'clock' ? (
        <ClockCardContent {...shared} />
      ) : (
        <ShaderCardContent {...shared} />
      )}
    </div>
  );
});
