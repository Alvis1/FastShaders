import { Position } from '@xyflow/react';
import { TypedHandle } from '../handles/TypedHandle';
import { REVEAL_TEMP_OPACITY } from './connectionReveal';
import type { TSLDataType } from '@/types';

export interface RevealPort {
  id: string;
  dataType: TSLDataType;
  label: string;
}

/** Distribute n reveal sockets along the left edge, centered (25%–75% of the
 *  card height — clear of the header, same band PreviewNode uses). */
function slotTop(i: number, n: number): string {
  if (n === 1) return '50%';
  return `${25 + (i * 50) / (n - 1)}%`;
}

/**
 * Drag-reveal sockets: the still-hidden `exposedPorts` inputs of a node,
 * rendered as dimmed floating handles on the left edge while a wire is being
 * dragged nearby. They are positioned absolutely against the card — the
 * node's resting layout (rows, thumbnail, sections) NEVER changes — and each
 * carries its name-tooltip forced visible to its left (`reveal` prop), so the
 * user can read every target and watch the wire snap. Landing a connection
 * exposes that port permanently (onConnect/onReconnect auto-expose).
 */
export function RevealSockets({ ports }: { ports: RevealPort[] }) {
  return (
    <>
      {ports.map((p, i) => (
        <TypedHandle
          key={p.id}
          type="target"
          position={Position.Left}
          id={p.id}
          dataType={p.dataType}
          label={p.label}
          reveal
          style={{ top: slotTop(i, ports.length), opacity: REVEAL_TEMP_OPACITY }}
        />
      ))}
    </>
  );
}
