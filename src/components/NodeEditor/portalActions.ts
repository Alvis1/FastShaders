/**
 * The PORTAL gestures' store-touching half (docs/dev/canvas-interaction.md,
 * "Portal"). The pure geometry, names and refusals are portalWire.ts and the
 * leaf utils/portalNames.ts.
 *
 * ONE undo entry per act: each add, split, rename, relink or rejoin runs in
 * one bracket (or one `pushHistory`), and every guard stays OUTSIDE it — an
 * empty bracket still costs an entry and clears the redo stack. Telemetry
 * rides the store actions that already log (`addNode` → `node-add` with the
 * type `tunnelIn` / `tunnelOut`, `removeNode` → `node-remove`); nothing new is
 * recorded.
 */
import type { FitViewOptions } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import type { AppNode } from '@/types';
import { generateId } from '@/utils/idGenerator';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { isTunnelIn, isTunnelOut, tunnelExits, tunnelLabelOf } from '@/utils/passThrough';
import { portalNamesTaken, uniquePortalName } from '@/utils/portalNames';
import { connectNodes } from './edgeInsert';
import { edgeDrawnSegments, type GetInternalNode } from './edgeHit';
import { feedsFedKnot, knotParentFor, wirePoints, type Pt } from './branchWire';
import { focusNode, focusNodes, focusTargets } from './outputFocus';
import {
  entranceOf,
  exitIntoMakesLoop,
  makePortalRefusal,
  makeTunnelInNode,
  makeTunnelOutNode,
  portalMembers,
  portalSourceName,
  portalSpots,
  portalWaypointHalves,
  relinkedExitNodes,
  renamedPortalNodes,
  splitEdgeWithPortal,
  unportalPlan,
} from './portalWire';

type FitView = (options?: FitViewOptions) => Promise<boolean> | void;

/** A wire's pulled socket (the Add-node menu's dropped pin). */
export interface PortalPin {
  nodeId: string;
  handleId: string;
}

/**
 * "Make portal" on the wire `edgeId`: a Portal In `PORTAL_GAP` along the
 * DRAWN wire from its source, a Portal Out as far back from its target, the
 * wire split into source → In and Out → target (at the old index), the
 * routing points next to each end kept by that end, the portal named after
 * the source. One undo entry. Null, changing nothing, when refused
 * (`makePortalRefusal`) or the wire is not drawn.
 */
export function makePortal(edgeId: string, getInternalNode: GetInternalNode): { inId: string; outId: string } | null {
  const store = useAppStore.getState();
  if (makePortalRefusal(store.nodes, store.edges, edgeId)) return null;
  const edge = store.edges.find((e) => e.id === edgeId)!;
  const segs = edgeDrawnSegments(edge, getInternalNode);
  const spots = segs ? portalSpots(segs) : null;
  if (!spots) return null;
  const { before, after } = portalWaypointHalves(wirePoints(edge), spots.inSeg, spots.outSeg);
  const inId = generateId();
  const outId = generateId();
  const split = splitEdgeWithPortal(store.edges, edgeId, inId, outId, before, after);
  if (!split) return null;
  const name = uniquePortalName(
    portalSourceName(store.nodes, store.edges, store.nodeVarNames, edge.source),
    portalNamesTaken(store.nodes),
  );
  // A wire wholly inside an expanded group keeps both ends in that group.
  const parent = knotParentFor(store.nodes, edge) ?? undefined;
  asOneHistoryEntry(() => {
    const s = useAppStore.getState();
    s.addNode(makeTunnelInNode(inId, spots.inAt, name, parent));
    s.addNode(makeTunnelOutNode(outId, spots.outAt, inId, name, parent));
    s.setEdges(split);
  });
  return { inId, outId };
}

/**
 * A new Portal In centred on `center`: fed by `pin` (a wire pulled from an
 * OUTPUT) and named after what it carries, or unfed and named "portal N".
 * One undo entry. Returns its id.
 */
export function addPortalIn(center: Pt, pin?: PortalPin): string {
  const store = useAppStore.getState();
  const base = pin ? portalSourceName(store.nodes, store.edges, store.nodeVarNames, pin.nodeId) : '';
  const name = uniquePortalName(base, portalNamesTaken(store.nodes));
  const id = generateId();
  asOneHistoryEntry(() => {
    useAppStore.getState().addNode(makeTunnelInNode(id, center, name));
    if (pin) connectNodes(pin.nodeId, pin.handleId, id, 'in');
  });
  return id;
}

/**
 * Can a Portal Out of `entranceId` be wired into the input `pin`? Refused: no
 * such entrance, an input that would close a loop through the hidden link
 * (`exitIntoMakesLoop`), or a fed Branch / Portal In's one input
 * (`feedsFedKnot`). `loop` is the reason a menu row names.
 */
export function portalOutRefusal(entranceId: string, pin?: PortalPin): 'missing' | 'loop' | 'fed' | null {
  const { nodes, edges } = useAppStore.getState();
  if (!isTunnelIn(nodes.find((n) => n.id === entranceId))) return 'missing';
  if (!pin) return null;
  if (exitIntoMakesLoop(nodes, edges, entranceId, pin.nodeId, pin.handleId)) return 'loop';
  if (feedsFedKnot(nodes, edges, pin.nodeId, null, pin.handleId)) return 'fed';
  return null;
}

/**
 * A new Portal Out of the entrance `entranceId` centred on `center`, wired
 * into `pin` (a wire pulled from an INPUT) when given. One undo entry. Null,
 * changing nothing, when refused (`portalOutRefusal`).
 */
export function addPortalOut(entranceId: string, center: Pt, pin?: PortalPin): string | null {
  if (portalOutRefusal(entranceId, pin)) return null;
  const entrance = useAppStore.getState().nodes.find((n) => n.id === entranceId)!;
  const id = generateId();
  asOneHistoryEntry(() => {
    useAppStore.getState().addNode(makeTunnelOutNode(id, center, entranceId, tunnelLabelOf(entrance)));
    if (pin) connectNodes(id, 'out', pin.nodeId, pin.handleId);
  });
  return id;
}

/**
 * Rename the portal `entranceId` (cleaned, unique among the entrances), with
 * every exit's name cache in the SAME undo entry. False, spending no entry,
 * when nothing changes (`renamedPortalNodes`).
 */
export function renamePortal(entranceId: string, raw: unknown): boolean {
  const store = useAppStore.getState();
  const next = renamedPortalNodes(store.nodes, entranceId, raw);
  if (!next) return false;
  store.pushHistory();
  store.setNodes(next);
  return true;
}

/**
 * "Turn back into wires" on either end of a portal: the plan of
 * `unportalPlan`, then the entrance and every exit removed through
 * `removeNode` (which has nothing left to bridge). One undo entry. False,
 * changing nothing, when refused.
 */
export function turnPortalBackIntoWires(nodeId: string): boolean {
  const store = useAppStore.getState();
  const plan = unportalPlan(store.nodes, store.edges, nodeId);
  if (!plan) return false;
  asOneHistoryEntry(() => {
    const s = useAppStore.getState();
    s.setEdges(plan.edges);
    for (const id of plan.removeIds) useAppStore.getState().removeNode(id);
  });
  return true;
}

/** "Connect to a portal…" on a broken exit. One undo entry; false when refused. */
export function relinkExit(exitId: string, entranceId: string): boolean {
  const store = useAppStore.getState();
  const next = relinkedExitNodes(store.nodes, store.edges, exitId, entranceId);
  if (!next) return false;
  store.pushHistory();
  store.setNodes(next);
  return true;
}

/**
 * Select exactly `ids`, each SHOWN as it is on screen: a member hidden in a
 * collapsed group is selected as the pill standing in for it (outputFocus.ts
 * `focusTargets`, F's and Cmd+Arrow's reading) — never the hidden node itself,
 * which nothing would show as selected while the next X or Delete removed it
 * (the A key's rule). Spread-only, so the autosave sees a pure selection
 * change (useKeyboardNav's `selectOnly`).
 */
function selectShown(ids: readonly string[]): void {
  const store = useAppStore.getState();
  const shown = new Set(focusTargets(store.nodes, ids).map((t) => t.id));
  store.setNodes(store.nodes.map((n) => ({ ...n, selected: shown.has(n.id) }) as AppNode));
}

/** "Select whole portal": the entrance and every exit (a hidden end as its
 *  pill, `selectShown`). False for a broken exit. */
export function selectWholePortal(nodeId: string): boolean {
  const entrance = entranceOf(useAppStore.getState().nodes, nodeId);
  if (!entrance) return false;
  selectShown(portalMembers(useAppStore.getState().nodes, entrance.id));
  return true;
}

/**
 * The partner glide (a portal end's double-click, its menu's Go to rows), on
 * F's glide (`VIEW_GLIDE_MS`): from an exit, to its entrance, which becomes the
 * selection (inside a collapsed group, its pill — `selectShown`); from an
 * entrance, framing all its exits (the entrance stays selected, so the trace
 * keeps showing). False when there is nowhere to go.
 */
export function glideToPortalPartner(nodeId: string, fitView: FitView): boolean {
  const nodes = useAppStore.getState().nodes;
  const node = nodes.find((n) => n.id === nodeId);
  if (isTunnelOut(node)) {
    const entrance = entranceOf(nodes, nodeId);
    if (!entrance) return false;
    focusNode(fitView, nodes, entrance.id);
    selectShown([entrance.id]);
    return true;
  }
  if (isTunnelIn(node)) {
    const exits = tunnelExits(nodes, nodeId).map((n) => n.id);
    if (exits.length === 0) return false;
    return focusNodes(fitView, nodes, exits);
  }
  return false;
}
