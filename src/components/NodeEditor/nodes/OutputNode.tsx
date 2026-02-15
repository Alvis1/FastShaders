import { memo } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { OutputFlowNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getCostColor, getCostScale } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import './OutputNode.css';

export const OutputNode = memo(function OutputNode({
  data,
  selected,
}: NodeProps<OutputFlowNode>) {
  const def = NODE_REGISTRY.get('output')!;
  const cost = data.cost ?? 0;
  const costColor = getCostColor(cost);
  const costScale = getCostScale(cost);

  return (
    <div
      className={`node-base ${selected ? 'node-base--selected' : ''}`}
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      <div className="node-base__header">
        <span className="node-base__dot output-node__dot" />
        <span className="node-base__title">Output</span>
        <span className="node-base__cost">{cost} pts</span>
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
