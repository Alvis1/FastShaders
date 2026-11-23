/**
 * BAKE TO TEXTURE — the commit's graph edit, pure (docs/dev/baking.md). The
 * store's `commitBake` runs it inside ONE history entry.
 *
 * It never expands a collapsed group. A collapsed group stores its boundary
 * wires rewritten onto its pill, and collapsing is TWO-phase (the pill's wires
 * are rewired a frame later), so expanding and re-collapsing several groups in
 * one act makes their deferred phases overwrite each other. Instead each wire
 * is found by its id through the unwrapped view, and only its SOURCE moves to
 * the Image: a wire ending on a collapsed pill's input socket keeps that
 * socket, and a pill output that no longer leads anywhere is pruned. The park
 * frame is the ONE group the commit collapses.
 *
 * Per baked socket it adds the Image node where the socket's node stood, and
 * moves every wire that carried the socket out of the selection onto it:
 *
 *   - a scalar reads the Image's R, a vec3 or colour its Color, a vec2 an
 *     Vec2 of R and G, a vec4 an Append of the Color and a second, grey
 *     Image's R (the alpha pass);
 *   - a value stored NORMALISED (`remap`) reads back through a Multiply by the
 *     range and an Add of its low end — per channel for a scalar or a vec2,
 *     on the whole Color for a vec3 — so the shader sees the original numbers.
 *
 * Then the originals are PARKED: the selection, plus every node upstream of it
 * that now feeds nothing else, go into one group beside the Image (a single
 * selected group is that group). Nothing in it reaches an Output any more, so
 * it costs nothing, leaves the code panel and the export, and can be wired back
 * or baked again later. Only nodes at the selection's own level move; one
 * nested elsewhere keeps its place.
 */
import type { AppEdge, AppNode, ShaderNodeData } from '@/types';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { isSinkNode } from '@/utils/sdfPartition';
import { isPassThroughNode } from '@/utils/passThrough';
import {
  GROUP_BADGE_CLEARANCE,
  GROUP_HEADER_H,
  GROUP_PADDING,
  absoluteNodePosition,
  groupDescendantIds,
  groupFrameSize,
  isCollapsedMember,
  measuredNodeSize,
} from '@/utils/groupFrame';
import { freeFrameSpot, type FlowBox } from '@/utils/libraryAutoWire';
import { bakeSockets, expandBakeSelection, type BakeShape, type BakeSocket } from '@/utils/bakePlan';
import type { GroupNodeData } from '@/types';

export interface BakedPicture {
  /** The Image node's data, payload and all (`makeImageNodeFromEncode`). */
  data: ShaderNodeData;
  /** The stored values read back as `v·scale + offset`; null when stored as they are. */
  remap: { scale: number; offset: number } | null;
}

export interface BakeCommitSocket {
  socket: BakeSocket;
  shape: BakeShape;
  picture: BakedPicture;
  /** The vec4's fourth channel (shape 4 only). */
  alpha: BakedPicture | null;
}

/** What the dialog hands the store's `commitBake`. */
export interface BakeCommitInput {
  selectedIds: string[];
  sockets: BakeCommitSocket[];
  /** For the `bake` study event only. */
  layout: 'uv' | 'mesh';
  size: number;
}

/** The box a fresh Image card is drawn at, before React Flow measures it. */
export const BAKED_IMAGE_BOX = { w: 160, h: 200 } as const;
/** Clearance between the parked pill and the Image it was baked into. */
export const BAKED_PILL_GAP = 40;

export interface BakeCommitPlan {
  nodes: AppNode[];
  edges: AppEdge[];
  /** Every node the bake added (Images first). */
  addedIds: string[];
  imageIds: string[];
  /** The group the originals are parked in, or null when nothing moved. */
  parkGroupId: string | null;
  /** How many nodes were parked. */
  parked: number;
}

/**
 * What a placed bake box must not land on: every node DRAWN at the level, as
 * it is drawn (`placementObstacles`' rule), minus `gone` (what is parked or
 * moves) and minus the frames that CONTAIN the level — a box placed inside a
 * group would otherwise be pushed out of the very frame it belongs to.
 */
export function bakeObstacles(
  nodes: readonly AppNode[],
  gone: ReadonlySet<string>,
  level: string | undefined,
): FlowBox[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const containers = new Set<string>();
  let cur = level ? byId.get(level) : undefined;
  for (let hops = 0; cur && hops < 100; hops++) {
    containers.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  const out: FlowBox[] = [];
  for (const n of nodes) {
    if (gone.has(n.id) || containers.has(n.id) || isCollapsedMember(n)) continue;
    const at = absoluteNodePosition(n, byId);
    const { w, h } = n.type === 'group' ? groupFrameSize(n) : measuredNodeSize(n);
    if (![at.x, at.y, w, h].every(Number.isFinite)) continue;
    out.push({ x: at.x, y: at.y, w, h });
  }
  return out;
}

/** A bake's BLOCK — the Image(s) and the helpers that rebuild the socket —
 *  laid out left to right in its own coordinates, then placed as one box. */
const BLOCK_GAP = 40;
const HELPER_DX = 130;
const HELPER_DY = 70;
/** The box a fresh helper card (Multiply, Add, Vec2, Append) is drawn at. */
const HELPER_BOX = { w: 100, h: 60 } as const;

function shaderNode(id: string, type: string, label: string, cost: number, values: Record<string, string | number>, at: { x: number; y: number }, parentId: string | undefined): AppNode {
  return {
    id,
    type: 'shader',
    position: { x: at.x, y: at.y },
    ...(parentId ? { parentId } : {}),
    data: { registryType: type, label, cost, values },
  } as unknown as AppNode;
}

/**
 * The commit. `selectedIds` and the sockets are the dialog's; `newId` mints
 * node ids; `cost` prices a fresh node TYPE (`freshNodeCost`); `group` is the
 * new park frame's label and colour. Null when a socket's node is gone.
 */
export function planBakeCommit(
  nodes: AppNode[],
  edges: AppEdge[],
  selectedIds: readonly string[],
  sockets: readonly BakeCommitSocket[],
  newId: () => string,
  cost: (type: string) => number,
  group: { label: string; color: string },
): BakeCommitPlan | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (sockets.length === 0 || sockets.some((s) => !byId.has(s.socket.nodeId))) return null;
  const selected = expandBakeSelection(nodes, selectedIds);

  // The selection's LEVEL: a single selected group parks as itself, so its
  // own parent; otherwise the first selected node's parent.
  const lone = selectedIds.length === 1 ? byId.get(selectedIds[0]) : undefined;
  const loneGroup = lone && lone.type === 'group' ? lone : null;
  const firstSel = byId.get(selectedIds.find((id) => byId.has(id)) ?? sockets[0].socket.nodeId)!;
  const level: string | undefined = loneGroup ? loneGroup.parentId : firstSel.parentId;
  const levelNode = level ? byId.get(level) : undefined;
  const levelAbs = levelNode ? absoluteNodePosition(levelNode, byId) : { x: 0, y: 0 };

  const added: AppNode[] = [];
  const imageIds: string[] = [];
  let edgesOut = edges.slice();
  // The wires that carry each socket OUT of the selection, by stored id (the
  // unwrapped view keeps every wire's id, so a wire through a pill is found too).
  const leaving = new Map<string, Set<string>>();
  for (const { socket, consumers } of bakeSockets(nodes, edges, selected)) {
    leaving.set(`${socket.nodeId}\0${socket.handleId}`, new Set(consumers.map((e) => e.id)));
  }
  const prunable = new Set<string>();

  /** Each socket's block: its nodes (positions block-local), its size, and
   *  where it would ideally go — its right edge where the baked node's was, so
   *  the rebuilt value leaves from the same place. */
  const blocks: { ids: string[]; w: number; h: number; ideal: { x: number; y: number } }[] = [];

  for (const s of sockets) {
    const src = byId.get(s.socket.nodeId)!;
    const abs = absoluteNodePosition(src, byId);
    const block: { ids: string[]; w: number; h: number; ideal: { x: number; y: number } } = {
      ids: [],
      w: BAKED_IMAGE_BOX.w,
      h: BAKED_IMAGE_BOX.h,
      ideal: { x: 0, y: abs.y },
    };
    let row = 0;
    const helperAt = (col: number) => ({
      x: BAKED_IMAGE_BOX.w + BLOCK_GAP + HELPER_DX * (col - 1),
      y: HELPER_DY * row,
    });
    const helperEdges: AppEdge[] = [];
    const add = (type: string, label: string, values: Record<string, string | number>, col: number): string => {
      const id = newId();
      const at = helperAt(col);
      added.push(shaderNode(id, type, label, cost(type), values, at, level));
      block.ids.push(id);
      block.w = Math.max(block.w, at.x + HELPER_BOX.w);
      block.h = Math.max(block.h, at.y + HELPER_BOX.h);
      return id;
    };
    const wire = (from: string, fromHandle: string, to: string, toHandle: string) => {
      helperEdges.push(makeTypedEdge(from, fromHandle, to, toHandle));
    };

    const placeImage = (p: BakedPicture, dy: number): string => {
      const id = newId();
      added.push({
        id,
        type: 'shader',
        position: { x: 0, y: dy },
        ...(level ? { parentId: level } : {}),
        data: p.data,
      } as unknown as AppNode);
      imageIds.push(id);
      block.ids.push(id);
      block.h = Math.max(block.h, dy + BAKED_IMAGE_BOX.h);
      return id;
    };
    /** One channel (or the whole Color) of a picture, its range restored. */
    const channel = (img: string, handle: string, remap: BakedPicture['remap'], col: number): [string, string] => {
      if (!remap) return [img, handle];
      const m = add('mul', 'Multiply', { b: remap.scale }, col);
      wire(img, handle, m, 'a');
      const a = add('add', 'Add', { b: remap.offset }, col + 1);
      wire(m, 'out', a, 'a');
      row += 1;
      return [a, 'out'];
    };

    const img = placeImage(s.picture, 0);
    let terminal: [string, string];
    if (s.shape === 1) {
      terminal = channel(img, 'r', s.picture.remap, 1);
    } else if (s.shape === 2) {
      const x = channel(img, 'r', s.picture.remap, 1);
      const y = channel(img, 'g', s.picture.remap, 1);
      const v = add('vec2', 'Vec2', {}, 3);
      wire(x[0], x[1], v, 'x');
      wire(y[0], y[1], v, 'y');
      terminal = [v, 'out'];
    } else if (s.shape === 3) {
      terminal = channel(img, 'out', s.picture.remap, 1);
    } else {
      const rgb = channel(img, 'out', s.picture.remap, 1);
      const alphaImg = s.alpha ? placeImage(s.alpha, BAKED_IMAGE_BOX.h + BLOCK_GAP) : null;
      row = Math.max(row, 1);
      const w = alphaImg ? channel(alphaImg, 'r', s.alpha!.remap, 1) : null;
      const ap = add('append', 'Append', w ? {} : { b: 1 }, 3);
      wire(rgb[0], rgb[1], ap, 'a');
      if (w) wire(w[0], w[1], ap, 'b');
      terminal = [ap, 'out'];
    }

    // Every wire that carried the socket OUT of the selection now leaves the
    // terminal instead — onto the same target socket, a pill's included; a
    // wire inside the selection stays with the originals.
    const ids = leaving.get(`${s.socket.nodeId}\0${s.socket.handleId}`) ?? new Set<string>();
    edgesOut = edgesOut.map((e) => {
      if (!ids.has(e.id)) return e;
      if (byId.get(e.source)?.type === 'group') prunable.add(e.source);
      return makeTypedEdge(terminal[0], terminal[1], e.target, e.targetHandle, e.data?.dataType ?? 'any');
    });
    edgesOut.push(...helperEdges);
    block.ideal.x = abs.x + measuredNodeSize(src).w - block.w;
    blocks.push(block);
  }

  // PARK: the selection, then every node upstream that now feeds only parked
  // nodes. Sinks, frames and notes never move.
  const cand = new Set<string>(selected);
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of edgesOut) {
      if (!cand.has(e.target) || cand.has(e.source)) continue;
      const u = byId.get(e.source);
      if (!u || u.type === 'group' || u.type === 'note' || isPassThroughNode(u) || isSinkNode(u)) continue;
      if (edgesOut.every((f) => f.source !== u.id || cand.has(f.target))) {
        cand.add(u.id);
        changed = true;
      }
    }
  }

  let parkGroupId: string | null = null;
  let parked = 0;
  // A collapsed pill whose output socket no longer has a wire drops it.
  let nodesOut = nodes.map((n) => {
    if (!prunable.has(n.id)) return n;
    const data = n.data as GroupNodeData;
    const outs = Array.isArray(data.collapsedOutputs) ? data.collapsedOutputs : [];
    const kept = outs.filter((o) =>
      edgesOut.some((e) => e.source === n.id && e.sourceHandle === o.socketId),
    );
    return { ...n, data: { ...data, collapsedOutputs: kept } } as AppNode;
  });

  if (loneGroup) {
    parkGroupId = loneGroup.id;
    parked = selected.size;
  } else {
    // Each candidate's ancestor AT the level: itself, or the frame holding it
    // there — a frame only when every node inside it is a candidate.
    const atLevel = (id: string): string | null => {
      let cur = byId.get(id);
      for (let hops = 0; cur && hops < 100; hops++) {
        if (cur.parentId === level) return cur.id;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return null;
    };
    const items = new Set<string>();
    for (const id of cand) {
      const top = atLevel(id);
      if (!top) continue;
      const topNode = byId.get(top)!;
      if (topNode.type === 'group') {
        const inside = [...groupDescendantIds(nodes, top)].filter((d) => byId.get(d)?.type !== 'group');
        if (!inside.every((d) => cand.has(d))) continue;
      }
      items.add(top);
    }
    // ONE whole group and nothing beside it (a marquee takes a frame WITH its
    // members) parks as itself, never inside a second frame.
    const only = items.size === 1 ? byId.get([...items][0]) : undefined;
    if (only && only.type === 'group') {
      parkGroupId = only.id;
      parked = [...groupDescendantIds(nodes, only.id)].filter((d) => byId.get(d)?.type !== 'group').length;
    } else if (items.size > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of items) {
        const n = byId.get(id)!;
        const { w, h } = n.type === 'group' ? groupFrameSize(n) : measuredNodeSize(n);
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + w);
        maxY = Math.max(maxY, n.position.y + h);
      }
      const top = GROUP_PADDING + GROUP_BADGE_CLEARANCE;
      const gx = minX - GROUP_PADDING;
      const gy = minY - top - GROUP_HEADER_H;
      const gw = maxX - minX + GROUP_PADDING * 2;
      const gh = maxY - minY + top + GROUP_PADDING + GROUP_HEADER_H;
      const gid = newId();
      const frame = {
        id: gid,
        type: 'group',
        position: { x: gx, y: gy },
        width: gw,
        height: gh,
        ...(level ? { parentId: level } : {}),
        data: { registryType: 'group', label: group.label, color: group.color, width: gw, height: gh },
      } as unknown as AppNode;
      nodesOut = nodesOut.map((n) =>
        items.has(n.id)
          ? ({ ...n, parentId: gid, position: { x: n.position.x - gx, y: n.position.y - gy } } as AppNode)
          : n,
      );
      // A parent precedes its children: the frame goes just before its first member.
      const first = nodesOut.findIndex((n) => items.has(n.id));
      nodesOut.splice(first < 0 ? nodesOut.length : first, 0, frame);
      parkGroupId = gid;
      for (const id of items) {
        const n = byId.get(id)!;
        parked += n.type === 'group' ? [...groupDescendantIds(nodes, id)].filter((d) => byId.get(d)?.type !== 'group').length : 1;
      }
    }
  }

  // Each block on the nearest free spot to its ideal one. What is parked
  // leaves the canvas (its pill is placed afterwards, beside the Image), so
  // only what stays — and the blocks already placed — is in the way.
  const gone = new Set<string>();
  if (parkGroupId) {
    gone.add(parkGroupId);
    for (const d of groupDescendantIds(nodesOut, parkGroupId)) gone.add(d);
  }
  const obstacles = bakeObstacles(nodesOut, gone, level);
  const shift = new Map<string, { x: number; y: number }>();
  for (const b of blocks) {
    const spot = freeFrameSpot({ x: b.ideal.x, y: b.ideal.y, w: b.w, h: b.h }, obstacles);
    obstacles.push({ x: spot.x, y: spot.y, w: b.w, h: b.h });
    for (const id of b.ids) shift.set(id, { x: spot.x - levelAbs.x, y: spot.y - levelAbs.y });
  }
  const placed = added.map((n) => {
    const d = shift.get(n.id);
    return d ? ({ ...n, position: { x: n.position.x + d.x, y: n.position.y + d.y } } as AppNode) : n;
  });

  const addedIds = added.map((n) => n.id);
  return { nodes: [...nodesOut, ...placed], edges: edgesOut, addedIds, imageIds, parkGroupId, parked };
}
