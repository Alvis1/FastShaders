/**
 * The PURE half of a running lesson: does the live graph satisfy the current
 * step, which node plays which role, what to highlight, where "Do it for me"
 * should put a node. Never imports the store — the panel feeds it `nodes` and
 * `edges` from store selectors, and `tutorialAutoStep.ts` does the writing.
 */

import type { AppNode, AppEdge, MaterialSettings, NodeDefinition } from '@/types';
import { getNodeValues, outputNodeValues } from '@/types';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { effectiveExposedPorts } from '@/utils/exposedPorts';
import { valueNum, valueStr } from '@/utils/valueCoerce';
import { validImageDataUrl } from '@/utils/imageNode';
import { NODE_REGISTRY, getFlowNodeType } from '@/registry/nodeRegistry';
import { COST_SCALED_TYPES, drawnCostScale, estimateNodeSize } from '@/engine/layoutEngine';
import { absoluteNodePosition, measuredNodeSize } from '@/utils/groupFrame';
import { freeFrameSpot, placementObstacles, LIBRARY_PLACE_PAD, LIBRARY_WIRE_GAP } from '@/utils/libraryAutoWire';
import { findTutorial } from './tutorialDefs';
import { OUT_ROLE } from './tutorialTypes';
import type { AddStep, TutorialDef, TutorialRun, TutorialStep } from './tutorialTypes';

export type Bindings = Readonly<Record<string, string>>;

export type StepStatus = 'satisfied' | 'pending' | 'broken';

export interface StepEval {
  status: StepStatus;
  /** An `add` step met by a node not yet bound: the panel commits this binding. */
  bind?: readonly [role: string, nodeId: string];
  /** `broken`: a role the step needs has no node on the canvas any more. */
  missingRole?: string;
  /** `pending` on an `add`: the newest unbound node is of another type — a soft hint. */
  wrongType?: string;
  /** `pending` on an Image `add`: the newest unbound node IS an Image node, but
   *  it holds no picture yet (a palette press adds one empty). */
  needsPicture?: true;
}

/** The step on screen, or undefined on the finish screen / an unknown lesson. */
export function currentStep(def: TutorialDef | undefined, run: TutorialRun | null): TutorialStep | undefined {
  return def && run ? def.steps[run.step] : undefined;
}

const registryTypeOf = (n: AppNode): string => String((n.data as { registryType?: unknown })?.registryType ?? '');

/** The one type whose node an `add` step accepts only once it holds a picture:
 *  an empty Image node samples nothing, and the caption after it ("the ball
 *  now mirrors the picture") would be false. */
export const PICTURE_TYPE = 'imageNode';

/** Does `n` hold a picture its card and its shader would actually show? */
export function holdsPicture(n: AppNode): boolean {
  return validImageDataUrl(getNodeValues(n).imageB64) !== null;
}

/** Is `n` a node this `add` step accepts: its type, and for an Image node a picture? */
const meetsAdd = (step: AddStep, n: AppNode): boolean =>
  registryTypeOf(n) === step.type && (step.type !== PICTURE_TYPE || holdsPicture(n));

/** The node bound to `role`, or null when unbound or gone. */
function boundNode(role: string, bindings: Bindings, nodes: readonly AppNode[]): AppNode | null {
  const id = bindings[role];
  if (!id) return null;
  return nodes.find((n) => n.id === id) ?? null;
}

/** Stored values of a node, through the accessor its flow type requires. */
function storedValues(node: AppNode): Record<string, string | number> {
  return node.type === 'output' ? outputNodeValues(node.data) : getNodeValues(node);
}

const HEX6 = /^#[0-9a-f]{6}$/i;

/** Does a stored (adversarial) value equal an authored one? Numbers within a
 *  tolerance, `#rrggbb` case-free, other strings exactly. */
export function valueMatches(stored: unknown, expected: number | string, tolerance = 1e-6): boolean {
  if (typeof expected === 'number') {
    const n = valueNum(stored);
    return Number.isFinite(n) && Math.abs(n - expected) <= tolerance;
  }
  const s = valueStr(stored);
  if (HEX6.test(expected)) return s.toLowerCase() === expected.toLowerCase();
  return s === expected;
}

function materialSettingsOf(node: AppNode): MaterialSettings {
  const s = (node.data as { materialSettings?: unknown }).materialSettings;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as MaterialSettings) : {};
}

/** Is this Output channel a visible socket — and, for Opacity, READ (Transparent on, or an Alpha Clip)? */
export function channelExposed(node: AppNode, handle: string): boolean {
  if (!effectiveExposedPorts(node).includes(handle)) return false;
  if (handle !== 'opacity') return true;
  const ms = materialSettingsOf(node);
  return ms.transparent === true || (typeof ms.alphaTest === 'number' && ms.alphaTest > 0);
}

/**
 * Does the live graph satisfy `step`? Pure over `(bindings, nodes, edges)`;
 * wires are read on the UNWRAPPED graph so one drawn from a collapsed group's
 * pill counts like every engine counts it.
 */
export function evaluateStep(
  step: TutorialStep,
  bindings: Bindings,
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
): StepEval {
  switch (step.kind) {
    case 'look':
      return { status: 'satisfied' };
    case 'add': {
      const bound = boundNode(step.role, bindings, nodes);
      if (bound && meetsAdd(step, bound)) return { status: 'satisfied' };
      const taken = new Set(Object.values(bindings));
      // Newest first: the node the user just added is the one they mean.
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (taken.has(n.id) || n.type === 'group' || n.type === 'note') continue;
        if (meetsAdd(step, n)) return { status: 'satisfied', bind: [step.role, n.id] };
      }
      const newest = [...nodes].reverse().find((n) => !taken.has(n.id) && n.type !== 'group' && n.type !== 'note');
      if (!newest) return { status: 'pending' };
      // The right type without its picture is not a wrong node, it is an unfinished one.
      if (registryTypeOf(newest) === step.type) return { status: 'pending', needsPicture: true };
      return { status: 'pending', wrongType: registryTypeOf(newest) };
    }
    case 'wire': {
      const src = boundNode(step.from[0], bindings, nodes);
      if (!src) return { status: 'broken', missingRole: step.from[0] };
      const tgt = boundNode(step.to[0], bindings, nodes);
      if (!tgt) return { status: 'broken', missingRole: step.to[0] };
      const live = unwrapCollapsedGroupEdges([...nodes], [...edges]);
      const hit = live.some(
        (e) =>
          e.source === src.id &&
          (e.sourceHandle ?? 'out') === step.from[1] &&
          e.target === tgt.id &&
          e.targetHandle === step.to[1],
      );
      return { status: hit ? 'satisfied' : 'pending' };
    }
    case 'set': {
      const node = boundNode(step.role, bindings, nodes);
      if (!node) return { status: 'broken', missingRole: step.role };
      return { status: valueMatches(storedValues(node)[step.key], step.value, step.tolerance) ? 'satisfied' : 'pending' };
    }
    case 'expose': {
      const node = boundNode(step.role, bindings, nodes);
      if (!node) return { status: 'broken', missingRole: step.role };
      return { status: channelExposed(node, step.handle) ? 'satisfied' : 'pending' };
    }
  }
}

/** Drop every binding whose node has left the canvas (an undo, a delete). */
export function reconcileBindings(
  bindings: Bindings,
  nodes: readonly AppNode[],
): { bindings: Bindings; dropped: string[] } {
  const ids = new Set(nodes.map((n) => n.id));
  const dropped = Object.keys(bindings).filter((role) => !ids.has(bindings[role]));
  if (dropped.length === 0) return { bindings, dropped };
  const next: Record<string, string> = {};
  for (const [role, id] of Object.entries(bindings)) if (ids.has(id)) next[role] = id;
  return { bindings: next, dropped };
}

/** The node type the current step asks the user to ADD — the palette tile to
 *  highlight — or null on every other step and outside a lesson. */
export function wantedNodeType(run: TutorialRun | null): string | null {
  if (!run || run.phase !== 'run') return null;
  const step = currentStep(findTutorial(run.id), run);
  return step?.kind === 'add' ? step.type : null;
}

/**
 * The values the running lesson's current `add` step gives a node of `type` —
 * what the two add surfaces (the tile drop and the Add-node menu) lay over a
 * fresh node's own values, so a node added BY HAND is the node "Do it for me"
 * would have made. Undefined on every other step, for another type, and
 * outside a lesson, which leaves every ordinary add byte-identical.
 */
export function wantedNodeValues(
  run: TutorialRun | null,
  type: string,
): Readonly<Record<string, number | string>> | undefined {
  if (!run || run.phase !== 'run') return undefined;
  const step = currentStep(findTutorial(run.id), run);
  return step?.kind === 'add' && step.type === type ? step.values : undefined;
}

/**
 * The node whose HIDDEN parameter sockets the current step needs on screen:
 * the target of a `wire` step. A noise card mounts `pos` / `scale` only while
 * a wire is hunting near it (connectionReveal.ts), so a step that says "wire
 * Add into the noise's pos input" pointed at a socket that was not there. The
 * card asks this and draws them, dimmed, for as long as the step is on screen
 * (PreviewNode); null on every other step and outside a lesson.
 */
export function lessonRevealNode(run: TutorialRun | null): string | null {
  if (!run || run.phase !== 'run') return null;
  const step = currentStep(findTutorial(run.id), run);
  return step?.kind === 'wire' ? run.bindings[step.to[0]] ?? null : null;
}

export interface StepTargets {
  nodes: string[];
  handles: Array<readonly [nodeId: string, kind: 'source' | 'target', handle: string]>;
  /** Nodes whose socket labels are held open while the step is on screen —
   *  the double-click label peek (labelPeek.ts), set by the lesson. */
  labels: string[];
}

/**
 * What the canvas marks for this step: the sockets a wire must join, the node
 * a value lives on — and, on every node the step is ABOUT, its socket labels.
 * A caption names sockets ("wire Fract into Multiply's A", "set In Low to
 * -1") that the cards never print: a socket's name is its tooltip, so without
 * the labels the reader had to hover each dot to find the one meant. The node
 * an `add` step just made shows its names too (its caption is the one that
 * explains them), and a `look` step lists its own (`show`). An `add` still
 * marks no node and no socket — its tile is marked instead. The Output is
 * never labelled: its rows print their channel names, the reason the
 * drag-reveal leaves it out as well (connectionReveal.ts).
 */
export function stepTargets(step: TutorialStep, bindings: Bindings): StepTargets {
  const out: StepTargets = { nodes: [], handles: [], labels: [] };
  const id = (role: string) => bindings[role];
  const label = (role: string) => {
    const n = id(role);
    if (n && role !== OUT_ROLE && !out.labels.includes(n)) out.labels.push(n);
  };
  switch (step.kind) {
    case 'add':
      label(step.role);
      break;
    case 'wire': {
      const s = id(step.from[0]);
      const t = id(step.to[0]);
      if (s) { out.nodes.push(s); out.handles.push([s, 'source', step.from[1]]); }
      if (t) { out.nodes.push(t); out.handles.push([t, 'target', step.to[1]]); }
      label(step.from[0]);
      label(step.to[0]);
      break;
    }
    case 'set':
    case 'expose': {
      const n = id(step.role);
      if (n) out.nodes.push(n);
      label(step.role);
      break;
    }
    case 'look':
      for (const role of step.show ?? []) label(role);
      break;
  }
  return out;
}

/** The narrowest footprint a new card is planned at — the layout engine's own
 *  floor for an auto-width node. See `planAddPosition`. */
export const PLANNED_MIN_W = 72;
/** Height added to the estimate for a title that wraps onto a second row. */
export const PLANNED_TITLE_SLACK = 8;

/** A card as it is DRAWN, for the planner's obstacles (libraryAutoWire's `drawnScale`). */
const drawnScaleOf = (n: AppNode): number => (COST_SCALED_TYPES.has(n.type ?? '') ? drawnCostScale(n, []) : 1);

/** Vertical clearance between two planned cards in one column. */
export const PLANNED_ROW_GAP = 32;

interface PlanWire {
  from: string;
  to: string;
  toHandle: string;
}

interface PlanBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The card a node of `type` is planned at — see `planAddPosition` for the two floors. */
function plannedSize(type: string, values: Readonly<Record<string, unknown>> | undefined): { w: number; h: number } {
  const def = NODE_REGISTRY.get(type);
  if (!def) return { w: PLANNED_MIN_W, h: 60 + PLANNED_TITLE_SLACK };
  const stub = {
    id: '__tutorial_new__',
    type: getFlowNodeType(def),
    position: { x: 0, y: 0 },
    data: { registryType: def.type, label: def.label, cost: 0, values: { ...def.defaultValues, ...values } },
  } as unknown as AppNode;
  const est = estimateNodeSize(stub);
  return { w: Math.max(est.width, PLANNED_MIN_W), h: est.height + PLANNED_TITLE_SLACK };
}

/** Enough of a picture for the size estimate, which asks only whether there is one. */
const WITH_PICTURE = { imageB64: 'picture', fileName: 'picture' } as const;

/** Where `handle` sits among a node type's input sockets, top first (the Output's rows follow its def too). */
function socketRank(type: string, handle: string): number {
  const def = NODE_REGISTRY.get(type);
  if (!def) return 0;
  const ids = [...def.inputs.map((p) => p.id), ...Object.keys(def.defaultValues ?? {})];
  const i = ids.indexOf(handle);
  return i < 0 ? ids.length : i;
}

export interface LessonLayout {
  /** role → its column: the Output is 0, a node k wires upstream of it is k. */
  column: ReadonlyMap<string, number>;
  /** role → the node whose ROW it follows: the one it feeds in the next column right. */
  consumer: ReadonlyMap<string, string>;
  /** role → its planned card, top-left relative to the Output's top-left. */
  box: ReadonlyMap<string, PlanBox>;
}

/**
 * The lesson's whole graph laid out once, from its steps alone: a column per
 * distance from the Output and, inside a column, the order of the sockets
 * each node feeds — so no two of the lesson's wires cross and none runs
 * backwards.
 *
 * - A node's COLUMN is its longest path to the Output over EVERY wire the
 *   lesson draws, the ones a later step replaces included. Stripes wires Split
 *   straight into the Output before Fract and the ramp come between them, so
 *   Split is planned three columns out from the start and the later nodes drop
 *   into the gap it left, onto the wire they are about to split.
 * - Its ROW follows the node it feeds in the next column right — through the
 *   wire that SURVIVES the lesson where there is one (Holes wires Greater Than
 *   into Color first and into Discard for good, so it belongs beside Discard),
 *   else the first. Each node's feeders stack in the order of the sockets they
 *   feed, top first, and every subtree keeps a band of its own, so the stack
 *   never folds back over a neighbour's wires; the Output's feeders hang from
 *   its top edge, where its first rows are, every other stack is centred on
 *   the card it feeds.
 * - A column is as wide as its widest planned card, each card's OUTPUT side
 *   flush with the column's right edge, so every wire out of a column starts
 *   at one x.
 */
export function lessonLayout(steps: readonly TutorialStep[]): LessonLayout {
  const types = new Map<string, string>([[OUT_ROLE, 'output']]);
  const sizes = new Map<string, { w: number; h: number }>();
  const addedAt = new Map<string, number>();
  const wires: PlanWire[] = [];
  steps.forEach((s, i) => {
    if (s.kind === 'add' && !types.has(s.role)) {
      types.set(s.role, s.type);
      addedAt.set(s.role, i);
      // An Image step's node arrives WITH a picture (it counts only then), and a
      // card with a thumbnail is wider and taller than the empty slot: plan that one.
      sizes.set(s.role, plannedSize(s.type, s.type === PICTURE_TYPE ? WITH_PICTURE : s.values));
    } else if (s.kind === 'wire') {
      wires.push({ from: s.from[0], to: s.to[0], toHandle: s.to[1] });
    }
  });
  const known = wires.filter((w) => types.has(w.from) && types.has(w.to) && w.from !== OUT_ROLE);
  // The wire each input ends the lesson with: one wire per input, the last one drawn wins.
  const last = new Map<string, PlanWire>();
  for (const w of known) last.set(`${w.to}\u0000${w.toHandle}`, w);
  const survives = (w: PlanWire) => last.get(`${w.to}\u0000${w.toHandle}`) === w;

  const column = new Map<string, number>([[OUT_ROLE, 0]]);
  const visiting = new Set<string>();
  const columnOf = (role: string): number => {
    const seen = column.get(role);
    if (seen !== undefined) return seen;
    if (visiting.has(role)) return 1; // a cycle no lesson draws; never recurse forever
    visiting.add(role);
    let c = 1;
    for (const w of known) if (w.from === role) c = Math.max(c, columnOf(w.to) + 1);
    visiting.delete(role);
    column.set(role, c);
    return c;
  };
  for (const role of types.keys()) columnOf(role);

  const roles = [...types.keys()].filter((r) => r !== OUT_ROLE);
  const consumer = new Map<string, string>();
  const feeds = new Map<string, PlanWire>();
  const children = new Map<string, string[]>();
  for (const role of roles) {
    const next = known.filter((w) => w.from === role && column.get(w.to) === column.get(role)! - 1);
    const w = next.find(survives) ?? next[0];
    const parent = w?.to ?? OUT_ROLE;
    consumer.set(role, parent);
    if (w) feeds.set(role, w);
    children.set(parent, [...(children.get(parent) ?? []), role]);
  }
  const rank = (role: string): number => {
    const w = feeds.get(role);
    return w ? socketRank(types.get(w.to)!, w.toHandle) : Number.MAX_SAFE_INTEGER;
  };
  for (const list of children.values()) list.sort((a, b) => rank(a) - rank(b) || addedAt.get(a)! - addedAt.get(b)!);

  // Each subtree's band: its own card, or its feeders' stack when that is taller.
  const band = new Map<string, number>();
  const stackOf = (role: string): number => {
    const kids = children.get(role) ?? [];
    return kids.reduce((sum, k) => sum + bandOf(k), 0) + PLANNED_ROW_GAP * Math.max(0, kids.length - 1);
  };
  const bandOf = (role: string): number => {
    const seen = band.get(role);
    if (seen !== undefined) return seen;
    const b = Math.max(sizes.get(role)!.h, stackOf(role));
    band.set(role, b);
    return b;
  };

  const widest: number[] = [];
  for (const role of roles) {
    const c = column.get(role)!;
    widest[c] = Math.max(widest[c] ?? 0, sizes.get(role)!.w);
  }
  const rightEdge: number[] = [0];
  for (let c = 1; c < widest.length; c++) rightEdge[c] = rightEdge[c - 1] - (c > 1 ? widest[c - 1] ?? 0 : 0) - LIBRARY_WIRE_GAP;

  const box = new Map<string, PlanBox>();
  const stack = (parent: string, top: number) => {
    let y = top;
    for (const role of children.get(parent) ?? []) {
      const { w, h } = sizes.get(role)!;
      const b = bandOf(role);
      const mid = y + b / 2;
      box.set(role, { x: rightEdge[column.get(role)!] - w, y: mid - h / 2, w, h });
      stack(role, mid - stackOf(role) / 2);
      y += b + PLANNED_ROW_GAP;
    }
  };
  stack(OUT_ROLE, 0);
  return { column, consumer, box };
}

/** Do two boxes come closer than `pad`? */
function crowd(a: PlanBox, b: PlanBox, pad: number): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** A node's card as it is DRAWN, in absolute flow px. */
function drawnBox(n: AppNode, byId: ReadonlyMap<string, AppNode>): PlanBox {
  const at = absoluteNodePosition(n, byId);
  const { w, h } = measuredNodeSize(n);
  const s = drawnScaleOf(n);
  return { x: at.x, y: at.y, w: w * s, h: h * s };
}

/**
 * Where "Do it for me" puts a new node: its spot in the lesson's own layout
 * (`lessonLayout`), laid against the nearest node DOWNSTREAM of it that is
 * already on the canvas — the node it feeds, or the one that feeds, … up to
 * the Output — so a card the user moved takes its feeders with it. Then, if
 * that spot is taken, the nearest free one UP or DOWN the same column, never
 * across: a slide sideways is what put Stripes' Split left of the UV it reads
 * and crossed its wires (measured in the app, 2026-11-13). And never past a
 * planned neighbour already in the column: a node planned below Mix's A
 * feeder stays below it, whatever is nearer, so the stack keeps the socket
 * order and the wires stay apart. A dagre layout of the canvas was rejected
 * long ago: it would move nodes the user placed.
 *
 * Two sizes are deliberately NOT the layout engine's plain numbers (measured
 * in the app, 2026-11-12, over every type a lesson adds). The NEW card is
 * planned at least `PLANNED_MIN_W` wide and a title row taller: a design's
 * exact `width` (Smoothstep 25, Position 24) is the BODY's, and the header —
 * which prints the generated variable name the planner cannot know — widens
 * the drawn card to 67 and 57, so a spot flush against a neighbour sat 40 px
 * inside it (Circle's Smoothstep, Which Space?'s Position). And every card
 * already there is an obstacle at the size it is DRAWN (`drawnScaleOf`), or a
 * node tucked under an expensive noise landed on its lower edge.
 */
export function planAddPosition(
  def: NodeDefinition,
  stepIndex: number,
  steps: readonly TutorialStep[],
  bindings: Bindings,
  nodes: readonly AppNode[],
): { x: number; y: number } {
  const step = steps[stepIndex];
  const role = step?.kind === 'add' ? step.role : '';
  const layout = lessonLayout(steps);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed = (r: string): AppNode | undefined => byId.get(bindings[r] ?? '');
  const planned = layout.box.get(role);
  const unplanned = plannedSize(def.type, undefined);
  // A step that is not an add (no lesson calls it so): left of the Output, level with its top.
  const size = planned ?? { ...unplanned, x: -LIBRARY_WIRE_GAP - unplanned.w, y: 0 };
  const { w, h } = size;

  // The nearest node downstream that is on the canvas; the Output, else any node, as the last resort.
  let down: string | undefined = layout.consumer.get(role) ?? OUT_ROLE;
  while (down && down !== OUT_ROLE && !placed(down)) down = layout.consumer.get(down) ?? OUT_ROLE;
  const anchorRole = down ?? OUT_ROLE;
  const anchor = placed(anchorRole) ?? placed(OUT_ROLE) ?? nodes[0];
  if (!anchor) return { x: 0, y: 0 };
  const a = drawnBox(anchor, byId);
  const ref = anchorRole !== OUT_ROLE && anchor === placed(anchorRole) ? layout.box.get(anchorRole) : undefined;
  // Against the Output (or a stand-in): the plan is relative to its top-left.
  // Against a planned node: its RIGHT edge and its MIDDLE line, which do not
  // move when the card turns out wider or taller than planned.
  const ideal = ref
    ? { x: a.x + a.w - (ref.x + ref.w) + size.x, y: a.y + a.h / 2 - (ref.y + ref.h / 2) + size.y }
    : { x: a.x + size.x, y: a.y + size.y };

  // The planned neighbours already in this column keep their side of the new card.
  let lo = -Infinity;
  let hi = Infinity;
  if (planned) {
    const mid = planned.y + planned.h / 2;
    for (const [r, id] of Object.entries(bindings)) {
      const other = layout.box.get(r);
      const n = byId.get(id);
      if (r === role || !other || !n) continue;
      const b = drawnBox(n, byId);
      if (b.x >= ideal.x + w || ideal.x >= b.x + b.w) continue;
      const otherMid = other.y + other.h / 2;
      if (otherMid < mid) lo = Math.max(lo, b.y + b.h + LIBRARY_PLACE_PAD);
      else if (otherMid > mid) hi = Math.min(hi, b.y - h - LIBRARY_PLACE_PAD);
    }
    if (lo > hi) { lo = -Infinity; hi = Infinity; }
  }

  const obstacles = placementObstacles(nodes, drawnScaleOf);
  const free = (y: number) => !obstacles.some((b) => crowd({ x: ideal.x, y, w, h }, b, LIBRARY_PLACE_PAD));
  const ys = [
    Math.min(hi, Math.max(lo, ideal.y)),
    ...obstacles.flatMap((b) => [b.y + b.h + LIBRARY_PLACE_PAD, b.y - h - LIBRARY_PLACE_PAD]),
  ].filter(Number.isFinite);
  const nearest = (ok: (y: number) => boolean): number | null => {
    let best: number | null = null;
    for (const y of ys) if (ok(y) && free(y) && (best === null || Math.abs(y - ideal.y) < Math.abs(best - ideal.y))) best = y;
    return best;
  };
  const y = nearest((y) => y >= lo && y <= hi) ?? nearest(() => true);
  if (y !== null) return { x: ideal.x, y };
  return freeFrameSpot({ ...ideal, w, h }, obstacles);
}
