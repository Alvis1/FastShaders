import type { AppNode, AppEdge } from '@/types';

/**
 * Pure decision logic for keyboard navigation of the canvas.
 *
 * WHY THIS IS MOSTLY TAMING, NOT BUILDING. React Flow v12 already ships the
 * accessibility layer and this app leaves it ON: `nodesFocusable`,
 * `edgesFocusable` and `disableKeyboardA11y` are unset, so every node wrapper is
 * already `tabIndex=0` with Enter/Space selection and a 5px arrow nudge (20px
 * with Shift). What made it unusable was everything AROUND it — no focus ring
 * anywhere (NodeEditor.css actively strips React Flow's), edges in the tab order
 * so a graph of N nodes and E edges has N+E stops, arrow moves that push no
 * history and do no group reparenting, and a fresh `position` object per press
 * that re-arms the full-graph autosave ~30x/s under auto-repeat.
 *
 * So the rule here is: reuse React Flow's mechanism where it is right, and
 * replace it only where it is wrong. This module holds the decisions; the DOM
 * and store work stays in NodeEditor.
 *
 * COLLAPSED MEMBERS. Nodes inside a collapsed group stay in the `nodes` array
 * carrying `className: 'fs-collapsed-member'` and are hidden with `display:
 * none` (so the React component keeps its rAF loops alive). Native tab order
 * skips them because they are not rendered; any cycle computed from the ARRAY
 * must skip them explicitly or the cursor lands on an invisible node.
 */

/** Set by the store when a node is inside a collapsed group. */
const COLLAPSED_MEMBER_CLASS = 'fs-collapsed-member';

export function isNavigable(n: AppNode): boolean {
  if (n.className?.includes(COLLAPSED_MEMBER_CLASS)) return false;
  // `hidden` is React Flow's own opt-out; nothing in this app sets it today,
  // but honouring it costs one term and keeps this honest if something does.
  return n.hidden !== true;
}

/** Centre of a node in ABSOLUTE space. Parent offsets are resolved by walking
 *  `parentId`, with a `seen` guard because a parent cycle is legal bytes in a
 *  tampered `fs:graph` or a shared `.fastshader`. */
export function nodeCentre(n: AppNode, all: AppNode[]): { x: number; y: number } {
  let x = n.position?.x ?? 0;
  let y = n.position?.y ?? 0;
  const seen = new Set<string>([n.id]);
  let parentId = n.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const p = all.find((c) => c.id === parentId);
    if (!p) break;
    x += p.position?.x ?? 0;
    y += p.position?.y ?? 0;
    parentId = p.parentId;
  }
  const w = (n.width ?? n.measured?.width ?? 150) / 2;
  const h = (n.height ?? n.measured?.height ?? 60) / 2;
  return { x: x + w, y: y + h };
}

/**
 * Tab / Shift+Tab: the next node in a stable, VISUAL order.
 *
 * Left-to-right then top-to-bottom, not array order: the array is creation
 * order, so on any real graph Tab would jump around the canvas at random. A
 * shader graph reads left to right (inputs to Output), so this walks it the way
 * the user reads it. Wraps at both ends — a cursor that stops dead at the last
 * node reads as broken, and there is nowhere else for it to go while Tab is
 * scoped to the canvas.
 */
export function tabOrder(nodes: AppNode[], all: AppNode[] = nodes): AppNode[] {
  return nodes
    .filter(isNavigable)
    .map((n) => ({ n, c: nodeCentre(n, all) }))
    // 24px row banding: nodes within a row read as a row even when their tops
    // differ by a few px, so they should be visited left-to-right rather than
    // by a hairline y difference.
    .sort((a, b) => {
      const rowA = Math.round(a.c.y / 24);
      const rowB = Math.round(b.c.y / 24);
      if (rowA !== rowB) return rowA - rowB;
      if (a.c.x !== b.c.x) return a.c.x - b.c.x;
      return a.n.id < b.n.id ? -1 : 1; // total order, so the cycle is stable
    })
    .map((e) => e.n);
}

export function nextInTabOrder(
  nodes: AppNode[],
  currentId: string | null,
  dir: 1 | -1,
): string | null {
  const order = tabOrder(nodes);
  if (order.length === 0) return null;
  const i = currentId ? order.findIndex((n) => n.id === currentId) : -1;
  if (i === -1) return (dir === 1 ? order[0] : order[order.length - 1]).id;
  return order[(i + dir + order.length) % order.length].id;
}

export type NavDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Cmd/Ctrl+Arrow: move the selection ALONG THE GRAPH.
 *
 * Left and right follow the wires — right goes downstream (toward the Output),
 * left goes upstream (toward the inputs) — because that is what "next" and
 * "previous" mean in a shader graph, and following a wire by keyboard is the
 * thing a pointer user does by eye. Up and down are spatial, moving between
 * parallel branches, since a graph has no vertical edges to follow.
 *
 * Falls back to spatial when there is no wire in that direction, so the key
 * always does SOMETHING as long as another node lies that way — a modifier that
 * silently no-ops reads as the app being broken, which is the rule the Output
 * singleton and the WGSL toggle both follow.
 */
export function traverseGraph(
  nodes: AppNode[],
  edges: AppEdge[],
  currentId: string,
  dir: NavDirection,
): string | null {
  const navigable = nodes.filter(isNavigable);
  const current = navigable.find((n) => n.id === currentId);
  if (!current) return null;
  const here = nodeCentre(current, nodes);
  const byId = new Map(navigable.map((n) => [n.id, n]));

  if (dir === 'left' || dir === 'right') {
    const wired = edges
      .filter((e) => (dir === 'right' ? e.source === currentId : e.target === currentId))
      .map((e) => byId.get(dir === 'right' ? e.target : e.source))
      .filter((n): n is AppNode => n != null && n.id !== currentId);
    if (wired.length > 0) {
      // Several wires leave the same node: take the one closest in Y, so
      // repeated presses walk the branch the eye would follow.
      return wired
        .map((n) => ({ n, d: Math.abs(nodeCentre(n, nodes).y - here.y) }))
        .sort((a, b) => a.d - b.d || (a.n.id < b.n.id ? -1 : 1))[0].n.id;
    }
  }

  // Spatial fallback (and the only rule for up/down): the nearest node in that
  // half-plane, scoring the off-axis distance at half weight so a node roughly
  // in line wins over a closer one far off to the side.
  const axis = dir === 'left' || dir === 'right' ? 'x' : 'y';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  let best: { id: string; score: number } | null = null;
  for (const n of navigable) {
    if (n.id === currentId) continue;
    const c = nodeCentre(n, nodes);
    const along = (axis === 'x' ? c.x - here.x : c.y - here.y) * sign;
    if (along <= 0) continue;
    const off = axis === 'x' ? Math.abs(c.y - here.y) : Math.abs(c.x - here.x);
    const score = along + off * 2;
    if (!best || score < best.score || (score === best.score && n.id < best.id)) {
      best = { id: n.id, score };
    }
  }
  return best ? best.id : null;
}

/**
 * Arrow move deltas. Matches React Flow's own velocity (5px, ×4 with Shift) so
 * that replacing its handler does not change how far a press moves a node —
 * only what happens around the move (history, reparenting, autosave).
 */
export const ARROW_STEP = 5;
export const ARROW_SHIFT_FACTOR = 4;

export function arrowDelta(key: string, shift: boolean): { dx: number; dy: number } | null {
  const step = ARROW_STEP * (shift ? ARROW_SHIFT_FACTOR : 1);
  switch (key) {
    case 'ArrowLeft': return { dx: -step, dy: 0 };
    case 'ArrowRight': return { dx: step, dy: 0 };
    case 'ArrowUp': return { dx: 0, dy: -step };
    case 'ArrowDown': return { dx: 0, dy: step };
    default: return null;
  }
}

export function arrowDirection(key: string): NavDirection | null {
  switch (key) {
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    default: return null;
  }
}

/**
 * The panes Alt/Option+Left/Right cycles between.
 *
 * Order is the app's own reading order — the toolbar across the top, then the
 * left column, then the right column top to bottom. Each entry names a
 * container that the wiring makes focusable; the 3D preview deliberately points
 * at its WRAPPER and never at the <iframe>, because the preview is a sandboxed
 * cross-origin document and once focus enters it no parent keydown fires at all
 * — including the Alt+Arrow meant to leave again.
 */
export interface PaneDef {
  id: string;
  /** Selector for the container that receives focus. */
  selector: string;
  /** Spoken name, used for the pane's aria-label. English key; t() at the call site. */
  label: string;
}

export const PANES: readonly PaneDef[] = [
  { id: 'toolbar', selector: '.toolbar', label: 'Toolbar' },
  { id: 'canvas', selector: '.node-editor__canvas', label: 'Node canvas' },
  { id: 'assets', selector: '.content-browser', label: 'Asset browser' },
  { id: 'preview', selector: '.shader-preview', label: '3D preview' },
  { id: 'code', selector: '.app-layout__code', label: 'Code editor' },
] as const;

/** Next pane id, skipping any that is not currently in the DOM (the code panel
 *  is lazy, the asset bar can be collapsed to nothing, and the desktop build
 *  hides controls the web build shows). `present` is asked per candidate rather
 *  than filtered up front so the cycle never returns a pane that just left. */
export function nextPane(
  currentId: string | null,
  dir: 1 | -1,
  present: (p: PaneDef) => boolean,
): PaneDef | null {
  const i = currentId ? PANES.findIndex((p) => p.id === currentId) : -1;
  for (let step = 1; step <= PANES.length; step++) {
    const idx = (i + dir * step + PANES.length * step) % PANES.length;
    const cand = PANES[idx];
    if (present(cand)) return cand;
  }
  return null;
}
