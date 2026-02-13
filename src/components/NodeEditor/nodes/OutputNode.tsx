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

  return (
    <div
      className={`output-node ${selected ? 'output-node--selected' : ''}`}
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

      <div className="output-node__body">
        <div className="output-node__label">Output</div>
        <div className="output-node__cost">{data.cost} pts total</div>
      </div>
    </div>
  );
});
