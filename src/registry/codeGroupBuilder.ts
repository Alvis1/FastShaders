/**
 * Shared builder for code-defined asset groups (built-in textures and presets).
 *
 * Each asset is TSL code parsed into a node graph via codeToGraph at startup,
 * then wrapped in a group container so it can be dragged onto the canvas like
 * a saved group. Extracted from builtinTextures.ts when the Presets library
 * arrived, so both libraries stay one implementation.
 */

import type { AppNode, AppEdge, GroupNodeData } from '@/types';
import { codeToGraph } from '@/engine/codeToGraph';
import { autoLayout, estimateNodeSize } from '@/engine/layoutEngine';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';

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
  totalCost: number;
  nodes: AppNode[];
  edges: AppEdge[];
}

/**
 * Parse an entry's TSL code into nodes/edges, wrap in a group container, and
 * apply auto-layout. `groupIdPrefix` keeps the container ids of the two
 * libraries distinct (`builtin-texture-` / `builtin-preset-`).
 */
export function buildCodeGroup(entry: CodeGroupEntry, groupIdPrefix: string): CodeGroupAsset {
  const { nodes: rawNodes, edges: rawEdges } = codeToGraph(entry.code);

  // Filter out the output node — these are sub-graphs, not full shaders
  const nodes = rawNodes.filter((n) => n.data.registryType !== 'output');
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = rawEdges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  // Sum node costs
  const totalCost = nodes.reduce((sum, n) => {
    return sum + ((n.data as { cost?: number }).cost ?? 0);
  }, 0);

  // Auto-layout with tight spacing for compact groups
  const laid = autoLayout(nodes, edges, 'LR', { nodesep: 10, ranksep: 30 });

  // Auto-expose input ports that have incoming edges (mirrors useSyncEngine logic)
  for (const n of laid) {
    const def = NODE_REGISTRY.get(n.data.registryType);
    if (!def) continue;
    const usesExposedPorts = def.category === 'noise' || def.type === 'output' || def.type === 'uv';
    if (!usesExposedPorts) continue;

    const connectedPorts = new Set<string>();
    for (const e of edges) {
      if (e.target === n.id && e.targetHandle) {
        connectedPorts.add(e.targetHandle);
      }
    }
    if (connectedPorts.size > 0) {
      (n.data as Record<string, unknown>).exposedPorts = Array.from(connectedPorts);
    }
  }

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
  };
}
