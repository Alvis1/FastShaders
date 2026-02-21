import { memo } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { OutputFlowNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getCostColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import './OutputNode.css';

export const OutputNode = memo(function OutputNode({
  data,
  selected,
}: NodeProps<OutputFlowNode>) {
  const def = NODE_REGISTRY.get('output')!;
  const cost = data.cost ?? 0;
  const costColor = getCostColor(cost);

  return (
    <div
      className={`node-base ${selected ? 'node-base--selected' : ''}`}
      style={{ background: costColor }}
    >
      {/* Cost badge above node */}
      {cost > 0 && <span className="node-base__cost-badge">{cost} pts</span>}

      <div className="node-base__header" style={{ borderLeft: '3px solid var(--cat-output)' }}>
        <span className="node-base__title">Output</span>
      </div>

      <div className="node-base__body">
        {def.inputs.map((port) => (
          <div key={port.id} className="node-base__row">
            <TypedHandle
              type="target"
              position={Position.Left}
              id={port.id}
              dataType={port.dataType}
            />
            <span className="node-base__port-label">{port.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
