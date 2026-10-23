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
import { getFlowNodeType } from '@/registry/nodeRegistry';
import { estimateNodeSize } from '@/engine/layoutEngine';
import { absoluteNodePosition, measuredNodeSize } from '@/utils/groupFrame';
import { freeFrameSpot, placementObstacles, LIBRARY_WIRE_GAP } from '@/utils/libraryAutoWire';
import { findTutorial } from './tutorialDefs';
import { OUT_ROLE } from './tutorialTypes';
import type { TutorialDef, TutorialRun, TutorialStep } from './tutorialTypes';

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
}

/** The step on screen, or undefined on the finish screen / an unknown lesson. */
export function currentStep(def: TutorialDef | undefined, run: TutorialRun | null): TutorialStep | undefined {
  return def && run ? def.steps[run.step] : undefined;
}

const registryTypeOf = (n: AppNode): string => String((n.data as { registryType?: unknown })?.registryType ?? '');

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
      if (bound && registryTypeOf(bound) === step.type) return { status: 'satisfied' };
      const taken = new Set(Object.values(bindings));
      // Newest first: the node the user just added is the one they mean.
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (taken.has(n.id) || n.type === 'group' || n.type === 'note') continue;
        if (registryTypeOf(n) === step.type) return { status: 'satisfied', bind: [step.role, n.id] };
      }
      const newest = [...nodes].reverse().find((n) => !taken.has(n.id) && n.type !== 'group' && n.type !== 'note');
      return newest ? { status: 'pending', wrongType: registryTypeOf(newest) } : { status: 'pending' };
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

export interface StepTargets {
  nodes: string[];
  handles: Array<readonly [nodeId: string, kind: 'source' | 'target', handle: string]>;
}

/** What the canvas marks for this step: the sockets a wire must join, the node
 *  a value lives on. An `add` marks nothing on the canvas (its tile is marked). */
export function stepTargets(step: TutorialStep, bindings: Bindings): StepTargets {
  const out: StepTargets = { nodes: [], handles: [] };
  const id = (role: string) => bindings[role];
  switch (step.kind) {
    case 'wire': {
      const s = id(step.from[0]);
      const t = id(step.to[0]);
      if (s) { out.nodes.push(s); out.handles.push([s, 'source', step.from[1]]); }
      if (t) { out.nodes.push(t); out.handles.push([t, 'target', step.to[1]]); }
      break;
    }
    case 'set':
    case 'expose': {
      const n = id(step.role);
      if (n) out.nodes.push(n);
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Where "Do it for me" puts a new node: left of the node it will FEED (the
 * first later wire from this role), level with it, else left of the Output —
 * then the nearest spot that overlaps nothing drawn (`freeFrameSpot`), so
 * nothing already on the canvas ever moves. A dagre layout of the final graph
 * was rejected: it would place nodes against positions the user has not made
 * yet. Measured sizes arrive a frame after a mount, so a node added THIS frame
 * is still a 160×60 estimate to `placementObstacles` — each auto step is its
 * own click, which is time enough.
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
  let anchorRole = OUT_ROLE;
  for (let i = stepIndex + 1; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === 'wire' && s.from[0] === role) { anchorRole = s.to[0]; break; }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const anchor = byId.get(bindings[anchorRole] ?? '') ?? byId.get(bindings[OUT_ROLE] ?? '') ?? nodes[0];
  const stub = {
    id: '__tutorial_new__',
    type: getFlowNodeType(def),
    position: { x: 0, y: 0 },
    data: { registryType: def.type, label: def.label, cost: 0, values: { ...def.defaultValues } },
  } as unknown as AppNode;
  const { width: w, height: h } = estimateNodeSize(stub);
  if (!anchor) return { x: 0, y: 0 };
  const at = absoluteNodePosition(anchor, byId);
  const anchorH = measuredNodeSize(anchor).h;
  const ideal = { x: at.x - w - LIBRARY_WIRE_GAP, y: at.y + Math.max(0, (anchorH - h) / 2), w, h };
  return freeFrameSpot(ideal, placementObstacles(nodes));
}
