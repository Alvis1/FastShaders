import { memo } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { OutputFlowNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { TypedHandle } from '../handles/TypedHandle';
import './OutputNode.css';

export const OutputNode = memo(function OutputNode({
  data,
  selected,
}: NodeProps<OutputFlowNode>) {
  const def = NODE_REGISTRY.get('output')!;
  const costLabel = `${data.cost} pts`;

  return (
    <div className={`output-node ${selected ? 'output-node--selected' : ''}`}>
      {/* Header */}
      <div className="output-node__header">
        <span className="output-node__dot" />
        <span className="output-node__title">Output</span>
        <span className="output-node__cost">{costLabel}</span>
      </div>

      {/* Input port rows (outputs-only terminal node) */}
      <div className="output-node__body">
        {def.inputs.map((port) => (
          <div key={port.id} className="output-node__row">
            <TypedHandle
              type="target"
              position={Position.Left}
              id={port.id}
              dataType={port.dataType}
            />
            <span className="output-node__port-label">{port.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
