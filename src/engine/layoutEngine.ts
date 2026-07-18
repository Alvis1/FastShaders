import dagre from '@dagrejs/dagre';
import type { AppNode, AppEdge } from '@/types';
import { getCostScale } from '@/utils/colorUtils';
import { NODE_REGISTRY, growsOperands, getFlowNodeType } from '@/registry/nodeRegistry';
import { nodeBox, hasNodeGlyph, nodeScale } from '@/components/NodeEditor/nodes/glyphs/NodeGlyph';

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
const LIST_PITCH = 19.2; // list-mode operand row pitch (matches ShaderNode)
const CHAR_W = 6.4; // approx px per header character at the 9px title font
const MIN_W = 72; // floor for an auto-width node
const W_PAD = 42; // sockets + labels on both sides of an auto-width node

// Flow component types whose root element applies `transform: scale(costScale)`
// (top-left origin) — the same set NodeEditor's drag-connect hit boxes scale.
const COST_SCALED_TYPES = new Set(['shader', 'clock', 'preview', 'mathPreview']);

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
  const cost = (node.data as { cost?: number }).cost ?? 0;
  const scale = getCostScale(cost);
  // The renderer is picked by the registry def (node.type mirrors it in real
  // graphs but test stubs default to 'shader'); group/note have no def.
  const flowType = def ? getFlowNodeType(def) : ((node.type as string) ?? 'shader');

  // Fixed-footprint component types (dimensions from their CSS/canvas consts).
  switch (flowType) {
    case 'preview': // noise nodes: 96×96 canvas + header (PreviewNode)
      return { width: 111 * scale, height: 127 * scale };
    case 'mathPreview': // sin/cos: 72×72 canvas + header + port row
      return { width: 87 * scale, height: 121 * scale };
    case 'clock': // time: 56×56 canvas + header
      return { width: 71 * scale, height: 87 * scale };
    case 'color': // borderless 28×28 swatch, no header, never cost-scaled
      return { width: 28, height: 28 };
    case 'output': {
      // min-width 140 + header + one row per visible channel (colour + exposed).
      const exposed = (node.data as { exposedPorts?: string[] }).exposedPorts?.length ?? 0;
      const rows = Math.max(1 + exposed, inDegree, 1);
      return { width: 150, height: 34 + rows * 18 };
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
    width = Math.max(MIN_W, Math.round(label.length * CHAR_W) + W_PAD);
  }

  // Body height: designer override wins; otherwise derive from the layout.
  const isOperator = def != null && hasNodeGlyph(type) && def.inputs.length === 2;
  let bodyH = box.height;
  if (bodyH == null) {
    if (isOperator) {
      const glyphPx = Math.round(34 * nodeScale(type));
      bodyH = Math.max(52, glyphPx + 10);
    } else {
      const rows = Math.max(def ? def.inputs.length : 1, def ? def.outputs.length : 1, 1);
      const glyph = hasNodeGlyph(type) ? GLYPH_H : 0;
      bodyH = Math.max(28, rows * ROW_H + glyph + 8);
    }
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
 * box, so cost-scaled component types multiply by getCostScale exactly like
 * NodeEditor's drag-connect hit boxes do. Returns null when unmeasured.
 */
export function measuredSize(node: AppNode): NodeSize | null {
  const m = (node as SizedNode).measured;
  if (!m?.width || !m?.height) return null;
  const cost = (node.data as { cost?: number }).cost ?? 0;
  const s = COST_SCALED_TYPES.has(node.type ?? '') ? getCostScale(cost) : 1;
  return { width: m.width * s, height: m.height * s };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Auto-layout a graph left-to-right (or top-to-bottom).
 *
 * For the default LR flow this keeps the graph's TOP EDGE horizontal: it finds
 * the longest path through the graph (the visual "spine") and lays every node on
 * that path along one shared top baseline, so following the flow left-to-right
 * your eye tracks a straight horizontal line instead of zig-zagging. Branches
 * that feed the spine stack below it.
 *
 * dagre still does the hard structural work — assigning ranks (columns) and the
 * crossing-minimised order within each column — but its centre-based vertical
 * placement (which aligns node CENTRES and so leaves the top edges ragged
 * whenever heights differ) is replaced by a top-alignment sweep.
 */
export function autoLayout(
  nodes: AppNode[],
  edges: AppEdge[],
  direction: 'LR' | 'TB' = 'LR',
  spacing?: { nodesep?: number; ranksep?: number },
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
  g.setGraph({ rankdir: direction, nodesep, ranksep });
  for (const n of nodes) {
    const s = size.get(n.id)!;
    g.setNode(n.id, { width: s.width, height: s.height });
  }
  for (const e of validEdges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  // Non-LR (unused today) keeps dagre's centre placement unchanged.
  if (direction !== 'LR') {
    return nodes.map((node) => {
      const pos = g.node(node.id);
      if (!pos) return node;
      return { ...node, position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 } };
    });
  }

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
  for (const rank of ranks) rank.sort((a, b) => dagreY.get(a)! - dagreY.get(b)! || (a < b ? -1 : 1));

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
  for (const n of nodes) costMap.set(n.id, (n.data as { cost?: number }).cost ?? 0);
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
  for (const rank of ranks) {
    const i = rank.findIndex((id) => onSpine.has(id));
    if (i > 0) {
      const [s] = rank.splice(i, 1);
      rank.unshift(s);
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
