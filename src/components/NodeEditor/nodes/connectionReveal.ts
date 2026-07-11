/**
 * Connection-drag proximity reveal — the shared mechanism behind three rules:
 *
 * 1. Nodes with NAMED input sockets force their input name-tooltips visible —
 *    floated to the LEFT of each socket, behind it — while a dragged wire is
 *    hunting nearby, so the user can read every target while aiming
 *    (TypedHandle's `reveal` prop → `.typed-handle--reveal`). Opted OUT:
 *    operator cards (arithmetic, dot/cross/distance — generic a/b operands),
 *    the Output node and collapsed groups (rows already carry permanent
 *    labels). Hover tooltips still work everywhere.
 * 2. Chainable arithmetic nodes expose their NEXT (grow) operand socket
 *    while the wire is near (ShaderNode).
 * 3. Nodes with opt-in `exposedPorts` parameters (noise, Image) additionally
 *    reveal their hidden input sockets as floating dots on the left edge
 *    (RevealSockets.tsx) so any parameter can be wired without exposing it in
 *    the settings menu first. The node's resting layout NEVER changes during
 *    the reveal. Landing a connection makes the exposure permanent
 *    (onConnect/onReconnect auto-expose); releasing elsewhere hides them
 *    again. The OUTPUT node is deliberately excluded — its channels are
 *    exposed only via the shader settings menu.
 *    (NODE_DESIGN_REQUIREMENTS.md → "Exposed parameter sockets".)
 *
 * React Flow can only snap to MOUNTED handles. The reveal radius IS the
 * editor's connection (snap) radius — one constant, imported by NodeEditor —
 * so the socket mounts + re-measures exactly as the wire enters snapping
 * range: same distance, same feel as snapping onto an arithmetic node.
 */

import type { ReactFlowState } from '@xyflow/react';

/** The editor's handle-snap radius (flow px) — passed to <ReactFlow
 *  connectionRadius> by NodeEditor, and the reveal radius: identical by
 *  design, so hidden sockets appear at exactly the distance a wire could
 *  snap to them. Single source of truth. */
export const CONNECTION_RADIUS = 40;

/**
 * Selector → true while an output→input connection is being dragged and its
 * free end sits within `CONNECTION_RADIUS` of node `id`'s box. Returns
 * a plain boolean so React Flow's `useStore` (Object.is equality) re-renders
 * the node only when it crosses the threshold, not on every mousemove.
 */
export function makeConnectionRevealSelector(id: string, enabled: boolean) {
  return (s: ReactFlowState): boolean => {
    if (!enabled) return false;
    const c = s.connection;
    // Only when dragging FROM an output (the free end seeks an input), and never
    // on the node the drag started from — a node can't wire to itself.
    if (!c.inProgress || c.fromHandle.type !== 'source' || c.fromNode.id === id) return false;
    const n = s.nodeLookup.get(id);
    if (!n) return false;
    const { x, y } = n.internals.positionAbsolute;
    const w = n.measured?.width ?? 0;
    const h = n.measured?.height ?? 0;
    // `connection.to` is in RENDERER (screen/pane) pixels, but the node box is in
    // flow coords — convert `to` → flow with the viewport transform first, or the
    // distance is meaningless at any pan/zoom and the socket never reveals. The
    // radius is then in flow units, matching React Flow's own 40px connectionRadius.
    const [vx, vy, scale] = s.transform;
    const fx = (c.to.x - vx) / scale;
    const fy = (c.to.y - vy) / scale;
    const dx = fx < x ? x - fx : fx > x + w ? fx - (x + w) : 0;
    const dy = fy < y ? y - fy : fy > y + h ? fy - (y + h) : 0;
    return dx * dx + dy * dy <= CONNECTION_RADIUS * CONNECTION_RADIUS;
  };
}

/** Opacity for sockets/labels that are only visible because of the reveal —
 *  temporary targets read dimmer than permanently exposed ones. */
export const REVEAL_TEMP_OPACITY = 0.55;
