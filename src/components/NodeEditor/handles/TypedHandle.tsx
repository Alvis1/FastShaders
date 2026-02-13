import { Handle, Position } from '@xyflow/react';
import type { TSLDataType } from '@/types';
import { getTypeColor } from '@/utils/colorUtils';
import './TypedHandle.css';

interface TypedHandleProps {
  type: 'source' | 'target';
  position: Position;
  id: string;
  dataType: TSLDataType;
}

export function TypedHandle({ type, position, id, dataType }: TypedHandleProps) {
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      className="typed-handle"
      style={{ background: getTypeColor(dataType) }}
    />
  );
}
