/**
 * Shared builder for code-defined asset groups (built-in textures and presets).
 *
 * Each asset is TSL code parsed into a node graph via codeToGraph on first use,
 * then wrapped in a group container so it can be dragged onto the canvas like
 * a saved group. Extracted from builtinTextures.ts when the Presets library
 * arrived, so both libraries stay one implementation.
 *
 * The static `codeToGraph` import below is what makes this module (and the two
 * libraries that import it) Babel-bearing: the main app reaches all three only
 * through `import()`, which keeps `vendor-babel` off its entry wave.
 */

import type { AppNode, AppEdge, GroupNodeData } from '@/types';
import { codeToGraph } from '@/engine/codeToGraph';
import { autoLayout, estimateNodeSize, socketOrder, wireInversions, type SocketRank } from '@/engine/layoutEngine';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { costOverridesKey } from '@/utils/costTable';
import { getDeviceBudget } from '@/utils/budgetPoints';

/**
 * What a built group's LAYOUT was measured under. autoLayout sizes every
 * cost-scaled card at its LIVE price as a share of the selected device's
 * budget (layoutEngine `drawnCostScale`), so a library laid out under one
 * device's prices or budget and placed under another lands with its painted
 * cards off the boxes it reserved: under a 100-point profile picked after the
 * library was built, each stacked Perlin's badge painted ~13 px over the card
 * above it (review, 2026-10-23). The built-in libraries key their cache on
 * this and rebuild when it moves — a device change, once, on the next use (a
 * cold build of both is ~0.2 s).
 */
export function layoutPricingKey(): string {
  return `${getDeviceBudget()}|${costOverridesKey()}`;
}

export interface CodeGroupEntry {
  id: string;
  name: string;
  color: string;
  code: string;
  description: string;
  titleSize?: number;
  /**
   * Optional explainer pinned INSIDE the group frame, above the graph. Notes
   * are ordinary group members (see the Groups convention in CLAUDE.md) and
   * are inert for every engine path — graphToCode emits byte-identical code
   * with or without one — so this is presentation only.
   */
  note?: { heading: string; text: string };
}

export interface CodeGroupAsset extends CodeGroupEntry {
  /**
   * The members' `data.cost` stamps summed, in table points, under whatever
   * table was ACTIVE when the library was built — once a session. A tile
   * neither prints nor sorts by it: `assetCostPoints(nodes)` (utils/nodeCost.ts)
   * re-reads the same sum under the selected device's table, and equals this
   * on the shipped one.
   */
  totalCost: number;
  nodes: AppNode[];
  edges: AppEdge[];
  /**
   * The wires the asset's own code sent into its Output, kept when the Output
   * itself is dropped: source = a member, targetHandle = the channel the code
   * returned (`return result` → color, `{ position: height }` → position). A
   * PRESS onto a graph whose Output has no wires re-targets them at the live
   * Output (utils/libraryAutoWire.ts), so nothing ever guesses a "last node".
   * The `target` is the parsed Output's id and means nothing outside here.
   */
  outputEdges: AppEdge[];
}

/**
 * Parse an entry's TSL code into nodes/edges, wrap in a group container, and
 * apply auto-layout. `groupIdPrefix` keeps the container ids of the two
 * libraries distinct (`builtin-texture-` / `builtin-preset-`).
 */
/**
 * The socket ROW of each wire's target — its index among the inputs the node
 * renders (the registry def's `inputs`; the Output's channel rows for the
 * dropped Output). A handle the def does not list (a noise node's exposed
 * `pos`) ties at the bottom.
 */
function socketRanks(nodes: readonly AppNode[], outputIds: ReadonlySet<string>): SocketRank {
  const rowsOf = (type: string) =>
    new Map((NODE_REGISTRY.get(type)?.inputs ?? []).map((p, i) => [p.id, i] as const));
  const rows = new Map<string, Map<string, number>>();
  for (const n of nodes) rows.set(n.id, rowsOf(String(n.data.registryType)));
  for (const id of outputIds) rows.set(id, rowsOf('output'));
  return (target, handle) => rows.get(target)?.get(handle ?? '') ?? 99;
}

export interface CodeGroupOptions {
  /**
   * Also try the SOCKET-ordered layout and keep it when fewer wires cross —
   * see the layout step below. Opt-in, for the beginner recipes only: it
   * trades the flat top spine (the wired node on the top row, where a press's
   * top-right reveal and the intro's budget slide find it) for wires that
   * never cross, which only a small frame can afford.
   */
  socketOrdered?: boolean;
}

export function buildCodeGroup(
  entry: CodeGroupEntry,
  groupIdPrefix: string,
  options: CodeGroupOptions = {},
): CodeGroupAsset {
  const { nodes: rawNodes, edges: rawEdges } = codeToGraph(entry.code);

  // Filter out the output node — these are sub-graphs, not full shaders
  const nodes = rawNodes.filter((n) => n.data.registryType !== 'output');
  const nodeIds = new Set(nodes.map((n) => n.id));
  const outputIds = new Set(
    rawNodes.filter((n) => n.data.registryType === 'output').map((n) => n.id),
  );
  const edges = rawEdges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );
  const outputEdges = rawEdges.filter(
    (e) => nodeIds.has(e.source) && outputIds.has(e.target) && !!e.targetHandle,
  );

  // Sum node costs
  const totalCost = nodes.reduce((sum, n) => {
    return sum + ((n.data as { cost?: number }).cost ?? 0);
  }, 0);

  // Auto-layout with tight spacing for compact groups. dagre knows nothing
  // about SOCKETS, so it can stack two feeders of one node upside down: the
  // Ghost recipe put its Opacity feeder above its Color one, and Mix Two
  // Colors put the Fresnel feeding Mix's Factor (the bottom socket) above the
  // two Colors feeding A and B — the wires crossed (owner, 2026-10-20). With
  // `socketOrdered`, the socket-ordered layout (`socketOrder`, walking back
  // from the dropped Output's wires) is tried too and kept only when FEWER
  // wires cross (`wireInversions`, the Output's included); a tie keeps the
  // plain layout. It is opt-in because ordering switches off the spine float:
  // the wired node leaves the top row (measured across the library: ~130px
  // down in a typical preset, 315px in Gas Giant, 695px in Crumpled Fabric),
  // which a press's top-right reveal and the intro's budget slide rely on —
  // a recipe's frame is small enough to be on screen whole.
  const spacing = { nodesep: 10, ranksep: 30 };
  const plain = autoLayout(nodes, edges, spacing);
  let laid = plain;
  if (options.socketOrdered) {
    const rank = socketRanks(nodes, outputIds);
    const wires = [...edges, ...outputEdges];
    const ordered = autoLayout(nodes, edges, spacing, socketOrder(wires, outputEdges, rank));
    if (wireInversions(ordered, wires, rank) < wireInversions(plain, wires, rank)) laid = ordered;
  }

  // A wired param socket must be a visible one — the same hook every ingestion path runs.
  autoExposeConnectedParamPorts(laid, edges);

  // Compute bounding box for the group container from each node's real
  // estimated footprint (a flat placeholder here would clip the tall noise
  // PreviewNodes at the frame's bottom edge).
  const PAD = 20;
  /**
   * The frame's header band, which is drawn INSIDE the group box (GroupNode.css
   * `.group-node__header`, 22px, scaled by `titleSize`). It was missing from
   * this calculation entirely: members were laid out at `PAD` (20px) from the
   * top while the header occupied the first 22px, so every top-row node — and,
   * a further 14px above that, its cost badge — was painted over the title bar.
   *
   * BADGE_CLEARANCE mirrors createGroupFromSelection: a cost badge sits at
   * `top: -14px` and rides the card's cost-scale transform (up to 1.35x), so it
   * needs its own band above the card rather than borrowing the header's.
   */
  const HEADER_H = 22 * Math.max(1, entry.titleSize ?? 1);
  const BADGE_CLEARANCE = 14;
  const TOP_PAD = PAD + HEADER_H + BADGE_CLEARANCE;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of laid) {
    const s = estimateNodeSize(n);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + s.width);
    maxY = Math.max(maxY, n.position.y + s.height);
  }

  /**
   * The explainer note occupies its own band ABOVE the graph, so it reads
   * first and the LR layout underneath is untouched. It spans the graph's
   * width (floored at NOTE_MIN_W so a two-node preset still gets a readable
   * box) and pushes the whole graph down by its height + a gap.
   */
  const NOTE_MIN_W = 260;
  /**
   * Capped, or a wide graph (the biggest preset lays out ~2100px) stretches the
   * note into a near-empty band the width of the screen. At 560 a 200-char note
   * is ~3 lines, so it reads as a caption card pinned top-left of the frame.
   */
  const NOTE_MAX_W = 560;
  /**
   * Tall enough that a 200-char note (the authoring cap) fits without the body
   * textarea scrolling — a pinned explainer has to read at a glance. Budget at
   * the narrowest width: 260px minus 16px body padding ≈ 40 chars per line at
   * 11px, so ~5 lines × 15.4px line-height (1.4) + 6px×2 padding + a ~20px
   * header ≈ 109.
   */
  const NOTE_H = 112;
  const NOTE_GAP = 16;
  const noteW = entry.note
    ? Math.min(NOTE_MAX_W, Math.max(NOTE_MIN_W, maxX - minX))
    : 0;
  const noteBand = entry.note ? NOTE_H + NOTE_GAP : 0;
  // A note wider than the graph widens the frame; the graph stays left-aligned.
  if (entry.note) maxX = Math.max(maxX, minX + noteW);

  // Create group container
  const groupId = `${groupIdPrefix}${entry.id}`;
  const frameW = maxX - minX + PAD * 2;
  const frameH = maxY - minY + TOP_PAD + noteBand + PAD;
  const groupNode: AppNode = {
    id: groupId,
    type: 'group',
    position: { x: 0, y: 0 },
    // TOP-LEVEL width/height plus the `data` mirror — the exact shape
    // `groupSelection` writes. This used to be a `style: { width, height }`
    // instead, which React Flow renders identically (`node.width ??
    // node.style?.width`) and which therefore looked correct for as long as
    // nobody ASKED the node how big it was. `toggleGroupCollapsed` asks: it
    // read `node.width ?? data.width ?? 200`, found neither, recorded 200 as
    // the remembered expanded size, and expanded every dropped preset and
    // texture to a 200x120 stub with its whole graph outside the frame.
    width: frameW,
    height: frameH,
    data: {
      registryType: 'group',
      label: entry.name,
      color: entry.color,
      collapsed: false,
      titleSize: entry.titleSize,
      width: frameW,
      height: frameH,
    } as GroupNodeData,
  } as AppNode;

  // Reparent nodes into group, offset positions relative to group. The note
  // band (0 when there is no note) shifts the whole graph down beneath it.
  for (const n of laid) {
    n.parentId = groupId;
    n.position.x -= minX - PAD;
    n.position.y -= minY - TOP_PAD - noteBand;
  }

  // The note itself: a normal member node, sitting in the band just cleared
  // for it. Its header wears the group's colour so it reads as that preset's
  // caption rather than a stray sticky note; the body stays near-white so the
  // text is legible whatever the preset colour is.
  const members: AppNode[] = [...laid];
  if (entry.note) {
    members.unshift({
      id: `${groupId}-note`,
      type: 'note',
      parentId: groupId,
      position: { x: PAD, y: TOP_PAD - BADGE_CLEARANCE },
      width: noteW,
      height: NOTE_H,
      // Dragged only by the header bar so the body text stays selectable.
      dragHandle: '.note-node__header',
      data: {
        registryType: 'note',
        heading: entry.note.heading,
        text: entry.note.text,
        color: '#FAFAFA',
        headerColor: entry.color,
        scale: 1,
      },
    } as unknown as AppNode);
  }

  return {
    ...entry,
    totalCost,
    nodes: [groupNode, ...members],
    edges,
    outputEdges,
  };
}
