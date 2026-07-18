import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { TSLDataType } from '@/types';
import { channelTypeName } from '@/types';
import { getTypeColor } from '@/utils/colorUtils';
import { useAppStore } from '@/store/useAppStore';
import { portLabel } from '@/i18n';
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
  /** Channel count actually ARRIVING on this input (1–4), when an edge is
   *  connected. Appended to the tooltip as its TSL type name so the socket
   *  reports what it receives, not just what it's called. */
  channels?: number;
}

export function TypedHandle({ type, position, id, dataType, label, style, reveal, channels }: TypedHandleProps) {
  // A color IS a vec3 — the evaluator already counts it as 3 channels, so a
  // CONNECTED color reads "vec3". Normalise the declared name to match, or the
  // same socket would say "color" empty and "vec3" wired.
  const declared = dataType === 'color' ? 'vec3' : dataType;
  // Prefer the RESOLVED type of the incoming data; fall back to the port's
  // declared type. `any` is skipped — it's the registry's "whatever fits"
  // placeholder on most arithmetic/math ports, so printing it says nothing.
  const typeName =
    channels != null ? channelTypeName(channels) : declared !== 'any' ? declared : null;
  // Socket display name is translated (Latvian mode); the appended TSL type
  // (vec3, float…) stays canonical. `id` fallbacks (e.g. 'a', 'x') have no
  // translation so portLabel returns them unchanged.
  const language = useAppStore((s) => s.language);
  const name = portLabel(label ?? id, language);
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      className={`typed-handle${reveal ? ' typed-handle--reveal' : ''}`}
      style={{ background: getTypeColor(dataType), ...style }}
      isConnectableStart
      {...{ 'data-tooltip': typeName ? `${name} · ${typeName}` : name }}
    />
  );
}
