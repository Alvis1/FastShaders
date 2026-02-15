import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { TSLDataType } from '@/types';
import { getTypeColor } from '@/utils/colorUtils';
import './TypedHandle.css';

interface TypedHandleProps {
  type: 'source' | 'target';
  position: Position;
  id: string;
  dataType: TSLDataType;
  style?: CSSProperties;
}

export function TypedHandle({ type, position, id, dataType, style }: TypedHandleProps) {
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      className="typed-handle"
      style={{ background: getTypeColor(dataType), ...style }}
      isConnectableStart
    />
  );
}
