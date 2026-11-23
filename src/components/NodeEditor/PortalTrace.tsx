import { useEffect, useState } from 'react';
import { EdgeLabelRenderer, useStore, type ReactFlowState } from '@xyflow/react';
import type { AppNode, TSLDataType } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { getTypeColor } from '@/utils/colorUtils';
import { ghostLines, portalTraceIds, portalTraceKey, tracedEntrances } from './portalWire';
import { passThroughTypeOf } from './nodes/passThroughLook';
import { nodeEl } from './nodeElement';
import './nodes/PassThroughNode.css';

/** The wrapper attribute PassThroughNode.css lights a traced portal end by. */
export const PORTAL_TRACE_ATTR = 'data-fs-portal-trace';

/** The Portal end wrappers' classes (React Flow's `react-flow__node-<type>`). */
const PORTAL_WRAPPER = '.react-flow__node-tunnelIn, .react-flow__node-tunnelOut';

/**
 * THE PORTAL TRACE (docs/dev/canvas-interaction.md, "Portal"): while a Portal
 * end is SELECTED or HOVERED, its entrance and every exit carry
 * `data-fs-portal-trace`, and a GHOST LINE runs from the entrance to each
 * exit — the hidden wire "under the canvas" made visible on demand.
 *
 * - The marks are ATTRIBUTES, for MutedMarks' reasons: mounted INSIDE
 *   `<ReactFlow>` and keyed on React Flow's OWN node list (a wrapper is drawn
 *   a pass after the app's array), and React rewrites a wrapper's whole
 *   `className` on every select/drag.
 * - The ghost line is computed in FLOW coordinates from React Flow's measured
 *   boxes by a SELECTOR that returns a string (a primitive: an unchanged
 *   answer re-renders nothing) — no requestAnimationFrame loop of its own,
 *   no DOM read. It is drawn through `EdgeLabelRenderer`, the layer between
 *   the wires and the nodes, so it runs UNDER every card, with no hit area
 *   (`pointer-events: none`). Dashed, never marching; its short fade-in is a
 *   CSS animation the app-wide reduced-motion rule collapses.
 * - Hover is read by delegation on React Flow's own root (one pointerover
 *   listener), never by NodeEditor's node callbacks — a hover must not
 *   re-render the whole canvas component.
 */
export function PortalTrace() {
  const [hovered, setHovered] = useState<string | null>(null);
  const domNode = useStore((s: ReactFlowState) => s.domNode);

  useEffect(() => {
    if (!domNode) return;
    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(PORTAL_WRAPPER);
      setHovered(el?.getAttribute('data-id') ?? null);
    };
    const onLeave = () => setHovered(null);
    domNode.addEventListener('pointerover', onOver);
    domNode.addEventListener('pointerleave', onLeave);
    return () => {
      domNode.removeEventListener('pointerover', onOver);
      domNode.removeEventListener('pointerleave', onLeave);
    };
  }, [domNode]);

  // Every traced portal end, one id per line (`portalTraceKey`) — '' (no
  // allocation past the scan) while no portal end is selected or hovered.
  const markKey = useStore((s: ReactFlowState) => portalTraceKey(s.nodes as AppNode[], hovered));

  useEffect(() => {
    if (!markKey) return;
    const marked: HTMLElement[] = [];
    for (const id of portalTraceIds(markKey)) {
      const el = nodeEl(id);
      if (!el) continue;
      el.setAttribute(PORTAL_TRACE_ATTR, '');
      marked.push(el);
    }
    return () => {
      for (const el of marked) el.removeAttribute(PORTAL_TRACE_ATTR);
    };
  }, [markKey]);

  // The ghost lines as "entrance\tpath" rows, from the measured boxes. A
  // string, so a frame that moves nothing traced re-renders nothing.
  const lineKey = useStore((s: ReactFlowState) => {
    const nodes = s.nodes as AppNode[];
    const entrances = tracedEntrances(nodes, hovered);
    if (entrances.length === 0) return '';
    const centreOf = (id: string) => {
      const n = s.nodeLookup.get(id);
      const w = n?.measured?.width;
      const h = n?.measured?.height;
      if (!n || !w || !h) return null;
      const p = n.internals.positionAbsolute;
      return { x: p.x + w / 2, y: p.y + h / 2 };
    };
    return ghostLines(nodes, entrances, centreOf).map((l) => `${l.entrance}\t${l.d}`).join('\n');
  });

  // Each traced portal's type colour, as one string (a PRIMITIVE per notify).
  const typeKey = useAppStore((s) => {
    if (!lineKey) return '';
    let out = '';
    // LAST tab: a path holds none, while an adversarial id may hold one.
    for (const row of lineKey.split('\n')) {
      const id = row.slice(0, row.lastIndexOf('\t'));
      out += `${id}\t${passThroughTypeOf(s.nodes, s.edges, id) ?? 'any'}\n`;
    }
    return out;
  });

  if (!lineKey) return null;
  const types = new Map<string, string>();
  for (const row of typeKey.split('\n')) {
    const tab = row.lastIndexOf('\t');
    if (tab > 0) types.set(row.slice(0, tab), row.slice(tab + 1));
  }
  return (
    <EdgeLabelRenderer>
      <svg className="portal-ghost" aria-hidden="true" focusable="false">
        {lineKey.split('\n').map((row, i) => {
          const tab = row.lastIndexOf('\t');
          const entrance = row.slice(0, tab);
          return (
            <path
              key={`${entrance}:${i}`}
              d={row.slice(tab + 1)}
              stroke={getTypeColor((types.get(entrance) ?? 'any') as TSLDataType)}
            />
          );
        })}
      </svg>
    </EdgeLabelRenderer>
  );
}
