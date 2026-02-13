import { memo } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getCostColor, getCostScale } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import './ShaderNode.css';

export const ShaderNode = memo(function ShaderNode({
  data,
  selected,
}: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  if (!def) return null;

  const scale = getCostScale(data.cost);
  const bgColor = getCostColor(data.cost);

  return (
    <div
      className={`shader-node ${selected ? 'shader-node--selected' : ''}`}
      style={
        {
          '--node-bg': bgColor,
          '--node-scale': scale,
          minWidth: `calc(var(--node-min-width) * ${scale})`,
        } as React.CSSProperties
      }
    >
      {def.inputs.map((port, i) => (
        <TypedHandle
          key={port.id}
          type="target"
          position={Position.Left}
          id={port.id}
          dataType={port.dataType}
          label={port.label}
          index={i}
          total={def.inputs.length}
        />
      ))}

      <div className="shader-node__body">
        <div className="shader-node__header">
          <span className="shader-node__label">{data.label}</span>
          {data.cost > 0 && (
            <span className="shader-node__cost">{data.cost} pts</span>
          )}
        </div>
        <div className="shader-node__category">{def.category}</div>
      </div>

      {def.outputs.map((port, i) => (
        <TypedHandle
          key={port.id}
          type="source"
          position={Position.Right}
          id={port.id}
          dataType={port.dataType}
          label={port.label}
          index={i}
          total={def.outputs.length}
        />
      ))}
    </div>
  );
});
