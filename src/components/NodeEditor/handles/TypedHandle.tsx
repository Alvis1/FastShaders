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
  label?: string;
  style?: CSSProperties;
  /** Drag-reveal mode: force the name-tooltip visible, floated to the LEFT of
   *  the socket (behind it), so every input target is readable while a wire
   *  is hunting nearby. See connectionReveal.ts. */
  reveal?: boolean;
}

export function TypedHandle({ type, position, id, dataType, label, style, reveal }: TypedHandleProps) {
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      className={`typed-handle${reveal ? ' typed-handle--reveal' : ''}`}
      style={{ background: getTypeColor(dataType), ...style }}
      isConnectableStart
      {...{ 'data-tooltip': label ?? id }}
    />
  );
}
