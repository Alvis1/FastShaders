import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
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

/** How long a touch-tapped socket keeps its tooltip up. */
const TAP_TOOLTIP_MS = 2500;

// At most ONE tap-shown tooltip is live app-wide (a new tap dismisses the
// previous one), and NodeEditor dismisses it when a real gesture begins —
// wire drag, node drag (drag-connect previews force tooltips of their own),
// two-finger nav — so a stale tap label can never sit next to a drag-connect
// preview's label and muddy which socket the drop will commit to. Same
// transient module-level flag pattern as edgeDisconnectFlag.ts.
let activeTapClear: (() => void) | null = null;

/** Dismiss the live tap-shown socket tooltip, if any. */
export function clearSocketTapTooltip() {
  activeTapClear?.();
}

export function TypedHandle({ type, position, id, dataType, label, style, reveal, channels }: TypedHandleProps) {
  // Touch has no hover, so a direct tap on the socket shows its own tooltip
  // briefly (selecting the node no longer pins every label — see the CSS).
  // Gated per-gesture on pointerType rather than a media query: iPadOS
  // desktop-mode Safari reports (pointer: fine). The class rides React STATE
  // (className prop), not an imperative classList.add: React Flow re-renders
  // the handle with dynamic connection classes (connectingfrom etc.) the
  // moment a tap starts a connection, and that className rewrite would wipe
  // an imperatively-added token — a prop-driven class survives it. No
  // stopPropagation — React Flow's connection-start on this same pointerdown
  // must keep working.
  const [tapped, setTapped] = useState(false);
  const ownTapClearRef = useRef<(() => void) | null>(null);
  useEffect(() => () => ownTapClearRef.current?.(), []);
  // A wire hunting nearby forces this tooltip via reveal anyway; clearing the
  // tap here means the label doesn't linger above the socket after the wire
  // leaves (and the reveal↔tapped position handoff never ping-pongs).
  useEffect(() => {
    if (reveal) ownTapClearRef.current?.();
  }, [reveal]);
  const handleTapPointerDown = useCallback((e: ReactPointerEvent) => {
    // !isPrimary: the second finger of a pinch landing on a socket is
    // navigation, not a tap.
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    activeTapClear?.();
    let timer: number | undefined;
    const clear = () => {
      window.clearTimeout(timer);
      setTapped(false);
      if (activeTapClear === clear) activeTapClear = null;
      if (ownTapClearRef.current === clear) ownTapClearRef.current = null;
    };
    setTapped(true);
    timer = window.setTimeout(clear, TAP_TOOLTIP_MS);
    activeTapClear = clear;
    ownTapClearRef.current = clear;
  }, []);
  const handleTapPointerCancel = useCallback(() => {
    ownTapClearRef.current?.();
  }, []);
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
      className={`typed-handle${reveal ? ' typed-handle--reveal' : ''}${tapped ? ' typed-handle--tapped' : ''}`}
      style={{ background: getTypeColor(dataType), ...style }}
      onPointerDown={handleTapPointerDown}
      onPointerCancel={handleTapPointerCancel}
      isConnectableStart
      {...{ 'data-tooltip': typeName ? `${name} · ${typeName}` : name }}
    />
  );
}
