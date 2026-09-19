/**
 * Group FRAME geometry, in a zero-import LEAF.
 *
 * `groupFrameSize` and the resizer's floors lived in `store/useAppStore.ts` and
 * are re-exported from there, so `GroupNode.tsx` and `store/groupCollapse.test.ts`
 * keep their one import site. They moved because `utils/outputMaterials.ts`
 * needs them and sits INSIDE the store's import cycle
 * (`nodeCost → outputMaterials → exposedPorts → edgeUtils → useAppStore`): a
 * second edge back into the store from inside that cycle is the costTable TDZ
 * lesson — harmless until something evaluates across it during initialisation,
 * and `useAppStore` does call `sanitizeCostMap`/`setCostOverrides` at module
 * scope. A leaf can never be caught mid-init, so the cycle stays benign.
 *
 * Type-only imports, deliberately: they are erased at compile time, so this
 * module really does import nothing at runtime (`groupFrame.test.ts` pins it).
 */
import type { AppNode } from '@/types';

/**
 * The smallest a group frame may be — the bounds GroupNode hands its resize
 * grip, exported so the two cannot drift.
 *
 * They are also the test `toggleGroupCollapsed` uses to decide whether a
 * REMEMBERED expanded size is real: a value below what the grip itself can
 * produce is a lost or half-written one, not a size the user chose, so the
 * expand falls back to fitting the members instead of trusting it.
 */
export const MIN_GROUP_W = 120;
export const MIN_GROUP_H = 80;

/**
 * A group frame's authored size, wherever that node happens to carry it.
 *
 * There are two shapes in the wild and React Flow renders BOTH identically
 * (`node.width ?? node.style?.width`), which is exactly why the divergence went
 * unnoticed: `groupSelection` writes top-level `width`/`height` plus a `data`
 * mirror, while `codeGroupBuilder` — every built-in preset and texture — wrote
 * `style: { width, height }` and nothing else. Anything that ASKED the node how
 * big it was got 200x120 for the second kind, and `toggleGroupCollapsed` asks:
 * it recorded that as the remembered expanded size, so expanding a collapsed
 * preset produced a 200x120 stub with the whole graph outside the frame.
 *
 * The builder writes the canonical shape now, but a `style`-only group sits in
 * every graph saved before that — hence reading all of them here rather than
 * migrating on load: one function, no version bump, and a hand-edited file with
 * junk in one field falls through to the next.
 */
export function groupFrameSize(node: AppNode): { w: number; h: number } {
  const n = node as AppNode & {
    width?: unknown; height?: unknown;
    style?: { width?: unknown; height?: unknown };
    measured?: { width?: unknown; height?: unknown };
    data?: { width?: unknown; height?: unknown };
  };
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  return {
    w: num(n.width) ?? num(n.style?.width) ?? num(n.data?.width) ?? num(n.measured?.width) ?? 200,
    h: num(n.height) ?? num(n.style?.height) ?? num(n.data?.height) ?? num(n.measured?.height) ?? 120,
  };
}

/**
 * A node's ABSOLUTE (flow-space) position, walking the parent chain.
 *
 * React Flow v12 `node.position` is PARENT-RELATIVE, so two different readings
 * of the same number exist on any canvas with a group on it — and comparing
 * them is how a "lowest node" search ranks a grouped node against a root one
 * and picks whichever frame happens to sit nearest the origin.
 *
 * `byId` is the node list the parent chain lives in, which is NOT always the
 * list `node` came from: the resync's merged nodes have had their `parentId`
 * stripped and their frames are only in the OLD graph. `node.position` is read
 * verbatim; every hop above it comes from `byId`.
 *
 * Hop-limited and cycle-guarded — a chain comes out of a `.fastshader` and may
 * name itself.
 */
export function absoluteNodePosition(
  node: AppNode,
  byId: ReadonlyMap<string, AppNode>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = (byId.get(node.id) ?? node).parentId;
  const seen = new Set<string>([node.id]);
  for (let hops = 0; parentId && !seen.has(parentId) && hops < 100; hops++) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

/**
 * Grow every group FRAME that a node in `addedIds` hangs out of the bottom of.
 *
 * Nothing in this app resizes a frame after nodes are added to it
 * PROGRAMMATICALLY. Frame size is written in exactly three places
 * (`groupSelection`'s creation box, the collapse, the expand) plus the user's
 * resize grip, and the only member-fitting code is a closure inside the expand
 * branch. `extent: 'parent'` is stripped on load and never re-attached (that is
 * what makes drag-out-to-detach work), so React Flow does not clamp an
 * overflowing child either — it simply DRAWS it outside the frame, which reads
 * as the group having lost a node. A folded multi-material Output saved inside
 * a group came back with its materials strewn below the frame, and the only
 * repair was a collapse/expand round trip nobody would think to try.
 *
 * SCOPED to `addedIds`, and that is the whole safety of it. Fitting every
 * member would resize a frame on a document that needs no change, and the
 * autosave subscriber and `selectionOnlyGraphChange` compare the node array BY
 * REFERENCE — a new array on a clean document rewrites `fs:graph` on every
 * boot. The SAME array comes back when nothing grew, for that reason.
 *
 * UNPADDED, and `itemHeight` is the caller's own stacking pitch rather than a
 * node-size estimate: this is CHECKING that a frame contains what was just put
 * in it, not BUILDING one (the expand branch's containment floor is unpadded
 * for the same reason — a padded floor grows every tight frame on every pass).
 * HEIGHTS only: every caller stacks its additions in a column at an existing
 * member's x.
 *
 * A COLLAPSED group is never touched — its size IS the pill's, and its members
 * are hidden with it; the expand branch's own floor sizes the frame on the way
 * back.
 *
 * ONE LEVEL: a grown frame that is itself a group's child does not grow its
 * parent. `memberFit` has the same limit, and a nested frame that needs it is
 * one collapse/expand away.
 */
export function growGroupFrames(
  nodes: readonly AppNode[],
  addedIds: ReadonlySet<string>,
  itemHeight: number,
): AppNode[] {
  if (addedIds.size === 0) return nodes as AppNode[];
  /** parent id -> the lowest bottom edge an ADDED child needs, in the PARENT's space. */
  const need = new Map<string, number>();
  for (const n of nodes) {
    if (!addedIds.has(n.id)) continue;
    const pid = n.parentId;
    if (!pid) continue;
    const bottom = n.position.y + itemHeight;
    const cur = need.get(pid);
    if (cur === undefined || bottom > cur) need.set(pid, bottom);
  }
  if (need.size === 0) return nodes as AppNode[];

  let changed = false;
  const out = nodes.map((n) => {
    if (n.type !== 'group') return n;
    const bottom = need.get(n.id);
    if (bottom === undefined) return n;
    if ((n.data as { collapsed?: unknown }).collapsed === true) return n;
    const { w, h } = groupFrameSize(n);
    const next = Math.max(bottom, MIN_GROUP_H);
    if (h >= next) return n;
    changed = true;
    // The CANONICAL shape `groupSelection` writes: top-level width/height plus
    // the `data` mirror. `style` is left alone — `groupFrameSize` reads
    // top-level first, React Flow renders `node.width ?? node.style?.width`,
    // and the expand branch's `damagedByStyleOnlySizing` repair keys off
    // `data.expandedWidth`, which nothing here touches.
    const data = { ...(n.data as Record<string, unknown>), width: w, height: next };
    return { ...n, width: w, height: next, data } as AppNode;
  });
  return changed ? (out as AppNode[]) : (nodes as AppNode[]);
}
