import { Handle, Position } from '@xyflow/react';
import type { TSLDataType } from '@/types';
import { getTypeColor } from '@/utils/colorUtils';
import './TypedHandle.css';

interface TypedHandleProps {
  type: 'source' | 'target';
  position: Position;
  id: string;
  dataType: TSLDataType;
  label: string;
  index: number;
  total: number;
}

export function TypedHandle({
  type,
  position,
  id,
  dataType,
  label,
  index,
  total,
}: TypedHandleProps) {
  const topPercent = ((index + 1) / (total + 1)) * 100;

  return (
    <div className="typed-handle-wrapper" style={{ top: `${topPercent}%` }}>
      {type === 'target' && (
        <span className="typed-handle-label typed-handle-label--left">{label}</span>
      )}
      <Handle
        type={type}
        position={position}
        id={id}
        className="typed-handle"
        style={{
          background: getTypeColor(dataType),
        }}
        title={`${label} (${dataType})`}
      />
      {type === 'source' && (
        <span className="typed-handle-label typed-handle-label--right">{label}</span>
      )}
    </div>
  );
}
