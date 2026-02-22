import { memo } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { OutputFlowNode, OutputNodeData } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostTextColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import './OutputNode.css';

/** Ports that belong to the pixel (fragment) shader section */
const PIXEL_PORTS = ['color', 'emissive', 'normal', 'opacity', 'roughness'];
/** Ports that belong to the vertex shader section */
const VERTEX_PORTS = ['position'];
/** Ports always visible by default (no need to expose via settings) */
export const OUTPUT_DEFAULT_EXPOSED = ['color', 'roughness', 'position'];

export const OutputNode = memo(function OutputNode({
  data,
  selected,
}: NodeProps<OutputFlowNode>) {
  const def = NODE_REGISTRY.get('output')!;
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const cost = data.cost ?? 0;
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);

  const exposedPorts = (data as OutputNodeData).exposedPorts ?? OUTPUT_DEFAULT_EXPOSED;
  const exposedSet = new Set(exposedPorts);

  const pixelPorts = def.inputs.filter(
    (p) => PIXEL_PORTS.includes(p.id) && exposedSet.has(p.id)
  );
  const vertexPorts = def.inputs.filter(
    (p) => VERTEX_PORTS.includes(p.id) && exposedSet.has(p.id)
  );

  return (
    <div
      className={`output-node ${selected ? 'output-node--selected' : ''}`}
      style={{ background: costColor }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>
          {cost} pts
        </span>
      )}

      {/* Main header */}
      <div className="output-node__header">
        <span className="output-node__title">Output</span>
      </div>

      {/* Pixel Shader section */}
      <div className="output-node__section">
        <div className="output-node__section-label">Pixel Shader</div>
        <div className="output-node__ports">
          {pixelPorts.map((port) => (
            <div key={port.id} className="output-node__row">
              <TypedHandle
                type="target"
                position={Position.Left}
                id={port.id}
                dataType={port.dataType}
                label={port.label}
              />
              <span className="output-node__port-label">{port.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div className="output-node__divider" />

      {/* Vertex Shader section */}
      <div className="output-node__section">
        <div className="output-node__section-label">Vertex Shader</div>
        <div className="output-node__ports">
          {vertexPorts.map((port) => (
            <div key={port.id} className="output-node__row">
              <TypedHandle
                type="target"
                position={Position.Left}
                id={port.id}
                dataType={port.dataType}
                label={port.label}
              />
              <span className="output-node__port-label">{port.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
