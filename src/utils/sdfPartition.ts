/**
 * Which nodes an SDF Output re-evaluates PER RAY STEP.
 *
 * The distance field a user wires into `SDF Output.field` is built from
 * `Local Position` like any other chain — but the raymarcher has to evaluate
 * that chain at the ray position, many times per pixel. So graphToCode emits
 * the part of the graph that DEPENDS on a march root (positionLocal /
 * positionGeometry — object space, pre-displacement) inside a
 * `Fn(([p]) => { … })`, with each root emitted as `const <root> = p;`, and
 * calls that Fn from the loop. Everything else stays in the flat body and is
 * captured by closure (closure capture of outer nodes type-checks and renders
 * on r184 — measured 2026-09-02).
 *
 * The colour chain gets the same treatment when it is position-dependent: it
 * is evaluated ONCE, at the hit point.
 *
 * Pure so `nodeCost` can price the field body `steps × Σ` with the SAME
 * partition the emitter uses, and so the parser's inverse is testable.
 *
 * A node in BOTH sets (feeding field and colour) is emitted into both Fns —
 * separate function scopes, same var name. On a code-panel Apply that parses
 * back as two nodes; accepted for v1.
 */
import type { AppNode, AppEdge } from '@/types';

export const SDF_OUTPUT_TYPE = 'sdfOutput';

/** Registry types the march variable substitutes for. Object space only. */
export const MARCH_ROOT_TYPES: ReadonlySet<string> = new Set(['positionLocal', 'positionGeometry']);

export interface SdfPartition {
  /** Position-dependent ancestors of the `field` socket (incl. the roots). */
  field: ReadonlySet<string>;
  /** Position-dependent ancestors of the `color` socket (incl. the roots). */
  color: ReadonlySet<string>;
  /** Nodes that must ALSO be emitted in the flat body: roots, and set members
   *  with a consumer outside the sets (a dangling branch would otherwise
   *  reference a name that only exists inside the Fn). */
  mainAlso: ReadonlySet<string>;
}

export function isSdfOutput(node: AppNode): boolean {
  return node.data.registryType === SDF_OUTPUT_TYPE;
}

export function sdfOutputNodes(nodes: readonly AppNode[]): AppNode[] {
  return nodes.filter(isSdfOutput);
}

/**
 * The SDF Output that DRIVES the shader: the first one whose `field` socket is
 * wired. Unwired, an SDF Output is inert and the plain Output still emits — so
 * every surface that asks "what feeds the preview" (PreviewLink's wire, the
 * preview's bounding-box override, the double-sided material, the A-Frame
 * tab's primitive) must ask THIS, never "is there an SDF Output node". Pass
 * UNWRAPPED edges (unwrapCollapsedGroupEdges): a feeder inside a collapsed
 * group must still count as wired.
 */
export function drivingSdfOutput(nodes: readonly AppNode[], edges: readonly AppEdge[]): AppNode | null {
  for (const n of nodes) {
    if (!isSdfOutput(n)) continue;
    if (edges.some((e) => e.target === n.id && e.targetHandle === 'field')) return n;
  }
  return null;
}

export function sdfOutputDrives(nodes: readonly AppNode[], edges: readonly AppEdge[]): boolean {
  return drivingSdfOutput(nodes, edges) !== null;
}

function closure(seed: Iterable<string>, next: (id: string) => readonly string[]): Set<string> {
  const out = new Set<string>();
  const queue = [...seed];
  while (queue.length) {
    const id = queue.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const n of next(id)) if (!out.has(n)) queue.push(n);
  }
  return out;
}

export function sdfPartition(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  sdfNodeId: string,
): SdfPartition {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    (outgoing.get(e.source) ?? outgoing.set(e.source, []).get(e.source)!).push(e.target);
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e.source);
  }
  const roots = nodes.filter((n) => MARCH_ROOT_TYPES.has(n.data.registryType)).map((n) => n.id);
  const pDep = closure(roots, (id) => outgoing.get(id) ?? []);
  pDep.delete(sdfNodeId);

  const ancestorsOf = (handle: string): Set<string> => {
    const feeders = edges.filter((e) => e.target === sdfNodeId && e.targetHandle === handle).map((e) => e.source);
    return closure(feeders, (id) => incoming.get(id) ?? []);
  };
  const inter = (a: Set<string>): Set<string> => new Set([...a].filter((id) => pDep.has(id)));
  const field = inter(ancestorsOf('field'));
  const color = inter(ancestorsOf('color'));

  const mainAlso = new Set<string>();
  for (const id of new Set([...field, ...color])) {
    const node = nodes.find((n) => n.id === id);
    if (node && MARCH_ROOT_TYPES.has(node.data.registryType)) { mainAlso.add(id); continue; }
    for (const t of outgoing.get(id) ?? []) {
      if (t !== sdfNodeId && !field.has(t) && !color.has(t)) { mainAlso.add(id); break; }
    }
  }
  return { field, color, mainAlso };
}
