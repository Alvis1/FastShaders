/**
 * Where a Preset or Texture lands, and — for a PRESS — what it is wired to.
 *
 * Every add (press or drag, wired or not) takes the nearest spot that overlaps
 * nothing already drawn (`freeFrameSpot`), and the view then makes sure the
 * frame's TOP-RIGHT corner shows (`revealCornerViewport`, owner 2026-10-17):
 * that corner is where the asset's last node sits, the one an Output wire
 * leaves from.
 *
 * A PRESSED Preset or Texture tile lands beside the Output, wired into every
 * socket of it that is still EMPTY (owner, 2026-10-16; per socket 2026-10-17).
 *
 * The wiring is not guessed: every built-in asset is TSL whose `return` names
 * its Output channels, and `buildCodeGroup` keeps those wires as the asset's
 * `outputEdges` when it drops the parsed Output. This module only decides
 * WHETHER a press may use them and re-targets them at the live node.
 *
 * Per SOCKET: a displacement preset (`{ position: height }`) still wires into
 * an empty Displacement when Color is already fed, and a socket that has a
 * wire is never touched. Press only — a DRAG lands where the user let go and
 * is never wired. A press whose sockets are ALL taken falls back to the
 * scattered, unwired add.
 */

import type { AppEdge, AppNode } from '@/types';
import { activeSink } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { absoluteNodePosition, groupFrameSize, isCollapsedMember, measuredNodeSize } from '@/utils/groupFrame';
import { effectiveExposedPorts } from '@/utils/exposedPorts';
import { generateEdgeId } from '@/utils/idGenerator';

/** Flow-px gap between the placed frame's right edge and the Output's left. */
export const LIBRARY_WIRE_GAP = 80;

/** Flow-px clearance the placed frame keeps from anything already on the canvas. */
export const LIBRARY_PLACE_PAD = 24;

/** Screen px a revealed corner keeps from the canvas edges and its chrome. */
export const LIBRARY_REVEAL_MARGIN = 40;

/** Where a corner that had to be brought into view lands, as a share of the
 *  canvas: right of centre and a quarter down, so the frame hangs left and
 *  down into the view and a wired Output still fits to its right. */
const REVEAL_AT = { x: 0.6, y: 0.25 } as const;

/** An axis-aligned box in flow coordinates. */
export interface FlowBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What a placed frame must not land on: every node that is DRAWN, as it is
 * drawn — a group by its frame (a collapsed one is its pill), anything else by
 * its measured box, both at ABSOLUTE positions. Members hidden in a collapsed
 * group are skipped; their pill stands for them.
 */
export function placementObstacles(nodes: readonly AppNode[]): FlowBox[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: FlowBox[] = [];
  for (const n of nodes) {
    if (isCollapsedMember(n)) continue;
    const at = absoluteNodePosition(n, byId);
    const { w, h } = n.type === 'group' ? groupFrameSize(n) : measuredNodeSize(n);
    if (![at.x, at.y, w, h].every(Number.isFinite)) continue;
    out.push({ x: at.x, y: at.y, w, h });
  }
  return out;
}

function overlaps(a: FlowBox, b: FlowBox, pad: number): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/**
 * The top-left corner nearest `ideal` where a `ideal.w × ideal.h` frame
 * touches none of `obstacles` (with `pad` clearance).
 *
 * Candidates are the ideal spot itself plus every spot flush against an
 * obstacle's edge — just above it, just below it, just left of it — combined
 * per axis, so the frame slides PAST a group rather than creeping by a step.
 * The nearest free one wins (ties: the earlier candidate, i.e. the ideal
 * column and row first). Always answers: a column left of everything is free.
 */
export function freeFrameSpot(
  ideal: FlowBox,
  obstacles: readonly FlowBox[],
  pad = LIBRARY_PLACE_PAD,
): { x: number; y: number } {
  const free = (x: number, y: number) =>
    !obstacles.some((b) => overlaps({ x, y, w: ideal.w, h: ideal.h }, b, pad));
  if (free(ideal.x, ideal.y)) return { x: ideal.x, y: ideal.y };
  // Only the edges of obstacles near the ideal column/row can matter for the
  // nearest answer, but the full set is small (top-level boxes) and exact.
  const xs = [ideal.x, ...obstacles.map((b) => b.x - ideal.w - pad)].filter((x) => x <= ideal.x);
  const ys = [ideal.y, ...obstacles.flatMap((b) => [b.y + b.h + pad, b.y - ideal.h - pad])];
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const d = Math.hypot(x - ideal.x, y - ideal.y);
      if (d >= bestD || !free(x, y)) continue;
      best = { x, y };
      bestD = d;
    }
  }
  if (best) return best;
  // Left of every obstacle, on the ideal row — free by construction.
  const leftmost = Math.min(ideal.x, ...obstacles.map((b) => b.x - ideal.w - pad));
  return { x: leftmost, y: ideal.y };
}

/** A React Flow viewport transform: screen = flow × zoom + (x, y). */
export interface ViewTransform {
  x: number;
  y: number;
  zoom: number;
}

/**
 * The viewport that shows a placed frame's TOP-RIGHT corner, or null when the
 * corner already shows — so a press that lands in view moves nothing.
 *
 * "Shows" is inside the canvas by LIBRARY_REVEAL_MARGIN and clear of every
 * `chrome` box (canvas px — the cost pill owns the top-right corner, exactly
 * where a corner nudged into view would otherwise land). A corner that does
 * not show is panned to REVEAL_AT, pushed below any chrome box covering that
 * spot; the zoom is kept.
 */
export function revealCornerViewport(
  corner: { x: number; y: number },
  view: ViewTransform,
  canvas: { w: number; h: number },
  chrome: readonly FlowBox[] = [],
): ViewTransform | null {
  const m = LIBRARY_REVEAL_MARGIN;
  const under = (x: number, y: number) =>
    chrome.find((b) => x > b.x - m && x < b.x + b.w + m && y > b.y - m && y < b.y + b.h + m);
  const sx = corner.x * view.zoom + view.x;
  const sy = corner.y * view.zoom + view.y;
  if (sx >= m && sx <= canvas.w - m && sy >= m && sy <= canvas.h - m && !under(sx, sy)) return null;
  const tx = canvas.w * REVEAL_AT.x;
  let ty = canvas.h * REVEAL_AT.y;
  const cover = under(tx, ty);
  if (cover) ty = cover.y + cover.h + m;
  return { x: tx - corner.x * view.zoom, y: ty - corner.y * view.zoom, zoom: view.zoom };
}

/**
 * The Output a pressed library group may wire into, or null for today's add.
 *
 * It is the graph's ACTIVE sink (asked over the UNWRAPPED edges, the way every
 * engine reads the graph), and only when that is a plain Output: an asset's
 * channels are material channels, which a Raymarch or Splat Output does not
 * have. An Output inside a collapsed group is skipped — a wire into it would
 * never draw. Whether any of ITS sockets is free depends on the asset, so that
 * is asked once the library has loaded (`takenOutputChannels`).
 */
export function libraryWireOutput(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
): AppNode | null {
  const unwrapped = unwrapCollapsedGroupEdges(nodes as AppNode[], edges as AppEdge[]);
  const sink = activeSink(nodes, unwrapped);
  if (!sink || sink.data.registryType !== 'output') return null;
  if (isCollapsedMember(sink)) return null;
  return sink;
}

/** The Output sockets that already have a wire, read on the UNWRAPPED graph so
 *  a wire arriving from a collapsed group's pill counts as the socket's own. */
export function takenOutputChannels(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  outputId: string,
): Set<string> {
  const taken = new Set<string>();
  for (const e of unwrapCollapsedGroupEdges(nodes as AppNode[], edges as AppEdge[])) {
    if (e.target === outputId && e.targetHandle) taken.add(e.targetHandle);
  }
  return taken;
}

/**
 * The asset's Output wires, re-pointed from the clone's members (`idMap`, old
 * id → fresh id) to the live Output, skipping every socket in `taken` (those
 * already wired — a press never replaces a wire). A wire whose source the
 * clone did not mint is dropped rather than left pointing at an
 * asset-internal id.
 */
export function libraryWireEdges(
  outputEdges: readonly AppEdge[],
  idMap: ReadonlyMap<string, string>,
  outputId: string,
  taken: ReadonlySet<string> = new Set(),
): AppEdge[] {
  const out: AppEdge[] = [];
  const used = new Set(taken);
  for (const e of outputEdges) {
    const source = idMap.get(e.source);
    const handle = e.targetHandle;
    // Inputs are single-connection: one wire per channel, the first wins.
    if (!source || !handle || used.has(handle)) continue;
    used.add(handle);
    out.push({
      ...structuredClone(e),
      id: generateEdgeId(source, e.sourceHandle ?? 'out', outputId, handle),
      source,
      target: outputId,
      selected: false,
    });
  }
  return out;
}

/**
 * The Output with every wired channel exposed — a FRESH node — or the same
 * node when all of them already are. Unions from the EFFECTIVE list, so
 * exposing `discard` cannot hide the default channels (exposeConnectedTarget's
 * rule, edgeInsert.ts).
 */
export function exposeWiredChannels(output: AppNode, handles: readonly string[]): AppNode {
  const current = effectiveExposedPorts(output);
  const missing = handles.filter((h, i) => !current.includes(h) && handles.indexOf(h) === i);
  if (missing.length === 0) return output;
  return { ...output, data: { ...output.data, exposedPorts: [...current, ...missing] } } as AppNode;
}
