/**
 * An INT that meets a FLOAT is a FLOAT (owner, 2026-10-27: "int — always change
 * to float where there is float").
 *
 * three r184 decides an operation's type on its own: an operator takes its
 * FIRST operand's type on a tie (OperatorNode.generateNodeType) and a maths
 * function its widest input with its own tie-break (MathNode.getInputType), and
 * every other operand is converted to that type. So an Int FIRST turned the
 * float into an int — a constant rounded (`generateConst`), anything else
 * truncated (`int(…)`): Int 4 × 0.3 was 0, Int 3 ÷ Float 2 was 1, and a float
 * function such as sin() of an Int does not compile at all on GLSL ES.
 *
 * graphToCode now wraps such an int operand in `float(…)` (resolveEdgeRef),
 * codeToGraph reads the wrapper back as the plain wire (`stripIntPromotions`),
 * and cpuEvaluator computes those operations in float, as the shader does.
 *
 * An int stays an int only where EVERY operand is one: the arithmetic, Abs and
 * Clamp of int wires (Int 7 ÷ Int 2 is still the integer 3), a Split of an
 * int, and a socket that is itself int-typed (UV's Channel). A JS number in
 * TSL is a FLOAT literal, so an unwired operand's stored value counts as a
 * float and promotes its int partner.
 *
 * A LEAF: graphToCode, codeToGraph and cpuEvaluator all read it.
 */

/** Node types — and their TSL functions, the same names — whose result stays
 *  an int when every operand is one. NOT Min/Max: on WebGL three r184 builds a
 *  scalar second operand as a float (`min( 4, 3.0 )`), which GLSL rejects, so
 *  an int there is promoted like anywhere else. */
export const INT_PRESERVING_TYPES: ReadonlySet<string> = new Set(['add', 'sub', 'mul', 'div', 'mod', 'abs', 'clamp']);

/** The largest magnitude an Int holds on both backends — symmetric, so `-x` and
 *  `abs(x)` stay representable (GLSL ES rejects the literal 2147483648). */
export const INT32_MAX = 2147483647;

/** The literal an Int node emits: its value rounded, as three's generateConst
 *  rounds, and clamped to ±INT32_MAX — past it a value is no i32 on either
 *  backend (WebGPU refuses the module, WebGL wraps). */
export function intLiteral(n: number): number {
  return Math.max(-INT32_MAX, Math.min(INT32_MAX, Math.round(n)));
}

/** What the int rule needs to know about a graph — each caller adapts its own
 *  indexes (codegen's GraphIndex, the evaluator's ctx). */
export interface IntGraph {
  /** The registry type of a node, or undefined. */
  typeOf(nodeId: string): string | undefined;
  /** The edge into `port` of `nodeId`, or undefined when that socket is unwired
   *  — and a wire codegen resolves to NOTHING (cpuEvaluator's `deadSplitWire`)
   *  is unwired: the consumer emits its own float literal there. */
  wireInto(nodeId: string, port: string): { source: string } | undefined;
  /** The operand ports a node actually emits (its effective inputs). */
  operands(nodeId: string): readonly string[];
  /** An Int node's emitted literal (`intLiteral`). Without it no range is checked. */
  literal?(nodeId: string): number;
}

/** Each `isIntSource` memo's companion: the int VALUE of every int node in it. */
const VALUE_MEMOS = new WeakMap<Map<string, boolean>, Map<string, number>>();

/**
 * Does `nodeId` produce an INT in the shader? The Int node; an int-preserving
 * operation whose every operand is WIRED from an int (an unwired one emits a
 * float literal) and whose value — every partial result too — fits in an i32;
 * a Split of an int (SplitNode ignores components on a scalar). An all-int
 * chain is a constant, so its value is known here; one that overflows is a
 * FLOAT operation instead, which holds it (50000 × 50000 wrapped on WebGL and
 * failed to compile on WebGPU). A division by 0 stays an int — no value, either
 * way. Memoised per call through `memo`, which also guards a cyclic graph.
 */
export function isIntSource(g: IntGraph, nodeId: string, memo: Map<string, boolean> = new Map()): boolean {
  const hit = memo.get(nodeId);
  if (hit !== undefined) return hit;
  memo.set(nodeId, false); // cycle guard
  let values = VALUE_MEMOS.get(memo);
  if (!values) {
    values = new Map();
    VALUE_MEMOS.set(memo, values);
  }
  const type = g.typeOf(nodeId);
  let result = false;
  if (type === 'int') {
    result = true;
    if (g.literal) values.set(nodeId, g.literal(nodeId));
  } else if (type === 'split') {
    const v = g.wireInto(nodeId, 'v');
    result = !!v && isIntSource(g, v.source, memo);
    const value = v ? values.get(v.source) : undefined;
    if (result && value !== undefined) values.set(nodeId, value);
  } else if (type !== undefined && INT_PRESERVING_TYPES.has(type)) {
    const ops = g.operands(nodeId);
    const sources = ops.map((port) => g.wireInto(nodeId, port)?.source);
    result = ops.length > 0 && sources.every((s) => s !== undefined && isIntSource(g, s, memo));
    if (result) {
      const value = intValue(type, sources.map((s) => values!.get(s!)));
      if (value === null) result = false; // past the i32 range
      else if (value !== undefined) values.set(nodeId, value);
    }
  }
  memo.set(nodeId, result);
  return result;
}

/** An all-int operation's value as the GPU computes it (truncated division, the
 *  remainder), undefined when an operand's is unknown, NaN when it has none (÷ 0)
 *  — or null when the value or a partial result leaves the i32 range. */
function intValue(type: string, operands: (number | undefined)[]): number | null | undefined {
  if (operands.some((v) => v === undefined)) return undefined;
  const [first, ...rest] = operands as number[];
  const fits = (v: number) => Number.isNaN(v) || Math.abs(v) <= INT32_MAX;
  if (type === 'abs') return fits(Math.abs(first)) ? Math.abs(first) : null;
  if (type === 'clamp') return Math.min(Math.max(first, rest[0]), rest[1]);
  let acc = first;
  for (const v of rest) {
    acc = type === 'add' ? acc + v
      : type === 'sub' ? acc - v
        : type === 'mul' ? acc * v
          : v === 0 ? NaN
            : type === 'div' ? Math.trunc(acc / v)
              : acc % v;
    if (!fits(acc)) return null;
  }
  return acc;
}

/**
 * Must the int arriving on this wire become a float at its consumer? Yes unless
 * the consumer keeps it: a socket declared int, a Split (the Split's own
 * consumer decides), or an int-preserving operation whose every operand is an
 * int. Answers false for a wire that is not an int at all.
 */
export function promotesIntWire(
  g: IntGraph,
  wire: { source: string; target: string },
  targetPortType: string | undefined,
  memo: Map<string, boolean> = new Map(),
): boolean {
  if (!isIntSource(g, wire.source, memo)) return false;
  if (targetPortType === 'int') return false;
  if (g.typeOf(wire.target) === 'split') return false;
  return !isIntSource(g, wire.target, memo);
}
