/**
 * THE acceptance gate: a model's reply → canonical TSL the app may add, or the
 * problems to send back. Model output is as adversarial as a shared
 * .fastshader; nothing reaches the store without passing here
 * (docs/dev/node-generator.md).
 *
 *  1. extract the program (dialect.ts);
 *  2. strict parse + allow-list walk into the internal form;
 *  3. names: uniforms renamed off the live graph's names, the names that hold
 *     tuned values and the reserved set; any other unusable name replaced;
 *  4. re-emit canonical TSL (emit.ts);
 *  5. VERIFY with the commit's own parser — codeToGraph with no error, no
 *     warning and no unknown node, node types within the catalogue, the caps,
 *     single-channel vector components — and the SEMANTIC ROUND TRIP: the
 *     parsed graph's own re-emission (graphToCode) is walked again and must
 *     compute the same thing (ir.ts semanticKeys). Every form the parser drops
 *     or misreads without a word changes that key; graph → code → graph must
 *     also be stable, so the parked group does not grow on the next Apply;
 *  6. price the parsed graph (before the ADD drops its Output).
 */
import { codeToGraph } from '@/engine/codeToGraph';
import { graphToCode } from '@/engine/graphToCode';
import { getEdgeOutputShape } from '@/engine/cpuEvaluator';
import { computeReachableCost } from '@/utils/nodeCost';
import { getNodeValues, type AppEdge, type AppNode } from '@/types';
import type { Catalogue } from './catalogue';
import { extractProgram, problemLine, walkProgram, type Problem } from './dialect';
import { emitCanonical } from './emit';
import { isUniformStep, semanticKeys, type Program, type Step } from './ir';
import { claimName, isPlainName, isReservedName, plainBase } from './names';

/** Most nodes a generated group may land with (Wood, the largest built-in, is ~80). */
export const MAX_GENERATED_NODES = 100;
/** Most uniforms a generated program may expose. */
export const MAX_GENERATED_UNIFORMS = 8;

export interface GateContext {
  catalogue: Catalogue;
  /** Uniform names already in use: the live graph's and the stored tuned ones. */
  takenNames: ReadonlySet<string>;
}

export interface GateUniform {
  name: string;
  kind: 'float' | 'color';
  /** The number, or the colour as '#rrggbb'. */
  value: number | string;
  /** The name the model wrote, when it had to change. */
  renamedFrom?: string;
}

export type GateResult =
  | {
    ok: true;
    /** Canonical TSL — what the ADD parses. */
    tsl: string;
    /** The model's prose plan — DATA, shown as a text node. */
    plan: string;
    /** Nodes the group will hold (the Output the ADD drops not counted). */
    nodeCount: number;
    /** Points the group costs once its end is wired to an Output. */
    cost: number;
    uniforms: GateUniform[];
    /** Unused consts that were left out. */
    pruned: string[];
  }
  | {
    ok: false;
    /** English problem lines, model-facing — fed to the next repair round. */
    problems: string[];
    /** The program the problems refer to, when one was found. */
    code: string | null;
  };

const hexColor = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

/** Make every name in `p` usable; returns the uniforms with their renames. */
function settleNames(p: Program, taken: ReadonlySet<string>): GateUniform[] {
  const claimed = new Set<string>(taken);
  const uniforms: GateUniform[] = [];
  for (const s of p.steps) {
    if (!isUniformStep(s)) continue;
    const color = s.op.op === 'uniformColor';
    const wanted = s.name;
    const base = isPlainName(wanted) ? wanted : plainBase(wanted) || (color ? 'tint' : 'param');
    s.name = claimName(base, claimed);
    uniforms.push({
      name: s.name,
      kind: color ? 'color' : 'float',
      value: s.op.op === 'uniformColor' ? hexColor(s.op.hex) : s.op.op === 'uniform' ? s.op.value : 0,
      ...(s.name !== wanted && !s.madeUpName ? { renamedFrom: wanted } : {}),
    });
  }
  // Other consts only label their node, but they share the canonical module
  // with the uniforms and the imports.
  const own = new Set<string>(uniforms.map((u) => u.name));
  for (const s of p.steps) {
    if (isUniformStep(s)) continue;
    const ok = isPlainName(s.name) && !isReservedName(s.name) && !own.has(s.name);
    s.name = ok ? s.name : claimName(plainBase(s.name) || 'v', own);
    own.add(s.name);
  }
  return uniforms;
}

/** Types, wiring and stored values of a graph, labels and ids aside. */
export function graphSignature(nodes: readonly AppNode[], edges: readonly AppEdge[]): string {
  const type = new Map(nodes.map((n) => [n.id, n.data.registryType] as const));
  const stable = (v: unknown): string => JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x);
  return JSON.stringify({
    types: nodes.map((n) => n.data.registryType).sort(),
    edges: edges.map((e) => `${type.get(e.source)}.${e.sourceHandle}>${type.get(e.target)}.${e.targetHandle}`).sort(),
    values: nodes.map((n) => `${n.data.registryType}:${stable(getNodeValues(n))}`).sort(),
  });
}

const VECTOR_TYPES = new Set(['vec2', 'vec3', 'vec4']);

/**
 * Gate an already-extracted program (the corpus tests and the probe call this
 * directly). `code` is the model's program text, used for problem lines.
 */
export function gateProgram(code: string, plan: string, ctx: GateContext): GateResult {
  const fail = (problems: Problem[]): GateResult => ({
    ok: false,
    problems: problems.map((p) => problemLine(p, code)),
    code,
  });
  const walked = walkProgram(code, ctx.catalogue);
  if (!walked.ok) return fail(walked.problems);
  const program = walked.program;
  const uniforms = settleNames(program, ctx.takenNames);
  if (uniforms.length > MAX_GENERATED_UNIFORMS) {
    return fail([{ line: 0, text: `${uniforms.length} uniforms — use at most ${MAX_GENERATED_UNIFORMS}` }]);
  }

  const tsl = emitCanonical(program);
  /** The model's line for the canonical line `n` (steps start on line 4). */
  const stepAt = (canonicalLine: number | undefined): Step | undefined =>
    canonicalLine ? program.steps[canonicalLine - 4] : undefined;
  const internal = (why: string, at?: Step): GateResult =>
    fail([{ line: at?.line ?? 0, text: `${why} — write this part another way` }]);

  // 5. Verify with the real parser.
  const g1 = codeToGraph(tsl);
  if (g1.errors.length > 0) {
    const e = g1.errors[0];
    return internal(`the graph cannot hold this: ${e.message}`, stepAt(e.line));
  }
  const members = g1.nodes.filter((n) => n.data.registryType !== 'output');
  const stray = g1.nodes.find((n) => n.data.registryType === 'unknown' || !ctx.catalogue.types.has(n.data.registryType));
  if (stray) return internal(`it made a ${stray.data.registryType} node, which a generated group may not hold`);
  if (members.length > MAX_GENERATED_NODES) {
    return fail([{ line: 0, text: `${members.length} nodes — keep it under ${MAX_GENERATED_NODES}` }]);
  }
  const byId = new Map(g1.nodes.map((n) => [n.id, n] as const));
  for (const e of g1.edges) {
    const target = byId.get(e.target);
    if (!target || !VECTOR_TYPES.has(target.data.registryType)) continue;
    if (getEdgeOutputShape(e, g1.nodes, g1.edges) !== 1) {
      const step = program.steps.find((s) => s.name === target.data.label);
      return fail([{
        line: step?.line ?? 0,
        text: `each ${target.data.registryType}() component must be ONE number — use a.x, a.y … or a float value`,
      }]);
    }
  }

  // The semantic round trip.
  const code2 = graphToCode(g1.nodes, g1.edges).code;
  const walked2 = walkProgram(code2, ctx.catalogue, { trusted: true });
  if (!walked2.ok) return internal(`the graph re-emits a form the gate cannot read (${walked2.problems[0]?.text ?? '?'})`);
  const table = new Map<string, string>();
  const keys1 = semanticKeys(program, table);
  const keys2 = semanticKeys(walked2.program, table);
  if (keys1.ofArg(program.ret) !== keys2.ofArg(walked2.program.ret)) {
    const known = new Set(walked2.program.steps.map((_, i) => keys2.ofStep(i)));
    const lost = program.steps.find((_, i) => !known.has(keys1.ofStep(i)));
    return internal(`the graph would not keep ${lost ? `const ${lost.name}` : 'this program'} as written`, lost);
  }
  const g2 = codeToGraph(code2);
  if (g2.errors.length > 0 || graphSignature(g2.nodes, g2.edges) !== graphSignature(g1.nodes, g1.edges)) {
    return internal('the graph changes when it is written out and read back');
  }

  // 6. Price, on the parse — the Output that seeds the walk is still there.
  let cost = 0;
  try { cost = computeReachableCost(g1.nodes, g1.edges); } catch { cost = 0; }

  return { ok: true, tsl, plan, nodeCount: members.length, cost, uniforms, pruned: walked.info.pruned };
}

/** Gate a whole model reply. */
export function gateText(raw: string, ctx: GateContext): GateResult {
  const ex = extractProgram(raw);
  if (!ex.ok) return { ok: false, problems: ex.problems.map((p) => p.text), code: null };
  return gateProgram(ex.value.code, ex.value.plan, ctx);
}
