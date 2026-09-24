/**
 * "Add" — the second answer of the dropped-shader dialog
 * (`components/Modals/ShaderImportModal.tsx`).
 *
 * OPEN replaces the document; ADD keeps it and parks the dropped shader's
 * chain BESIDE the graph already on the canvas, inside one group frame named
 * after the file. The graph the user is working on is not touched: no node of
 * theirs moves, no wire of theirs is re-pointed, and nothing arrives already
 * driving the picture.
 *
 * THE ARRIVING SET LOSES ITS SINKS. Every Output — plain and Raymarch alike
 * (`isSinkNode`) — is dropped along with the edges that fed it, which is what
 * "not attached to output" means: the arriving chain ends at whatever last fed
 * its Output, unwired, for the user to plug in themselves. Keeping them would
 * be worse than untidy: among untargeted plain Outputs exactly one contributes
 * and a DRIVING Raymarch Output suppresses every plain one, so an arriving
 * sink can silently take over the render of the shader it was added to
 * (`utils/sdfPartition.ts`, `utils/outputMaterials.ts`). Dropping them also
 * means no Output arrives, so the unfold/active-sink repairs that
 * `instantiateSavedGroup` has to re-run over the COMBINED list have nothing to
 * do here — this planner never reads or rewrites a live node.
 *
 * SINGLETONS ARE REDIRECTED, NOT DUPLICATED. A Sound node
 * (`SINGLETON_NODE_TYPES`) already on the canvas keeps its place and the
 * arriving copy's wires are re-pointed onto it — the same "glide to the node
 * that is already there" rule both add surfaces follow. With none live, the
 * arriving one is kept and joins the group.
 *
 * IDS ARE ALL FRESH. A `.fastshader` carries the ids it was saved with, and
 * the live graph may hold the very same ones (it usually will, for a file
 * exported from a shader this one descends from). Re-minting every id is what
 * keeps an Add from colliding with the document it lands in.
 *
 * NESTING SURVIVES. A dropped shader may hold groups and notes of its own;
 * their `parentId` links are remapped rather than flattened, and only
 * ROOT-level nodes become members of the new frame. React Flow needs a parent
 * before its children in the array, so the result is emitted parents-first.
 *
 * Pure: no store, no window, no clone of anything live. The caller commits.
 */
import { generateId, generateEdgeId } from '@/utils/idGenerator';
import { isSinkNode } from '@/utils/sdfPartition';
import { isSingletonNodeType } from '@/components/NodeEditor/singletonNodes';
import { randomGroupColor } from '@/utils/newNodeValues';
import { groupFrameSize } from '@/utils/groupFrame';
import type { AppEdge, AppNode, GroupNodeData } from '@/types';

/** The frame's inner padding, matching `groupSelection`'s own. */
const PADDING = 24;
/** Room for a member's cost badge (`top: -14px`), as `groupSelection` buys it. */
const BADGE_CLEARANCE = 14;
const TOP_PADDING = PADDING + BADGE_CLEARANCE;
const HEADER_H = 22;
/** Clear canvas between the live graph's box and the arriving frame. */
export const ADD_GAP = 120;
/** Fallbacks for a node the DOM has never measured — `groupSelection`'s. */
const EST_W = 160;
const EST_H = 60;

export interface ShaderGroupPlan {
  /** The frame. FIRST in the committed array — React Flow requires it. */
  group: AppNode;
  /** Every arriving node, parents before children. */
  members: AppNode[];
  /** Every surviving arriving edge, re-ided onto the fresh node ids. */
  edges: AppEdge[];
  /** Outputs dropped (plain + Raymarch), for the import note. */
  droppedSinks: number;
  /** Arriving singleton nodes re-pointed onto the live one. */
  redirectedSingletons: number;
}

function sizeOf(n: AppNode): { w: number; h: number } {
  if (n.type === 'group') return groupFrameSize(n);
  const m = n as AppNode & {
    measured?: { width?: number; height?: number };
    width?: number;
    height?: number;
  };
  return {
    w: m.measured?.width ?? m.width ?? EST_W,
    h: m.measured?.height ?? m.height ?? EST_H,
  };
}

/**
 * Where the arriving frame is parked: clear to the RIGHT of everything on the
 * canvas, top-aligned with it. Deliberately not the pointer position — three
 * surfaces raise this dialog and two of them (the 3D preview, the code panel)
 * have no canvas coordinates to offer, so one deterministic answer beats a
 * position that means something on only one of them. `fs:graph-merged` frames
 * the result, so "off to the right" is never off screen.
 *
 * An empty canvas anchors at the flow origin.
 */
export function addAnchor(live: readonly AppNode[]): { x: number; y: number } {
  let maxX = -Infinity;
  let minY = Infinity;
  for (const n of live) {
    // Root-level only: a child's position is relative to its parent, and the
    // parent's own box already covers it.
    if (n.parentId) continue;
    const { w } = sizeOf(n);
    maxX = Math.max(maxX, n.position.x + w);
    minY = Math.min(minY, n.position.y);
  }
  if (!Number.isFinite(maxX)) return { x: 0, y: 0 };
  return { x: maxX + ADD_GAP, y: Number.isFinite(minY) ? minY : 0 };
}

/**
 * Order nodes so every parent precedes its children (React Flow's array
 * contract). A `parentId` that names no arriving node is dropped to root —
 * the file is adversarial input and a dangling parent renders nothing.
 */
function parentsFirst(nodes: AppNode[]): AppNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: AppNode[] = [];
  const done = new Set<string>();
  const visit = (n: AppNode, seen: Set<string>) => {
    if (done.has(n.id) || seen.has(n.id)) return;
    seen.add(n.id);
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent) visit(parent, seen);
    if (done.has(n.id)) return;
    done.add(n.id);
    out.push(n);
  };
  for (const n of nodes) visit(n, new Set());
  return out;
}

/**
 * Plan the Add. Returns null when the file holds nothing to add — an Outputs-
 * only shader, or an empty parse — so the caller can say so instead of
 * dropping an empty frame on the canvas.
 *
 * `incoming` must already have been through the arriving-node sanitizers (the
 * caller's job: it is the path that owns the image budget and the notices).
 */
export function planShaderGroup(
  incoming: { nodes: readonly AppNode[]; edges: readonly AppEdge[] },
  live: readonly AppNode[],
  groupLabel: string,
  opts?: { anchor?: { x: number; y: number }; rand?: () => number },
): ShaderGroupPlan | null {
  const anchor = opts?.anchor ?? addAnchor(live);
  const rand = opts?.rand ?? Math.random;
  // 1. Drop the sinks. Their edges go with them (step 3 filters on the map).
  const sinks = new Set(incoming.nodes.filter(isSinkNode).map((n) => n.id));

  // 2. Redirect arriving singletons onto the live node of that type. First in
  //    array order is the one in charge — `findSingletonNode`'s rule, restated
  //    here so this stays a leaf.
  const liveSingleton = new Map<string, string>();
  for (const n of live) {
    const type = n.data?.registryType;
    if (typeof type !== 'string' || !isSingletonNodeType(type)) continue;
    if (!liveSingleton.has(type)) liveSingleton.set(type, n.id);
  }

  // 3. Fresh ids for everything that survives; redirected singletons map onto
  //    the LIVE id, so their wires land on the node already on the canvas.
  const idMap = new Map<string, string>();
  const kept: AppNode[] = [];
  const redirected = new Set<string>();
  let redirectedSingletons = 0;
  for (const n of incoming.nodes) {
    if (sinks.has(n.id)) continue;
    const type = n.data?.registryType;
    const liveId = typeof type === 'string' ? liveSingleton.get(type) : undefined;
    if (liveId !== undefined) {
      idMap.set(n.id, liveId);
      redirected.add(n.id);
      redirectedSingletons++;
      continue;
    }
    idMap.set(n.id, generateId());
    kept.push(n);
  }
  if (kept.length === 0) return null;
  const keptIds = new Set(kept.map((n) => n.id));

  // 4. Translate the arriving ROOT nodes into the frame. Children keep their
  //    parent-relative positions untouched.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of kept) {
    if (n.parentId !== undefined && keptIds.has(n.parentId)) continue;
    const { w, h } = sizeOf(n);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  // Every kept node is nested under one that was dropped: they are roots now.
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = EST_W;
    maxY = EST_H;
  }
  const groupW = maxX - minX + PADDING * 2;
  const groupH = maxY - minY + TOP_PADDING + PADDING + HEADER_H;
  // A root member's position is relative to the frame origin.
  const dx = PADDING - minX;
  const dy = TOP_PADDING + HEADER_H - minY;

  const groupId = generateId();
  const members = parentsFirst(
    kept.map((n) => {
      // Nested only under a parent that SURVIVED: a child of a dropped sink —
      // or of a singleton folded onto the live node — becomes a root of the
      // new frame and is translated like one.
      const nested = n.parentId !== undefined && keptIds.has(n.parentId);
      const out = {
        ...n,
        id: idMap.get(n.id)!,
        parentId: nested ? idMap.get(n.parentId!)! : groupId,
        position: nested
          ? { ...n.position }
          : { x: n.position.x + dx, y: n.position.y + dy },
        selected: false,
      } as AppNode & { extent?: unknown };
      // Never `extent: 'parent'` — members must stay draggable out of a frame.
      delete out.extent;
      return out as AppNode;
    }),
  );

  const edges: AppEdge[] = [];
  for (const e of incoming.edges) {
    const source = idMap.get(e.source);
    const target = idMap.get(e.target);
    if (source === undefined || target === undefined) continue;
    // A singleton redirected onto itself (both ends folded to the live node)
    // would be a self-edge the graph never had.
    if (source === target) continue;
    // A wire INTO a redirected singleton (Sound's gain/smoothing) would land
    // on the live node and re-wire the user's shader — the one thing Add
    // promises never to do. Only its OUTPUT wires come along.
    if (redirected.has(e.target)) continue;
    edges.push({
      ...e,
      id: generateEdgeId(source, e.sourceHandle ?? 'out', target, e.targetHandle ?? 'in'),
      source,
      target,
      selected: false,
    });
  }

  const group: AppNode = {
    id: groupId,
    type: 'group',
    position: { x: anchor.x, y: anchor.y },
    width: groupW,
    height: groupH,
    data: {
      registryType: 'group',
      // The FILE's name, not `nextGroupLabel`'s "Group 3": the one thing the
      // user needs to read off the canvas is which drop this frame came from.
      label: groupLabel,
      color: randomGroupColor([...live], rand),
      width: groupW,
      height: groupH,
    } as GroupNodeData,
  } as AppNode;

  return { group, members, edges, droppedSinks: sinks.size, redirectedSingletons };
}
