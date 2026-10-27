import dagre from '@dagrejs/dagre';
import type { AppNode, AppEdge } from '@/types';
import { getCostScale } from '@/utils/colorUtils';
import { nodeCostPoints, budgetPointsOf } from '@/utils/nodeCost';
import { storedCost } from '@/utils/costTable';
import { OUTPUT_DEFAULT_EXPOSED, SPLAT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import { SPLAT_LIGHT_PORTS } from '@/utils/splatLight';
import { NODE_REGISTRY, growsOperands, getFlowNodeType } from '@/registry/nodeRegistry';
import { nodeBox, hasNodeGlyph, usesOperatorLayout, nodeScale } from '@/components/NodeEditor/nodes/glyphs/NodeGlyph';
import { COLOR_NODE_SIZE } from '@/components/NodeEditor/nodes/ColorNode';
import { SOUND_W, SOUND_HEADER_H, SOUND_BODY_H } from '@/components/NodeEditor/nodes/soundGeometry';
import { edgePortRailHeight } from '@/components/NodeEditor/nodes/edgePorts';
import { unknownRefSlots } from './unknownExpression';

// ── Node-size estimation ─────────────────────────────────────────────────────
// autoLayout usually runs BEFORE React Flow measures a node (on import/paste/
// texture load), so no real DOM box exists yet. Feeding dagre a flat placeholder
// size (the old 90×40) makes it space and align every node as if they were
// identical, which overlaps the tall ones (noise PreviewNodes are ~127px, UV
// ≈105px) and wastes room around the short ones. We instead estimate each node's
// rendered footprint per flow component type; when a node HAS been measured
// (the Organize action, resync of surviving nodes) autoLayout prefers the real
// box — see measuredSize().

const HEADER_H = 20; // header bar (title) — sits above the body in both layouts
const ROW_H = 16; // one input/output row in the rows layout (min-height 14 + pad)
const GLYPH_H = 34; // glyph block above the rows in a rows-layout node
// Image node (mirrors ShaderNode.css — a drift pair with no browser to pin it,
// so kept conservative; it only feeds unmeasured nodes):
const IMAGE_THUMB_H = 126; // .shader-node__image-thumb max-height 120 + 4/2 margins
const IMAGE_EMPTY_H = 54; // .shader-node__image-empty 48 + 4/2 margins
const IMAGE_THUMB_W = 192; // .shader-node__image-thumb max-width 180 + 6/6 margins
const FILE_NAME_H = 12; // .shader-node__file-name, one line
const LIST_PITCH = 19.2; // list-mode operand row pitch (matches ShaderNode)
const CHAR_W = 6.4; // approx px per header character at the 9px title font
const MIN_W = 72; // floor for an auto-width node
const W_PAD = 42; // sockets + labels on both sides of an auto-width node
// Rows-layout nodes that draw their ART above the rows (the colormap strip is
// deliberately left out — its footprint predates this table). A Map: the rows
// branch runs even when `def` is undefined, so `type` is an untrusted string out
// of a file, and a Record lookup of `constructor`/`__proto__` would make the
// body height NaN. Color Ramp: .shader-node__ramp-strip 12 + 4/2 margins;
// RGB Curves: .shader-node__curves-art 56 + 4/2 margins.
const ART_H: ReadonlyMap<string, number> = new Map([['colorRamp', 18], ['rgbCurves', 62]]);
// …and the WIDTH that art forces, which the title-length estimate cannot see:
// the strip is a fixed 96px (+ 6/6 margins + its 1px border each side), the
// curves art 72px. Without it a Color Ramp was reserved at the 72px floor and
// rendered 110px wide, so every recipe ending in one hung ~24px out of its
// frame (measured in Chrome, 2026-10-20). A floor: a longer title still wins.
const ART_W: ReadonlyMap<string, number> = new Map([['colorRamp', 110], ['rgbCurves', 86]]);

/**
 * Flow component types whose root element applies `transform: scale(costScale)`
 * (top-left origin): ShaderNode, ClockNode, PreviewNode, MathPreviewNode and
 * SoundNode, every card that prices itself live (`useLiveNodeCost`). The ONE
 * set — NodeEditor's drag-connect hit boxes (`nodeVisualSize`) read it too, so
 * what is reserved and what is aimed at cannot drift apart. (Sound joined
 * 2026-10-23: its card always scaled, and only its 0-point shipped price hid
 * that both copies of this set left it out.)
 */
export const COST_SCALED_TYPES: ReadonlySet<string> = new Set(['shader', 'clock', 'preview', 'mathPreview', 'sound']);

/**
 * The scale a cost-scaled card is DRAWN at — the number `useCostChrome` hands
 * the card itself, asked without React: its LIVE price (`nodeCostPoints`, the
 * selected device's override-aware table, which every cost-scaled card reads
 * through `useLiveNodeCost`) as the share of the device's 100 that
 * `getCostScale` grows a card by (`budgetPointsOf`). Under the 200-point
 * devices that is the old table-point rule, 1 + min(price / 80, 1) × 0.35, so
 * no default-device size moved when the display went to 100.
 *
 * Never the `data.cost` snapshot: nothing restamps it on an edit, so a bent
 * RGB Curves node (1 fresh, 40 once it bakes) was reserved ~20 px short until
 * 2026-10-10, and a noise card under the Steam Frame row would sit at its
 * shipped price. `edges` are the wires the price counts: NodeEditor passes the
 * canvas's own (a grown variadic fold costs base × (N−1)); the layout passes
 * `[]`, which lays a variadic node out at its two-operand price — its
 * list-mode HEIGHT already follows `inDegree`.
 */
export function drawnCostScale(node: AppNode, edges: AppEdge[]): number {
  return getCostScale(budgetPointsOf(nodeCostPoints(node, edges)));
}

export interface NodeSize {
  width: number;
  height: number;
}

type SizedNode = AppNode & {
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
};

/**
 * Estimate a node's rendered width/height (including the cost scale transform).
 * `inDegree` is the node's incoming-edge count, used to approximate how far a
 * chainable arithmetic node has grown into its taller list layout (and how many
 * channel rows an Output node shows).
 *
 * Approximate by design — dagre only needs footprints good enough for spacing
 * and overlap, and a slight over-estimate is safer than an overlap.
 */
export function estimateNodeSize(node: AppNode, inDegree = 0): NodeSize {
  const type = (node.data as { registryType?: string }).registryType ?? '';
  const def = NODE_REGISTRY.get(type);
  // The renderer is picked by the registry def (node.type mirrors it in real
  // graphs but test stubs default to 'shader'); group/note have no def. The
  // scale applies only in the cost-scaled branches below.
  const flowType = def ? getFlowNodeType(def) : ((node.type as string) ?? 'shader');
  const scale = drawnCostScale(node, []);

  // Fixed-footprint component types (dimensions from their CSS/canvas consts;
  // the colour swatch imports its real constant so auto-layout can't drift
  // from the rendered size).
  switch (flowType) {
    case 'preview': // noise nodes: 96×96 canvas + header (PreviewNode)
      return { width: 111 * scale, height: 127 * scale };
    case 'mathPreview': // sin/cos: 72×72 waveform plot + header + port row
      return { width: 87 * scale, height: 121 * scale };
    case 'clock': // time: 56×56 canvas + header + the speed row (ClockNode)
      return { width: 71 * scale, height: 112 * scale };
    case 'sound': // fixed footprint from soundGeometry.ts (SoundNode)
      return { width: SOUND_W * scale, height: (SOUND_HEADER_H + SOUND_BODY_H) * scale };
    case 'color': // borderless square swatch, no header, never cost-scaled
      return { width: COLOR_NODE_SIZE, height: COLOR_NODE_SIZE };
    case 'output': {
      // One node = one material: rows = exposed channels (floored by inDegree,
      // one wire one row) + the UNCONDITIONAL mesh-picker row. An estimate
      // cannot see the session's model, and 18px over beats dagre overlapping.
      const exposed = (node.data as { exposedPorts?: string[] }).exposedPorts?.length
        ?? OUTPUT_DEFAULT_EXPOSED.length;
      const rows = Math.max(exposed, inDegree, 1) + 1;
      return { width: 150, height: 34 + rows * 18 };
    }
    case 'raymarchOutput': {
      // RaymarchOutputNode: min-width 150 + header, four labelled sections
      // (Surface / Volume / Sky / Settings, 13 rows) with subdividers — the
      // Output's 18px row pitch and chrome.
      const rows = Math.max(13, inDegree);
      return { width: 150, height: 34 + 3 * 14 + rows * 18 };
    }
    case 'splatOutput': {
      // SplatOutputNode: the same chrome, labelled sections (Shade / Cut /
      // Shape, two subdividers, and a third before Light) and one 18px row
      // per EXPOSED real socket; four by default (SPLAT_DEFAULT_EXPOSED). A
      // listed Light socket counts lit or not: an unlit node still draws one a
      // wire reaches (utils/splatLight.ts, a dormant wire), and wires are not
      // visible here, so the unwired case over-estimates by a row — the safe
      // side. A tampered list counts only real sockets. The `inDegree` floor
      // stands in for rows a wire auto-exposed.
      const listed = (node.data as { exposedPorts?: unknown }).exposedPorts;
      const exposed: readonly unknown[] = Array.isArray(listed) ? listed : SPLAT_DEFAULT_EXPOSED;
      const ids = new Set(def?.inputs.map((p) => p.id) ?? []);
      const shownIds = new Set(exposed.filter((p): p is string => typeof p === 'string' && ids.has(p)));
      const lightBand = [...shownIds].some((p) => SPLAT_LIGHT_PORTS.includes(p)) ? 1 : 0;
      const rows = Math.max(shownIds.size, inDegree, 1);
      return { width: 150, height: 34 + (2 + lightBand) * 14 + rows * 18 };
    }
    case 'group':
    case 'note': {
      // Containers/annotations carry explicit dimensions (props or data).
      const sized = node as SizedNode;
      const dataDims = node.data as { width?: number; height?: number };
      return {
        width: sized.width ?? dataDims.width ?? 200,
        height: sized.height ?? dataDims.height ?? 120,
      };
    }
  }

  // 'shader' — the registry-driven ShaderNode layouts.
  const box = nodeBox(type); // designer overrides: exact width and/or body height

  // Width: honour the designer override, else grow with the title length.
  let width = box.width;
  if (width == null) {
    const label = String((node.data as { label?: string }).label ?? type);
    width = Math.max(MIN_W, Math.round(label.length * CHAR_W) + W_PAD, ART_W.get(type) ?? 0);
  }

  // Body height: designer override wins; otherwise derive from the layout.
  // Glyph OR socket-growing — the same predicate ShaderNode/NodeVisual gate on,
  // so the estimated footprint cannot describe a layout the node no longer uses
  // (`append` is the glyphless member; the `growsOperands` list-height floor
  // below only makes sense once it really enters that layout).
  const isOperator = usesOperatorLayout(def);
  let bodyH = box.height;
  if (bodyH == null) {
    if (isOperator) {
      const glyphPx = Math.round(34 * nodeScale(type));
      bodyH = Math.max(52, glyphPx + 10);
    } else {
      // An unknown node draws one row per BOUND reference (ShaderNode's
      // unknownCardDef) where its registry def lists no input.
      const inputRows = type === 'unknown'
        ? unknownRefSlots((node.data as { values?: Record<string, unknown> }).values ?? {}).length
        : def ? def.inputs.length : 1;
      const rows = Math.max(inputRows, def ? def.outputs.length : 1, 1);
      const glyph = hasNodeGlyph(type) ? GLYPH_H : 0;
      bodyH = Math.max(28, rows * ROW_H + glyph + 8) + (ART_H.get(type) ?? 0);
    }
  }

  // Image node: no port rows (edge ports, nodes/edgePorts.ts). Body = filename
  // + thumbnail or empty slot, floored by `edgePortRailHeight`, which is read
  // from the renderer's own module so the estimate cannot go stale.
  if (type === 'imageNode' && def) {
    const d = node.data as { values?: Record<string, unknown> };
    const hasImage = typeof d.values?.imageB64 === 'string' && d.values.imageB64 !== '';
    const thumb = hasImage ? IMAGE_THUMB_H : IMAGE_EMPTY_H;
    const fileRow = typeof d.values?.fileName === 'string' && d.values.fileName ? FILE_NAME_H : 0;
    if (box.height == null) {
      bodyH = Math.max(edgePortRailHeight(def.inputs.length, def.outputs.length), fileRow + thumb + 8);
    }
    if (box.width == null) width = Math.max(width, hasImage ? IMAGE_THUMB_W : MIN_W);
  }

  // A chainable arithmetic node with ≥3 wired operands folds into list mode and
  // grows vertically with the operand count (ShaderNode: (N−1)·pitch + 26).
  if (def != null && growsOperands(def) && inDegree >= 3) {
    bodyH = Math.max(bodyH, (inDegree - 1) * LIST_PITCH + 26);
  }

  return { width: width * scale, height: (HEADER_H + bodyH) * scale };
}

/**
 * Real rendered footprint when React Flow has measured the node (live editor —
 * the Organize action, or resync-surviving nodes). `measured` is the raw DOM
 * box, so cost-scaled component types multiply by the scale they are drawn at
 * (`drawnCostScale`) exactly like NodeEditor's drag-connect hit boxes do.
 * Returns null when unmeasured.
 */
export function measuredSize(node: AppNode): NodeSize | null {
  const m = (node as SizedNode).measured;
  if (!m?.width || !m?.height) return null;
  const s = COST_SCALED_TYPES.has(node.type ?? '') ? drawnCostScale(node, []) : 1;
  return { width: m.width * s, height: m.height * s };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A node's input SOCKET row: its index in what the node renders. */
export type SocketRank = (target: string, handle: string | null | undefined) => number;

/**
 * A `rankOrder` for `autoLayout` that reads every node's inputs in SOCKET
 * order: walking back from the sink's wires (`rootEdges`, top socket first),
 * each node is keyed when it is first reached and then visits its own inputs
 * top socket first. Within a column the keys therefore stack a node's feeders
 * the way its sockets read, which dagre — it knows nothing about handles —
 * cannot: the Mix Two Colors recipe put the Fresnel feeding Mix's bottom
 * socket (Factor) above the two Colors feeding A and B, and every wire into
 * the Mix crossed (owner, 2026-10-20). A node no root reaches gets no key and
 * keeps dagre's order, after the keyed ones.
 */
export function socketOrder(
  edges: readonly AppEdge[],
  rootEdges: readonly AppEdge[],
  socketRank: SocketRank,
): Map<string, number> {
  const bySocket = (a: AppEdge, b: AppEdge) =>
    socketRank(a.target, a.targetHandle) - socketRank(b.target, b.targetHandle);
  const into = new Map<string, AppEdge[]>();
  for (const e of edges) {
    const list = into.get(e.target);
    if (list) list.push(e);
    else into.set(e.target, [e]);
  }
  for (const list of into.values()) list.sort(bySocket);
  // Pre-order depth-first, iteratively: pushed in reverse, so the top socket's
  // source pops first, and a node reached twice keeps its FIRST key.
  const order = new Map<string, number>();
  const stack = [...rootEdges].sort(bySocket).reverse().map((e) => e.source);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (order.has(id)) continue;
    order.set(id, order.size);
    const ins = into.get(id) ?? [];
    for (let i = ins.length - 1; i >= 0; i--) stack.push(ins[i].source);
  }
  return order;
}

/**
 * How many pairs of wires into the SAME node arrive in the opposite order to
 * its sockets — the crossings a reader sees. A source's top edge stands in for
 * its wire's height (only the ORDER matters), wires from one node never count,
 * and a wire whose source is not in `laid` is skipped. `edges` may include
 * wires into a node that is not laid out (a dropped Output): only the sources
 * need positions.
 */
export function wireInversions(
  laid: readonly AppNode[],
  edges: readonly AppEdge[],
  socketRank: SocketRank,
): number {
  const top = new Map(laid.map((n) => [n.id, n.position.y]));
  const into = new Map<string, { y: number; row: number }[]>();
  for (const e of edges) {
    const y = top.get(e.source);
    if (y === undefined) continue;
    const wire = { y, row: socketRank(e.target, e.targetHandle) };
    const list = into.get(e.target);
    if (list) list.push(wire);
    else into.set(e.target, [wire]);
  }
  let inversions = 0;
  for (const wires of into.values()) {
    for (let i = 0; i < wires.length; i++) {
      for (let j = i + 1; j < wires.length; j++) {
        if (Math.sign(wires[i].y - wires[j].y) * Math.sign(wires[i].row - wires[j].row) < 0) inversions++;
      }
    }
  }
  return inversions;
}

/**
 * Auto-layout a graph left-to-right, keeping its TOP EDGE horizontal: it finds
 * the longest path through the graph (the visual "spine") and lays every node on
 * that path along one shared top baseline, so following the flow left-to-right
 * your eye tracks a straight horizontal line instead of zig-zagging. Branches
 * that feed the spine stack below it.
 *
 * dagre still does the hard structural work — assigning ranks (columns) and the
 * crossing-minimised order within each column — but its centre-based vertical
 * placement (which aligns node CENTRES and so leaves the top edges ragged
 * whenever heights differ) is replaced by a top-alignment sweep.
 *
 * `rankOrder` (optional) overrides the order WITHIN each rank: a node carrying
 * a smaller key is placed above one carrying a larger, and above every node
 * carrying none; dagre's own order breaks every tie, so a graph that supplies
 * no keys at all is laid out exactly as before. It exists because dagre knows
 * nothing about HANDLES — every wire into a node is the same wire to it — so a
 * caller that knows what the vertical order MEANS (the GLB import: each feeder
 * belongs to one Output socket) can stack the feeders in socket order instead.
 * It also switches OFF the spine float below: a caller that has stated the
 * order must not have one node pulled to the top of its rank behind its back.
 * Since step 5 places each rank strictly downward, the rank's array order IS
 * its vertical order, so the keys decide what the eye reads.
 */
export function autoLayout(
  nodes: AppNode[],
  edges: AppEdge[],
  spacing?: { nodesep?: number; ranksep?: number },
  rankOrder?: ReadonlyMap<string, number>,
): AppNode[] {
  if (nodes.length === 0) return nodes;

  const nodesep = spacing?.nodesep ?? 25;
  const ranksep = spacing?.ranksep ?? 60;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  // Real footprints for dagre (and reused by the top-alignment sweep below):
  // measured DOM boxes when available, estimates otherwise.
  const inDeg = new Map<string, number>();
  for (const e of validEdges) inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  const size = new Map<string, NodeSize>();
  for (const n of nodes) {
    size.set(n.id, measuredSize(n) ?? estimateNodeSize(n, inDeg.get(n.id) ?? 0));
  }

  // 1. dagre: ranks + within-rank ordering + horizontal (rank) coordinate.
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep, ranksep });
  for (const n of nodes) {
    const s = size.get(n.id)!;
    g.setNode(n.id, { width: s.width, height: s.height });
  }
  for (const e of validEdges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  // 2. Group into ranks by dagre's x (in LR every node in a rank shares one x),
  //    ordering each rank top→bottom by dagre's y (its crossing-minimised order).
  const dagreX = new Map<string, number>();
  const dagreY = new Map<string, number>();
  for (const n of nodes) {
    const pos = g.node(n.id);
    if (!pos) continue;
    dagreX.set(n.id, pos.x);
    dagreY.set(n.id, pos.y);
  }
  const laidIds = nodes.filter((n) => dagreX.has(n.id)).map((n) => n.id);
  const uniqueX = Array.from(new Set(laidIds.map((id) => Math.round(dagreX.get(id)!)))).sort(
    (a, b) => a - b,
  );
  const rankOfX = new Map(uniqueX.map((x, i) => [x, i]));
  const nodeRank = new Map<string, number>();
  for (const id of laidIds) nodeRank.set(id, rankOfX.get(Math.round(dagreX.get(id)!))!);

  const ranks: string[][] = uniqueX.map(() => []);
  for (const id of laidIds) ranks[nodeRank.get(id)!].push(id);
  // A caller-supplied key wins; a node without one sorts after every node with
  // one (never `ka - kb` on two undefineds, which is NaN). dagre's own order is
  // the tie-break, so no key means exactly the previous behaviour.
  const cmpOrder = (a: string, b: string): number => {
    if (!rankOrder) return 0;
    const ka = rankOrder.get(a);
    const kb = rankOrder.get(b);
    if (ka === undefined) return kb === undefined ? 0 : 1;
    if (kb === undefined) return -1;
    return ka - kb;
  };
  for (const rank of ranks) {
    rank.sort((a, b) => cmpOrder(a, b) || dagreY.get(a)! - dagreY.get(b)! || (a < b ? -1 : 1));
  }

  // Forward predecessors only (strictly lower rank) — guards against a back edge
  // referencing a not-yet-placed node and keeps the spine DP acyclic.
  const preds = new Map<string, string[]>();
  for (const e of validEdges) {
    const rs = nodeRank.get(e.source);
    const rt = nodeRank.get(e.target);
    if (rs == null || rt == null || rs >= rt) continue;
    const list = preds.get(e.target);
    if (list) list.push(e.source);
    else preds.set(e.target, [e.source]);
  }

  // 3. Spine = the longest path through the graph (max node count, tie-broken by
  //    accumulated cost then id). DP in ascending rank order — every predecessor
  //    is a strictly lower rank, so it's already resolved.
  const costMap = new Map<string, number>();
  // A snapshot out of a file can be anything; storedCost keeps the sum a number.
  for (const n of nodes) costMap.set(n.id, storedCost((n.data as { cost?: unknown }).cost));
  const costOf = (id: string) => costMap.get(id) ?? 0;
  const bestLen = new Map<string, number>();
  const bestCost = new Map<string, number>();
  const chosenPred = new Map<string, string | null>();
  let spineEnd: string | null = null;
  for (const rank of ranks) {
    for (const id of rank) {
      let len = 1;
      let pathCost = costOf(id);
      let pick: string | null = null;
      for (const p of preds.get(id) ?? []) {
        const cand = (bestLen.get(p) ?? 0) + 1;
        const candCost = (bestCost.get(p) ?? 0) + costOf(id);
        if (
          cand > len ||
          (cand === len && candCost > pathCost) ||
          (cand === len && candCost === pathCost && pick != null && p < pick)
        ) {
          len = cand;
          pathCost = candCost;
          pick = p;
        }
      }
      bestLen.set(id, len);
      bestCost.set(id, pathCost);
      chosenPred.set(id, pick);
      if (
        spineEnd == null ||
        len > bestLen.get(spineEnd)! ||
        (len === bestLen.get(spineEnd)! && pathCost > bestCost.get(spineEnd)!)
      ) {
        spineEnd = id;
      }
    }
  }
  const onSpine = new Set<string>();
  const spinePrev = new Map<string, string>();
  let cursor: string | null = spineEnd;
  while (cursor != null) {
    onSpine.add(cursor);
    const prev = chosenPred.get(cursor) ?? null;
    if (prev != null) spinePrev.set(cursor, prev);
    cursor = prev;
  }

  // 4. Float the spine node to the top of every rank it appears in — a proper
  //    layering puts at most one spine node per rank, so this never reorders two.
  //    SKIPPED when the caller gave a rank order: pulling one node to the top
  //    would silently overrule exactly the order it asked for (measured on a
  //    GLB import — the longest chain is the roughness texture × factor, so
  //    Roughness landed above Color).
  if (!rankOrder) {
    for (const rank of ranks) {
      const i = rank.findIndex((id) => onSpine.has(id));
      if (i > 0) {
        const [s] = rank.splice(i, 1);
        rank.unshift(s);
      }
    }
  }

  // 5. Top-alignment sweep. A spine node inherits its spine predecessor's top, so
  //    consecutive spine nodes share one baseline; being first in its rank, no
  //    node above can push it down → the whole spine stays a flat horizontal top.
  //    Other nodes aim for the median of their predecessors' tops, then drop as
  //    far as needed to clear the node above them in the same rank.
  const topOf = new Map<string, number>();
  for (const rank of ranks) {
    let prevBottom = -Infinity;
    for (const id of rank) {
      const h = size.get(id)!.height;
      let desired: number;
      const sp = spinePrev.get(id);
      if (onSpine.has(id) && sp != null && topOf.has(sp)) {
        desired = topOf.get(sp)!;
      } else {
        const parentTops = (preds.get(id) ?? [])
          .filter((p) => topOf.has(p))
          .map((p) => topOf.get(p)!);
        desired = parentTops.length
          ? median(parentTops)
          : prevBottom === -Infinity
            ? 0
            : prevBottom + nodesep;
      }
      const minTop = prevBottom === -Infinity ? -Infinity : prevBottom + nodesep;
      const top = Math.max(desired, minTop);
      topOf.set(id, top);
      prevBottom = top + h;
    }
  }

  // 6. Emit top-left positions: x from dagre's rank coordinate, y from the sweep.
  return nodes.map((node) => {
    const cx = dagreX.get(node.id);
    const top = topOf.get(node.id);
    if (cx == null || top == null) return node;
    return { ...node, position: { x: cx - size.get(node.id)!.width / 2, y: top } };
  });
}

/**
 * Organize (the canvas menu's Selection → Organize, `organizeSelection`): the
 * NEW absolute positions of the selected nodes, or null when fewer than two
 * would move. Notes stay put; a node whose group is also selected rides with
 * it. The units are laid out by `autoLayout` (measured boxes win) and the
 * result is translated back onto the selection's old top-left corner, so the
 * organized cluster stays where the user had it. Pure — the store applies it
 * (re-parenting group members), and the intro's Organize slide plays it.
 */
export function organizeLayout(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
): Map<string, { x: number; y: number }> | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const selected = nodes.filter((n) => n.selected && n.type !== 'note');
  if (selected.length < 2) return null;
  const selectedIds = new Set(selected.map((n) => n.id));

  // Layout units: a selected node rides with its parent when that parent (or
  // any ancestor group) is also selected — laying both out independently
  // would move the member twice.
  const hasSelectedAncestor = (n: AppNode): boolean => {
    let pid = n.parentId;
    while (pid) {
      if (selectedIds.has(pid)) return true;
      pid = byId.get(pid)?.parentId;
    }
    return false;
  };
  const units = selected.filter((n) => !hasSelectedAncestor(n));
  if (units.length < 2) return null;
  const unitIds = new Set(units.map((n) => n.id));

  // Absolute position of a (possibly group-nested) node.
  const absOf = (n: AppNode): { x: number; y: number } => {
    let x = n.position.x;
    let y = n.position.y;
    let pid = n.parentId;
    while (pid) {
      const p = byId.get(pid);
      if (!p) break;
      x += p.position.x;
      y += p.position.y;
      pid = p.parentId;
    }
    return { x, y };
  };

  // Edges between units, with endpoints lifted to their unit: an edge into a
  // selected group's member connects the GROUP unit (collapsed groups already
  // carry rewritten boundary edges pointing at the group node itself).
  const unitOf = (id: string): string | null => {
    let n = byId.get(id);
    while (n) {
      if (unitIds.has(n.id)) return n.id;
      n = n.parentId ? byId.get(n.parentId) : undefined;
    }
    return null;
  };
  const seenPairs = new Set<string>();
  const unitEdges: AppEdge[] = [];
  for (const e of edges) {
    const src = unitOf(e.source);
    const tgt = unitOf(e.target);
    if (!src || !tgt || src === tgt) continue;
    const key = `${src}\0${tgt}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    unitEdges.push({ ...e, source: src, target: tgt });
  }

  // Lay out the units in absolute space (autoLayout assigns fresh positions;
  // spreading keeps `measured` on each node so the real DOM boxes are used),
  // then translate the result back onto the selection's old top-left corner.
  const absUnits = units.map((n) => ({ ...n, position: absOf(n) }) as AppNode);
  const laid = autoLayout(absUnits, unitEdges);
  let oldMinX = Infinity, oldMinY = Infinity, newMinX = Infinity, newMinY = Infinity;
  for (const n of absUnits) {
    oldMinX = Math.min(oldMinX, n.position.x);
    oldMinY = Math.min(oldMinY, n.position.y);
  }
  for (const n of laid) {
    newMinX = Math.min(newMinX, n.position.x);
    newMinY = Math.min(newMinY, n.position.y);
  }
  const dx = oldMinX - newMinX;
  const dy = oldMinY - newMinY;
  return new Map(laid.map((n) => [n.id, { x: n.position.x + dx, y: n.position.y + dy }]));
}
