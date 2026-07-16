import { memo, useEffect } from 'react';
import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import type { OutputFlowNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostTextColor, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import './OutputNode.css';

/** Ports that belong to the pixel (fragment) shader section */
const PIXEL_PORTS = ['color', 'emissive', 'normal', 'opacity', 'roughness', 'discard'];
/** Ports that belong to the vertex shader section */
const VERTEX_PORTS = ['position'];
// Single source of truth lives with the shared exposedPorts rules; re-exported
// here for the existing importers (ShaderSettingsMenu, NodeEditor).
export { OUTPUT_DEFAULT_EXPOSED };

export const OutputNode = memo(function OutputNode({
  id,
  data,
  selected,
}: NodeProps<OutputFlowNode>) {
  const def = NODE_REGISTRY.get('output')!;
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const cost = data.cost ?? 0;
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);

  const exposedPorts = data.exposedPorts ?? OUTPUT_DEFAULT_EXPOSED;
  const exposedSet = new Set(exposedPorts);

  // The Output node opts out of ALL drag-proximity behavior: no hidden-channel
  // reveal (channels are exposed only via the shader settings menu, or
  // auto-exposed when an edge arrives through sync/import) and no forced
  // name-tooltips (its rows already carry permanent labels). Hover tooltips
  // still work.

  // Tell React Flow to re-measure handles whenever the RENDERED port set
  // changes (settings toggle). Without this, dynamically mounted handles
  // (e.g. `emissive` after the user toggles it on) aren't in React Flow's
  // bounds map, so any edge connected to them silently fails to render until
  // the page is reloaded.
  const updateNodeInternals = useUpdateNodeInternals();
  const exposedKey = exposedPorts.join('|');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, exposedKey, updateNodeInternals]);

  // Only permanently exposed channels render (as rows) — no drag reveal here.
  const sectionPorts = (ids: string[]) =>
    def.inputs.filter((p) => ids.includes(p.id) && exposedSet.has(p.id));
  const pixelPorts = sectionPorts(PIXEL_PORTS);
  const vertexPorts = sectionPorts(VERTEX_PORTS);

  return (
    <div
      className={`output-node ${selected ? 'output-node--selected' : ''}`}
      style={{ background: 'var(--node-bg)', border: '1.5px solid var(--cat-output)' }}
    >
      {/* Bare number, matching every ShaderNode badge — the unit is spelled out
          once on the CostBar meter rather than repeated on every node. */}
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>
          {cost}
        </span>
      )}

      {/* Main header */}
      <div className="output-node__header" style={{ background: costColor }}>
        <span className="output-node__title" style={{ color: headerTextColor }}>Output</span>
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
