import { memo, useEffect, useRef, useState } from 'react';
import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { TexturePreviewFlowNode, NodeCategory, TSLDataType } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor } from '@/utils/colorUtils';
import { hasTimeUpstream } from '@/utils/graphTraversal';
import { TypedHandle } from '../handles/TypedHandle';
import { CATEGORY_COLORS } from './ShaderNode';
import {
  ensureInit,
  renderPreview,
  registerAnimated,
  unregisterAnimated,
  dispose,
  isAvailable,
} from '@/utils/texturePreviewRenderer';
import './TexturePreviewNode.css';

const PREVIEW_SIZE = 96;
const DEBOUNCE_MS = 500;

export const TexturePreviewNode = memo(function TexturePreviewNode({
  id,
  data,
  selected,
}: NodeProps<TexturePreviewFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  if (!def) return null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [gpuReady, setGpuReady] = useState(false);
  const updateNodeInternals = useUpdateNodeInternals();

  // Force React Flow to recalculate handle positions when exposed ports change
  const exposedPorts = data.exposedPorts;
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, exposedPorts, updateNodeInternals]);

  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);

  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(data.cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(data.cost, costColorLow, costColorHigh);
  const costScale = getCostScale(data.cost);

  // Check if any input has time upstream
  const hasTime = edges
    .filter((e) => e.target === id)
    .some((e) => hasTimeUpstream(e.source, nodes, edges));

  // Initialize GPU renderer
  useEffect(() => {
    ensureInit().then((ok) => setGpuReady(ok));
  }, []);

  // Render preview on mount and when params change (debounced)
  useEffect(() => {
    if (!gpuReady || !canvasRef.current) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (canvasRef.current) {
        renderPreview(id, data.registryType, data.values, hasTime, canvasRef.current);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [gpuReady, id, data.registryType, data.values, hasTime]);

  // Manage animation registration
  useEffect(() => {
    if (!gpuReady || !canvasRef.current) return;
    if (hasTime) {
      registerAnimated(id, canvasRef.current);
    } else {
      unregisterAnimated(id);
    }
    return () => unregisterAnimated(id);
  }, [gpuReady, id, hasTime]);

  // Cleanup on unmount
  useEffect(() => {
    return () => dispose(id);
  }, [id]);

  return (
    <div
      className={`node-base texture-preview-node ${selected ? 'node-base--selected' : ''}`}
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {data.cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>
          {data.cost}
        </span>
      )}

      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">{varName ?? data.label}</span>
      </div>

      {/* GPU-rendered preview canvas */}
      <div className="texture-preview-node__canvas-wrap">
        {gpuReady ? (
          <canvas
            ref={canvasRef}
            width={PREVIEW_SIZE}
            height={PREVIEW_SIZE}
            className="texture-preview-node__canvas"
          />
        ) : (
          <div className="texture-preview-node__placeholder">
            {isAvailable() ? 'Loading...' : 'No WebGPU'}
          </div>
        )}
      </div>

      {/* Input handles — only exposed ports, in rows like OutputNode */}
      {(() => {
        const exposed = new Set(data.exposedPorts ?? []);
        if (exposed.size === 0) return null;

        // Build ordered list matching settings: tslRef inputs first, then defaultValues keys
        const defaultKeys = def.defaultValues ? Object.keys(def.defaultValues) : [];
        const tslRefKeys = def.inputs
          .filter((inp) => !def.defaultValues || !(inp.id in def.defaultValues))
          .map((inp) => inp.id);
        const orderedKeys = [...tslRefKeys, ...defaultKeys];

        const allInputs = orderedKeys
          .filter((key) => exposed.has(key))
          .map((key) => {
            const port = def.inputs.find((p) => p.id === key);
            return {
              id: key,
              dataType: (port?.dataType ?? 'float') as TSLDataType,
              label: port?.label ?? key,
            };
          });

        return (
          <div className="texture-preview-node__ports">
            {allInputs.map((input) => (
              <div key={input.id} className="texture-preview-node__row">
                <TypedHandle
                  type="target"
                  position={Position.Left}
                  id={input.id}
                  dataType={input.dataType}
                  label={input.label}
                />
                <span className="texture-preview-node__port-label">{input.label}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Output handle */}
      <TypedHandle
        type="source"
        position={Position.Right}
        id={def.outputs[0].id}
        dataType={def.outputs[0].dataType}
        label={def.outputs[0].label}
      />
    </div>
  );
});
