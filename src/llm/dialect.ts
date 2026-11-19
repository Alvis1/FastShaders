/**
 * Reading a model's reply: find the program, parse it STRICTLY, and walk it
 * into the internal form (ir.ts) through an ALLOW-LIST of forms. Nothing here
 * executes the text, and nothing of it is passed on verbatim — emit.ts writes
 * the program again from the internal form.
 *
 * The walker is lenient only where a rewrite is mechanical and EXACT, because
 * every rejected program costs a repair round (10–300 s on a local model):
 *  - nested calls are flattened into their own steps (`sin(mul(a, 2))`);
 *  - constant arithmetic is folded (`1 / 6`, `-0.5`, `Math.PI * 2`);
 *  - an operator on nodes becomes its function (`a * b` → `mul(a, b)`) — the
 *    spike's most common rejection on small models;
 *  - a method call becomes the free function: positional for every TSL chain
 *    method except mix and smoothstep, which put the receiver in the factor
 *    slot (three r184 MathNode.js: `mixElement`, `smoothstepElement`);
 *  - `.toVar()`/`.toConst()` are dropped; `const k = 0.5` and `const a = b`
 *    are substituted; `vec3(0.5)` is spread; `a.xy` becomes `vec2(a.x, a.y)`;
 *    `color(r, g, b)` (linear components) becomes `vec3(r, g, b)`;
 *  - a registry TYPE written as a call (`perlin(p)`) maps to its function, and
 *    an input written as a call (`positionWorld()`) to the bare input;
 *  - unused consts are dropped (the spike's most common rejection after a
 *    repair round).
 * Everything else the parser would drop or misread is a PROBLEM: a line, the
 * offending text and what to write instead — fed to the next repair round.
 *
 * The same walker reads graphToCode's re-emission of the parsed graph (the
 * gate's semantic check), with `trusted` set so the app's own module-scope
 * helper Fns (hsl, toHsl, brightContrast, fsFresnel) are skipped by name and
 * the int→float conversions graphToCode adds are read back the way the parser
 * reads them (codeToGraph's `stripIntPromotions`, the one copy of that rule).
 */
import { parse } from '@babel/parser';
import type * as T from '@babel/types';
import { MODULE_HELPER_NAMES } from '@/engine/moduleHelpers';
import { shapeOfDataType } from '@/engine/cpuEvaluator';
import { stripIntPromotions } from '@/engine/codeToGraph';
import { OWN_MEMBER_TO_HANDLE } from '@/engine/graphToCode';
import type { Catalogue, CatalogueEntry } from './catalogue';
import { stepRefs, type Arg, type Component, type Program, type Step, type StepOp } from './ir';

/** A rejected form, at a 1-based line of the program (0 = the whole reply). */
export interface Problem {
  line: number;
  text: string;
}

/** Longest reply the gate reads at all. */
export const MAX_REPLY_CHARS = 32_000;
/** Longest program, after the fence is taken off. */
export const MAX_PROGRAM_CHARS = 16_000;
/** Most steps a program may build, before unused ones are dropped. */
export const MAX_STEPS = 160;
/** Deepest expression nesting the walker follows. */
export const MAX_DEPTH = 24;
/** Problems reported per round — more than this only buries the first one. */
export const MAX_PROBLEMS = 8;

/* ── finding the program in a reply ──────────────────────────────────────── */

export interface Extracted {
  code: string;
  /** The prose before the program, cleaned up — shown to the user as DATA. */
  plan: string;
}

const FENCE_RE = /```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)```/g;

export function extractProgram(raw: string): { ok: true; value: Extracted } | { ok: false; problems: Problem[] } {
  if (raw.length > MAX_REPLY_CHARS) {
    return { ok: false, problems: [{ line: 0, text: `the reply is ${raw.length} characters long — keep it under ${MAX_REPLY_CHARS}` }] };
  }
  if (/FASTSHADERS_PROJECT/.test(raw)) {
    return { ok: false, problems: [{ line: 0, text: 'the reply contains a FastShaders project block — write only the program' }] };
  }
  // Reasoning models may echo their thinking inline.
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const blocks = [...text.matchAll(FENCE_RE)];
  let code: string;
  let before: string;
  if (blocks.length > 0) {
    const pick = [...blocks].reverse().find((m) => /\breturn\b/.test(m[1])) ?? blocks[blocks.length - 1];
    code = pick[1];
    before = text.slice(0, pick.index ?? 0);
  } else if (/\breturn\b/.test(text) && /\bconst\b/.test(text)) {
    code = text;
    before = '';
  } else {
    return { ok: false, problems: [{ line: 0, text: 'no program found — write the program in ONE ```js code block' }] };
  }
  if (code.length > MAX_PROGRAM_CHARS) {
    return { ok: false, problems: [{ line: 0, text: `the program is ${code.length} characters long — keep it under ${MAX_PROGRAM_CHARS}` }] };
  }
  const plan = before
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  return { ok: true, value: { code, plan } };
}

/* ── walking the program ─────────────────────────────────────────────────── */

export interface WalkOptions {
  /** Reading graphToCode's own output: skip the app's helper Fns by name. */
  trusted?: boolean;
}

export interface WalkInfo {
  /** Consts dropped because nothing the program returns reads them. */
  pruned: string[];
}

export type WalkResult =
  | { ok: true; program: Program; info: WalkInfo }
  | { ok: false; problems: Problem[] };

const ARITH_OPS: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '**': 'pow' };
const COMPARE_OPS: Record<string, string> = { '>': 'greaterThan', '<': 'lessThan', '==': 'equal', '===': 'equal' };
const FOLD: Record<string, (a: number, b: number) => number> = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b,
  '%': (a, b) => a % b, '**': (a, b) => a ** b,
};
const SWIZZLE_RE = /^(?:[xyzw]{1,4}|[rgba]{1,4})$/;
const RGBA_TO_XYZW: Record<string, Component> = { r: 'x', g: 'y', b: 'z', a: 'w', x: 'x', y: 'y', z: 'z', w: 'w' };
/** Functions whose output width TSL takes from their inputs, whatever the
 *  registry port declares (checked with three r184's node builder). */
const WIDTH_FOLLOWS_INPUTS = new Set(['remap', 'smoothstep', 'normalize']);

/** Comparisons — 0/1 values, never a colour to return. */
const LOGIC_FNS = new Set(['greaterThan', 'lessThan', 'equal']);

/** Calls the walker knows by name beyond the catalogue's ordinary entries. */
const KNOWN_CALLS = new Set(['uniform', 'color', 'float', 'int', 'vec2', 'vec3', 'vec4', 'uv', 'mul']);

/** Methods whose receiver TSL puts in the LAST slot (three r184 MathNode.js). */
const RECEIVER_LAST = new Set(['mix', 'smoothstep']);

/**
 * A trailing argument graphToCode always writes after a node's sockets, which
 * the parser reads as the one value the node can hold — so it is no socket and
 * is dropped here, and anything else in that slot is refused. Fresnel's helper
 * takes the surface's world position (graphToCode `fsFresnel(eta, n,
 * positionWorld)`; codeToGraph HELPER_ARG_READERS warns on any other value).
 */
export const IMPLICIT_TRAILING_ARGS: ReadonlyMap<string, string> = new Map([['fsFresnel', 'positionWorld']]);

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];

/** What a const that failed to walk stands for, so the lines that use it are
 *  not ALSO reported. Never emitted: a walk with a problem returns no program. */
const FAILED: Arg = { k: 'global', name: '\u0000failed' };

/** Thrown inside the walk to abandon one statement; never escapes `walkProgram`. */
class Reject extends Error {
  constructor(readonly line: number, readonly why: string) { super(why); }
}

export function walkProgram(code: string, catalogue: Catalogue, opts: WalkOptions = {}): WalkResult {
  let ast: T.File;
  try {
    ast = parse(code, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      errorRecovery: false,
      plugins: [],
    }) as unknown as T.File;
  } catch (e) {
    const err = e as { message?: string; loc?: { line?: number } };
    const msg = String(err.message ?? e).replace(/\s*\(\d+:\d+\)\s*$/, '').slice(0, 160);
    const src = code.split('\n')[(err.loc?.line ?? 1) - 1] ?? '';
    const ts = /\b(?:const|let|var)\s+\w+\s*:|\)\s*:\s*\w|\bas\s+[A-Za-z]|\binterface\s|\btype\s+\w+\s*=|<[A-Z]\w*>/.test(src);
    return {
      ok: false,
      problems: [{ line: err.loc?.line ?? 0, text: `syntax error: ${msg}${ts ? ' — write plain JavaScript, no type annotations' : ''}` }],
    };
  }
  if (opts.trusted) {
    // graphToCode's int→float promotions (`mul(float(int1), 0.3)`) and the
    // vec3 widening of a scalar into dot/normalize are read back as the plain
    // wire, exactly as the parser that built the graph reads them. Never on a
    // model's text: the dialect refuses a conversion the model writes itself.
    try {
      stripIntPromotions(ast, code);
    } catch (e) {
      return { ok: false, problems: [{ line: 0, text: `unreadable re-emission: ${String((e as Error)?.message ?? e).slice(0, 120)}` }] };
    }
  }

  const problems: Problem[] = [];
  const steps: Step[] = [];
  const bindings = new Map<string, Arg>();
  const usedNames = new Set<string>();
  /** Every name the program declares anywhere — a later one is a forward reference. */
  const declaredAnywhere = new Set<string>();
  let tempCount = 0;
  let paramCount = 0;
  let ret: Arg | null = null;
  let retLine = 0;

  const lineOf = (n: T.Node | null | undefined): number => n?.loc?.start.line ?? 0;
  const reject = (n: T.Node | null | undefined, why: string): never => { throw new Reject(lineOf(n), why); };

  const freshName = (base: string): string => {
    let name: string;
    do { name = `${base}${++tempCount}`; } while (usedNames.has(name) || declaredAnywhere.has(name));
    usedNames.add(name);
    return name;
  };
  const freshParam = (color: boolean): string => {
    let name: string;
    do { name = `${color ? 'colorParam' : 'param'}${++paramCount}`; } while (usedNames.has(name) || declaredAnywhere.has(name));
    usedNames.add(name);
    return name;
  };

  /** A step for `op`; it takes the declarator's name when this IS the declarator's value. */
  interface Hint { name: string; used: boolean }
  const addStep = (op: StepOp, at: T.Node, hint?: Hint, madeUpName?: boolean): Arg => {
    if (steps.length >= MAX_STEPS) reject(at, `more than ${MAX_STEPS} steps — make the program smaller`);
    let name: string;
    if (hint && !hint.used) { hint.used = true; name = hint.name; } else name = freshName('t');
    steps.push({ name, line: lineOf(at), op, ...(madeUpName ? { madeUpName: true } : {}) });
    return { k: 'ref', id: steps.length - 1 };
  };

  const entryFor = (name: string): CatalogueEntry | undefined => {
    const direct = catalogue.byName.get(name);
    if (direct) return direct;
    const alias = catalogue.typeAliases.get(name);
    return alias ? catalogue.byName.get(alias) : undefined;
  };

  /** Channels a value carries, where it can be known (0 = unknown) — the
   *  registry's port types, and TSL's broadcast (the widest operand) for the
   *  'any'-typed maths. */
  const shapeOf = (a: Arg): number => {
    switch (a.k) {
      case 'num': case 'swz': return 1;
      case 'global': {
        const e = catalogue.byName.get(a.name);
        return e ? shapeOfDataType(e.def.outputs[0].dataType) : 0;
      }
      case 'ref': {
        const op = steps[a.id].op;
        switch (op.op) {
          case 'uniform': case 'float': case 'int': case 'time': return 1;
          case 'uniformColor': case 'color': return 3;
          case 'uv': return 2;
          case 'alias': return shapeOf({ k: 'global', name: op.global });
          case 'noise': case 'call': {
            const e = catalogue.byName.get(op.fn);
            const declared = e ? shapeOfDataType(e.def.outputs[0].dataType) : 0;
            if (op.op === 'noise') return declared;
            // TSL's own width where the registry's declared port type does not
            // hold: remap and smoothstep (declared float) and normalize
            // (declared vec3) follow their inputs, like the 'any' maths.
            if (declared > 0 && !WIDTH_FOLLOWS_INPUTS.has(op.fn)) return declared;
            const shapes = op.args.map(shapeOf);
            return shapes.some((x) => x === 0) ? 0 : Math.max(1, ...shapes);
          }
        }
      }
    }
  };
  const finite = (v: number, at: T.Node): number => {
    if (!Number.isFinite(v)) reject(at, 'this number is not finite — use an ordinary number');
    return v;
  };
  const describe = (n: T.Node): string => {
    const src = n.start != null && n.end != null ? code.slice(n.start, n.end) : n.type;
    return src.length > 60 ? `${src.slice(0, 57)}…` : src;
  };

  /** A noise POSITION: a step or an input, named by an identifier — the only
   *  form the parser wires. A number or one component is no position (and an
   *  inline swizzle there is dropped on the next parse). */
  const positionArg = (a: Arg, at: T.Node): Arg => {
    if (a.k === 'ref' || a.k === 'global') return a;
    return reject(at, `a noise position needs 2 or 3 components — pass uv(), a position input, or a vec2/vec3 const`);
  };

  /** A call to a catalogue function, arguments already walked. */
  const callStep = (entry: CatalogueEntry, args: Arg[], at: T.Node, hint?: Hint): Arg => {
    if (entry.kind !== 'call') return reject(at, `${entry.name} cannot be called this way`);
    const implicit = IMPLICIT_TRAILING_ARGS.get(entry.name);
    if (implicit !== undefined && args.length === entry.maxArgs + 1) {
      const last = args[args.length - 1];
      if (last.k !== 'global' || last.name !== implicit) {
        reject(at, `${entry.name}()'s ${ORDINALS[entry.maxArgs] ?? 'last'} argument is always ${implicit} — leave it out: ${entry.name}(${entry.ports.join(', ')})`);
      }
      args = args.slice(0, -1);
    }
    if (args.length < entry.minArgs || args.length > entry.maxArgs) {
      const want = entry.minArgs === entry.maxArgs ? `${entry.minArgs}` : `${entry.minArgs} to ${entry.maxArgs}`;
      reject(at, `${entry.name}() takes ${want} argument${entry.maxArgs === 1 ? '' : 's'}, not ${args.length} — ${entry.chainable ? `${entry.name}(a, b, …)` : `${entry.name}(${entry.ports.join(', ')})`}`);
    }
    // Leave nothing to the parser's defaults: a left-out trailing argument is
    // written out, the way graphToCode writes it back.
    const full = entry.chainable ? args : entry.ports.map((_, i) => args[i] ?? { k: 'num' as const, v: entry.defaults[i]! });
    return addStep({ op: 'call', fn: entry.name, args: full }, at, hint);
  };

  const callByName = (name: string, args: Arg[], at: T.Node, hint?: Hint): Arg => {
    const entry = catalogue.byName.get(name);
    if (!entry) return reject(at, `${describe(at)} needs ${name}(), which is not in the node list — write it another way`);
    return callStep(entry, args, at, hint);
  };

  const isCall = (n: T.Node, name: string): n is T.CallExpression =>
    n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name;

  /** `uv()` × `vec2(a, b)` with both numbers — the UV node's own tiling. */
  const uvTiling = (u: T.Node, v: T.Node): [number, number] | null => {
    if (!isCall(u, 'uv') || u.arguments.length !== 0 || !isCall(v, 'vec2') || v.arguments.length !== 2) return null;
    const nums = v.arguments.map((a) => (a.type === 'SpreadElement' ? null : foldNumber(a as T.Expression)));
    return nums[0] != null && nums[1] != null ? [nums[0], nums[1]] : null;
  };

  /** A constant number written any way the fold understands, else null. */
  const foldNumber = (n: T.Expression): number | null => {
    if (n.type === 'NumericLiteral') return n.value;
    if (n.type === 'UnaryExpression' && (n.operator === '-' || n.operator === '+')) {
      const v = foldNumber(n.argument);
      return v == null ? null : n.operator === '-' ? -v : v;
    }
    if (n.type === 'BinaryExpression' && n.operator in FOLD && n.left.type !== 'PrivateName') {
      const a = foldNumber(n.left as T.Expression);
      const b = foldNumber(n.right);
      return a == null || b == null ? null : FOLD[n.operator](a, b);
    }
    if (n.type === 'Identifier' && n.name === 'PI' && !bindings.has('PI')) return Math.PI;
    if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'Math'
      && n.property.type === 'Identifier' && n.property.name === 'PI') return Math.PI;
    if (n.type === 'Identifier') {
      const b = bindings.get(n.name);
      if (b?.k === 'num') return b.v;
    }
    return null;
  };

  const noiseStep = (entry: CatalogueEntry, call: T.CallExpression, depth: number, hint: Hint | undefined, unsigned: boolean): Arg => {
    if (call.arguments.length !== 1) {
      reject(call, `${entry.name}() takes ONE position argument, not ${call.arguments.length} — scale the position first: ${entry.name}(p.mul(scale))`);
    }
    const arg = call.arguments[0];
    if (arg.type === 'SpreadElement' || arg.type === 'ArgumentPlaceholder') return reject(arg, `write a plain position`);
    let pos: Arg;
    let scale: Arg = { k: 'num', v: 1 };
    if (arg.type === 'CallExpression' && arg.callee.type === 'MemberExpression' && !arg.callee.computed
      && arg.callee.property.type === 'Identifier' && arg.callee.property.name === 'mul' && arg.arguments.length === 1) {
      pos = form(arg.callee.object as T.Expression, depth + 1);
      scale = form(arg.arguments[0] as T.Expression, depth + 1);
    } else if (isCall(arg, 'mul') && arg.arguments.length === 2) {
      const a = form(arg.arguments[0] as T.Expression, depth + 1);
      const b = form(arg.arguments[1] as T.Expression, depth + 1);
      // Scaling commutes: the one-channel side is the scale, whichever comes first.
      if (shapeOf(a) === 1 && shapeOf(b) !== 1) { pos = b; scale = a; } else { pos = a; scale = b; }
    } else {
      pos = form(arg as T.Expression, depth + 1);
    }
    pos = positionArg(pos, arg);
    // The noise's own scale port reads a number or a const; anything else is
    // the product as its own step.
    if (scale.k !== 'num' && scale.k !== 'ref') {
      pos = callByName('mul', [pos, scale], arg);
      scale = { k: 'num', v: 1 };
    }
    if (entry.kind !== 'noise') return reject(call, `${entry.name} is not a noise`);
    return addStep({ op: 'noise', fn: entry.name, pos, scale, unsigned }, call, hint);
  };

  /** Walk one expression to an Arg, adding steps for what it builds. */
  const form = (n: T.Expression, depth: number, hint?: Hint): Arg => {
    if (depth > MAX_DEPTH) reject(n, `nesting deeper than ${MAX_DEPTH} — use intermediate consts`);
    const folded = foldNumber(n);
    if (folded != null) return { k: 'num', v: finite(folded, n) };

    switch (n.type) {
      case 'Identifier': return identifier(n);
      case 'MemberExpression': return member(n, depth, hint);
      case 'CallExpression': return callExpr(n, depth, hint);
      case 'UnaryExpression': {
        if (n.operator === '-') return callByName('mul', [form(n.argument, depth + 1), { k: 'num', v: -1 }], n, hint);
        if (n.operator === '+') return form(n.argument, depth + 1, hint);
        return reject(n, `operator ${n.operator} is not available — use the node functions`);
      }
      case 'BinaryExpression': {
        const fn = ARITH_OPS[n.operator] ?? COMPARE_OPS[n.operator];
        if (!fn || n.left.type === 'PrivateName') {
          return reject(n, `operator ${n.operator} is not available${n.operator === '>=' || n.operator === '<=' ? ' — use greaterThan or lessThan' : ''}`);
        }
        const a = form(n.left as T.Expression, depth + 1);
        const b = form(n.right, depth + 1);
        return callByName(fn, [a, b], n, hint);
      }
      case 'ConditionalExpression':
        return reject(n, `no ? : — use select(condition, a, b)`);
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return reject(n, `no helper functions — write every step as its own const`);
      case 'StringLiteral':
      case 'TemplateLiteral':
        return reject(n, `no strings — colours are color(0xRRGGBB)`);
      case 'ObjectExpression':
        return reject(n, `no objects here`);
      case 'ArrayExpression':
        return reject(n, `no arrays — use vec2/vec3/vec4`);
      case 'NumericLiteral':
        return reject(n, 'this number is not finite');
      default:
        return reject(n, `${describe(n)} is not a form the graph can hold`);
    }
  };

  const identifier = (n: T.Identifier): Arg => {
    const b = bindings.get(n.name);
    if (b) return b;
    const entry = entryFor(n.name);
    if (entry?.kind === 'global') return { k: 'global', name: entry.name };
    if (declaredAnywhere.has(n.name)) return reject(n, `${n.name} is used before the line that declares it — declare it earlier`);
    if (n.name === 'uv') return reject(n, `write uv() with parentheses`);
    if (entry) return reject(n, `${n.name} is a function — call it: ${n.name}(…)`);
    return reject(n, `${n.name} is not declared — declare it as a const first, or use one of the INPUTS`);
  };

  const member = (n: T.MemberExpression, depth: number, hint?: Hint): Arg => {
    if (n.computed || n.property.type !== 'Identifier') return reject(n, `only one-letter swizzles like a.x are allowed`);
    const prop = n.property.name;
    if (n.object.type === 'Identifier' && n.object.name === 'Math') {
      return reject(n, `Math.${prop} is not available — use the node functions (sin, pow, …)`);
    }
    if (!SWIZZLE_RE.test(prop)) return reject(n, `.${prop} is not available — only swizzles like .x .y .z`);
    const of = form(n.object as T.Expression, depth + 1);
    if (of.k === 'num') return reject(n, `a number has no .${prop}`);
    if (of.k === 'swz') return reject(n, `a swizzle of a swizzle (${describe(n)}) — use one swizzle`);
    const comps = [...prop].map((c) => RGBA_TO_XYZW[c]);
    if (comps.length === 1) return component(of, comps[0]);
    // a.xy is exactly vec2(a.x, a.y).
    return callByName(`vec${comps.length}`, comps.map((c) => component(of, c)), n, hint);
  };

  /** One component of `of`. A node that names its OWN sockets as members of
   *  its one call (Fresnel: `.x` the Fresnel socket, `.y` Facing — graphToCode
   *  OWN_MEMBER_TO_HANDLE) is read by the parser as that socket, and the bare
   *  name wires its FIRST socket too — so that member IS the node itself, as
   *  graphToCode writes it back (`fresnel1.x`). */
  const component = (of: Arg, c: Component): Arg => {
    if (of.k === 'ref') {
      const op = steps[of.id].op;
      const e = op.op === 'call' ? catalogue.byName.get(op.fn) : undefined;
      if (e && OWN_MEMBER_TO_HANDLE.get(e.type)?.get(c) === e.def.outputs[0].id) return of;
    }
    return { k: 'swz', of, c };
  };

  const callExpr = (n: T.CallExpression, depth: number, hint?: Hint): Arg => {
    const rawArgs = n.arguments;
    for (const a of rawArgs) {
      if (a.type === 'SpreadElement' || a.type === 'ArgumentPlaceholder') {
        reject(n, `no spread arguments`);
      }
    }
    const argNodes = rawArgs as T.Expression[];
    const walkArgs = (): Arg[] => argNodes.map((a) => form(a, depth + 1));

    if (n.callee.type === 'MemberExpression') return methodCall(n, n.callee, argNodes, depth, hint);
    if (n.callee.type !== 'Identifier') return reject(n, `${describe(n)} is not a plain function call`);
    const name = n.callee.name;
    // A const may share a function's name (`const color = uniform(color(…))`;
    // the gate renames it): in CALL position the name is the function.
    if (bindings.has(name) && !KNOWN_CALLS.has(name) && !entryFor(name)) return reject(n, `${name} is a value, not a function`);

    switch (name) {
      case 'uniform': {
        if (argNodes.length !== 1) reject(n, `uniform() takes one value: uniform(1.5) or uniform(color(0xRRGGBB))`);
        const a = argNodes[0];
        const own = !!hint && !hint.used;
        if (isCall(a, 'color')) {
          const hex = hexOf(a);
          if (hex == null) return reject(n, `a colour uniform is uniform(color(0xRRGGBB)) with a 6-digit hex`);
          return addStep({ op: 'uniformColor', hex }, n, own ? hint : { name: freshParam(true), used: false }, !own);
        }
        const v = foldNumber(a);
        if (v == null) return reject(n, `uniform() takes a number or color(0xRRGGBB), not ${describe(a)}`);
        return addStep({ op: 'uniform', value: finite(v, a) }, n, own ? hint : { name: freshParam(false), used: false }, !own);
      }
      case 'color': {
        if (argNodes.length === 3) {
          // color(r, g, b) takes LINEAR components, exactly what vec3 holds.
          return callByName('vec3', walkArgs(), n, hint);
        }
        const hex = argNodes.length === 1 ? hexOf(n) : null;
        if (hex == null) return reject(n, `write colours as color(0xRRGGBB) with a 6-digit hex`);
        return addStep({ op: 'color', hex }, n, hint);
      }
      case 'float':
      case 'int': {
        const v = argNodes.length === 1 ? foldNumber(argNodes[0]) : null;
        if (v == null) return reject(n, `${name}() takes one number — use the value itself instead of ${describe(n)}`);
        if (name === 'int' && !Number.isInteger(v)) return reject(n, `int() takes a whole number`);
        return addStep({ op: name, v: finite(v, n) }, n, hint);
      }
      case 'vec2':
      case 'vec3':
      case 'vec4': {
        const arity = Number(name[3]);
        if (argNodes.length === 1) {
          // vecN(x): a one-channel x is spread to every component, an
          // N-channel x is itself — both exactly what TSL does.
          const x = form(argNodes[0], depth + 1);
          const shape = shapeOf(x);
          if (shape === 1) return callByName(name, Array.from({ length: arity }, () => x), n, hint);
          if (shape === arity && (x.k === 'ref' || x.k === 'global')) return x;
          return reject(n, `${name}() takes all ${arity} components — ${name}(${['x', 'y', 'z', 'w'].slice(0, arity).join(', ')})`);
        }
        if (argNodes.length !== arity) {
          return reject(n, `${name}() takes all ${arity} components, not ${argNodes.length} — ${name}(${['x', 'y', 'z', 'w'].slice(0, arity).join(', ')})`);
        }
        const parts = walkArgs();
        // A component wider than one channel would be spliced into the vector
        // by TSL, shifting every later component.
        if (parts.some((p) => shapeOf(p) > 1)) {
          return reject(n, `each ${name}() component must be ONE number — use a.x, a.y … or a float value`);
        }
        return callByName(name, parts, n, hint);
      }
      case 'uv':
        if (argNodes.length !== 0) return reject(n, `uv() takes no argument — tile it with mul(uv(), vec2(a, b))`);
        return addStep({ op: 'uv', tiling: null }, n, hint);
      case 'mul': {
        if (argNodes.length === 2) {
          const tiling = uvTiling(argNodes[0], argNodes[1]) ?? uvTiling(argNodes[1], argNodes[0]);
          if (tiling) return addStep({ op: 'uv', tiling: [finite(tiling[0], n), finite(tiling[1], n)] }, n, hint);
        }
        return callByName('mul', walkArgs(), n, hint);
      }
      case 'Fn':
        return reject(n, `no helper functions — write every step as its own const`);
      case 'Discard':
        return reject(n, `Discard is not available — a generated group has no Output`);
    }

    const entry = entryFor(name);
    if (!entry) return reject(n, `${name}() is not in the node list`);
    switch (entry.kind) {
      case 'global':
        // `positionWorld()` would mint a node per call; the input is the value.
        if (argNodes.length !== 0) return reject(n, `${entry.name} is an input — write it bare, without ( )`);
        return { k: 'global', name: entry.name };
      case 'noise':
        return noiseStep(entry, n, depth, hint, false);
      case 'call':
        return callStep(entry, walkArgs(), n, hint);
      default:
        return reject(n, `write ${entry.name} as ${entry.name === 'uv' ? 'uv()' : `${entry.name}(…)`}`);
    }
  };

  const methodCall = (n: T.CallExpression, callee: T.MemberExpression, argNodes: T.Expression[], depth: number, hint?: Hint): Arg => {
    if (callee.computed || callee.property.type !== 'Identifier') return reject(n, `${describe(n)} is not a plain call`);
    const m = callee.property.name;
    const recv = callee.object as T.Expression;

    if ((m === 'toVar' || m === 'toConst') && argNodes.length === 0) return form(recv, depth + 1, hint);

    // `Math.sin(x)`, `TSL.mix(a, b, t)`: a namespace would shift every
    // argument one port in the parser.
    if (recv.type === 'Identifier' && !bindings.has(recv.name) && !entryFor(recv.name)
      && !declaredAnywhere.has(recv.name) && (recv.name === 'Math' || /^[A-Z]/.test(recv.name))) {
      return reject(n, `${recv.name}.${m}() is not available — call ${m}(…) directly from the node list`);
    }

    // Time's own speed: `time.mul(k)`.
    if (m === 'mul' && argNodes.length === 1 && recv.type === 'Identifier' && recv.name === 'time' && !bindings.has('time')) {
      const speed = form(argNodes[0], depth + 1);
      if (speed.k === 'num' && speed.v === 1) return addStep({ op: 'alias', global: 'time' }, n, hint);
      if (speed.k === 'num' || speed.k === 'ref') return addStep({ op: 'time', speed }, n, hint);
      return callByName('mul', [{ k: 'global', name: 'time' }, speed], n, hint);
    }

    // The unsigned noise remap: `<noise>(…).mul(0.5).add(0.5)`.
    if (m === 'add' && argNodes.length === 1 && foldNumber(argNodes[0]) === 0.5
      && recv.type === 'CallExpression' && recv.callee.type === 'MemberExpression' && !recv.callee.computed
      && recv.callee.property.type === 'Identifier' && recv.callee.property.name === 'mul'
      && recv.arguments.length === 1 && foldNumber(recv.arguments[0] as T.Expression) === 0.5) {
      const inner = recv.callee.object;
      if (inner.type === 'CallExpression' && inner.callee.type === 'Identifier') {
        const entry = entryFor(inner.callee.name);
        if (entry?.kind === 'noise' && entry.signed) return noiseStep(entry, inner, depth + 1, hint, true);
      }
    }

    // `uv().mul(vec2(a, b))`.
    if (m === 'mul' && argNodes.length === 1) {
      const tiling = uvTiling(recv, argNodes[0]);
      if (tiling) return addStep({ op: 'uv', tiling: [finite(tiling[0], n), finite(tiling[1], n)] }, n, hint);
    }

    const entry = catalogue.byName.get(m);
    if (entry?.kind === 'call') {
      const self = form(recv, depth + 1);
      const rest = argNodes.map((a) => form(a, depth + 1));
      return callStep(entry, RECEIVER_LAST.has(m) ? [...rest, self] : [self, ...rest], n, hint);
    }
    return reject(n, `.${m}() is not available as a method — call ${m}(…) as a free function from the node list`);
  };

  /** `color(0xRRGGBB)`'s value. Seven or eight digits (`0xFFFFD700`, an
   *  alpha byte in front) keep the low 24 bits — exactly what three's
   *  `Color.setHex` reads, so the colour is the one TSL would show. */
  const hexOf = (c: T.CallExpression): number | null => {
    if (c.arguments.length !== 1) return null;
    const a = c.arguments[0];
    if (a.type !== 'NumericLiteral') return null;
    const raw = (a.extra as { raw?: string } | undefined)?.raw ?? '';
    if (!/^0[xX][0-9a-fA-F]{1,8}$/.test(raw)) return null;
    return a.value % 0x1000000;
  };

  /* ── statements ── */

  const declare = (decl: T.VariableDeclarator): void => {
    if (decl.id.type !== 'Identifier') reject(decl, `no destructuring — one const per value`);
    const name = (decl.id as T.Identifier).name;
    if (!decl.init) reject(decl, `const ${name} has no value`);
    const init = decl.init as T.Expression;
    usedNames.add(name);
    // An input given its own name is its own node.
    if (init.type === 'Identifier' && !bindings.has(init.name)) {
      const entry = entryFor(init.name);
      if (entry?.kind === 'global') {
        bindings.set(name, addStep({ op: 'alias', global: entry.name }, init, { name, used: false }));
        return;
      }
    }
    const hint: Hint = { name, used: false };
    const value = form(init, 0, hint);
    bindings.set(name, value);
  };

  const statement = (s: T.Statement): void => {
    if (ret) reject(s, `nothing may follow the return`);
    switch (s.type) {
      case 'VariableDeclaration':
        for (const d of s.declarations) declare(d);
        return;
      case 'ReturnStatement': {
        if (!s.argument) reject(s, `return the final colour: return result;`);
        const a = s.argument as T.Expression;
        if (a.type === 'ObjectExpression') {
          reject(s, `return ONE value — the final colour — not an object of channels`);
        }
        // `return vec3(x)` is the scalar widening graphToCode writes for a
        // grey result: the value is x.
        const widened = a.type === 'CallExpression' && a.callee.type === 'Identifier' && a.callee.name === 'vec3'
          && a.arguments.length === 1 && (a.arguments[0].type === 'Identifier' || a.arguments[0].type === 'MemberExpression')
          ? (a.arguments[0] as T.Expression) : a;
        const v = form(widened, 0);
        if (v.k === 'num') reject(s, `return a const, not a number`);
        // A comparison is 0 or 1, not a colour: the dialect asks for the
        // colour it should pick. (graphToCode writes one into an Output as
        // vec3(float(x)), which the parser now reads back through
        // stripIntPromotions; it once read black.)
        if (v.k === 'ref' && steps[v.id].op.op === 'call' && LOGIC_FNS.has((steps[v.id].op as { fn: string }).fn)) {
          reject(s, `return a colour, not a comparison — turn it into one with select(condition, colorA, colorB) or mix`);
        }
        ret = v;
        retLine = lineOf(s);
        return;
      }
      case 'EmptyStatement':
        return;
      case 'ExpressionStatement': {
        const e = s.expression;
        if (e.type === 'AssignmentExpression') return void reject(s, `no reassignment — make a new const`);
        if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === 'Discard') {
          return void reject(s, `Discard is not available — a generated group has no Output`);
        }
        if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && e.callee.property.type === 'Identifier'
          && /assign$/i.test(e.callee.property.name)) {
          return void reject(s, `no .assign — make a new const`);
        }
        return void reject(s, `every line must be a const — ${describe(e)} does nothing`);
      }
      case 'IfStatement':
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'SwitchStatement':
        return void reject(s, `no if or loops — use select(condition, a, b), mix or step-free maths`);
      case 'FunctionDeclaration':
        return void reject(s, `no helper functions — write every step as its own const`);
      default:
        return void reject(s, `${s.type} is not allowed here`);
    }
  };

  /* ── the envelope: which statements are the body ── */

  const program = ast.program;
  let body: T.Statement[] | null = null;
  const moduleConsts: T.Statement[] = [];
  const isFnCall = (e: T.Node | null | undefined): e is T.CallExpression =>
    !!e && e.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === 'Fn';
  const fnBody = (call: T.CallExpression): T.Statement[] => {
    const f = call.arguments[0];
    if (call.arguments.length !== 1 || !f || (f.type !== 'ArrowFunctionExpression' && f.type !== 'FunctionExpression')) {
      return reject(call, `the shader is Fn(() => { … })`);
    }
    if (f.params.length > 0) reject(f, `the shader's Fn takes no parameters: Fn(() => { … })`);
    if (f.body.type === 'BlockStatement') return f.body.body;
    return [{ type: 'ReturnStatement', argument: f.body, loc: f.body.loc } as unknown as T.Statement];
  };

  try {
    const topReturn = program.body.some((s) => s.type === 'ReturnStatement');
    if (topReturn) {
      body = program.body.filter((s) => s.type !== 'ImportDeclaration');
    } else {
      const fns = new Map<string, T.CallExpression>();
      let exported: string | T.CallExpression | null = null;
      for (const s of program.body) {
        if (s.type === 'ImportDeclaration') continue;
        if (s.type === 'ExportDefaultDeclaration') {
          const d = s.declaration;
          if (d.type === 'Identifier') exported = d.name;
          else if (isFnCall(d)) exported = d;
          else reject(s, `export the shader: export default shader;`);
          continue;
        }
        if (s.type === 'VariableDeclaration') {
          const fnDecls = s.declarations.filter((d) => isFnCall(d.init));
          for (const d of fnDecls) {
            const name = d.id.type === 'Identifier' ? d.id.name : '';
            if (opts.trusted && MODULE_HELPER_NAMES.has(name)) continue;
            fns.set(name, d.init as T.CallExpression);
          }
          if (fnDecls.length === 0) moduleConsts.push(s);
          else if (fnDecls.length !== s.declarations.length) reject(s, `declare the shader Fn on its own line`);
          continue;
        }
        if (s.type === 'EmptyStatement') continue;
        reject(s, s.type === 'FunctionDeclaration' ? `no helper functions — write every step as its own const`
          : `only imports, consts and the shader Fn belong at the top level`);
      }
      let shaderFn: T.CallExpression | undefined;
      if (exported && typeof exported !== 'string') shaderFn = exported;
      else if (typeof exported === 'string') shaderFn = fns.get(exported);
      else if (fns.size === 1) shaderFn = [...fns.values()][0];
      if (!shaderFn) {
        return { ok: false, problems: [{ line: 0, text: 'no shader found — write const shader = Fn(() => { … }); export default shader;' }] };
      }
      const extra = [...fns.values()].filter((f) => f !== shaderFn);
      if (extra.length > 0) reject(extra[0], `no helper functions — write every step as its own const inside the shader`);
      body = [...moduleConsts, ...fnBody(shaderFn)];
    }
  } catch (e) {
    if (e instanceof Reject) return { ok: false, problems: [{ line: e.line, text: e.why }] };
    throw e;
  }

  for (const s of body) {
    if (s.type !== 'VariableDeclaration') continue;
    for (const d of s.declarations) if (d.id.type === 'Identifier') declaredAnywhere.add(d.id.name);
  }

  body.forEach((s) => {
    if (problems.length >= MAX_PROBLEMS) return;
    try {
      statement(s);
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      problems.push({ line: e.line, text: e.why });
      // A const that failed still names something; later lines that use it
      // should not ALSO be reported as undeclared.
      if (s.type === 'VariableDeclaration') {
        for (const d of s.declarations) {
          if (d.id.type === 'Identifier' && !bindings.has(d.id.name)) bindings.set(d.id.name, FAILED);
        }
      }
    }
  });
  if (problems.length > 0) return { ok: false, problems: problems.slice(0, MAX_PROBLEMS) };
  if (!ret) return { ok: false, problems: [{ line: 0, text: 'the program has no return — end with: return result;' }] };

  return prune({ steps, ret, retLine });
}

/** Drop every step the return does not reach, renumbering the rest. */
function prune(p: Program): WalkResult {
  const live = new Set<number>();
  const visit = (id: number): void => {
    if (live.has(id)) return;
    live.add(id);
    for (const r of stepRefs(p.steps[id].op)) visit(r);
  };
  const retRefs: number[] = [];
  const collect = (a: Arg): void => { if (a.k === 'ref') retRefs.push(a.id); else if (a.k === 'swz') collect(a.of); };
  collect(p.ret);
  for (const r of retRefs) visit(r);

  const pruned = p.steps.filter((_, i) => !live.has(i)).map((s) => s.name);
  if (pruned.length === 0) return { ok: true, program: p, info: { pruned } };

  const renum = new Map<number, number>();
  const kept: Step[] = [];
  p.steps.forEach((s, i) => { if (live.has(i)) { renum.set(i, kept.length); kept.push(s); } });
  const mapArg = (a: Arg): Arg =>
    a.k === 'ref' ? { k: 'ref', id: renum.get(a.id)! } : a.k === 'swz' ? { ...a, of: mapArg(a.of) } : a;
  const mapOp = (op: StepOp): StepOp => {
    switch (op.op) {
      case 'time': return { ...op, speed: mapArg(op.speed) };
      case 'noise': return { ...op, pos: mapArg(op.pos), scale: mapArg(op.scale) };
      case 'call': return { ...op, args: op.args.map(mapArg) };
      default: return op;
    }
  };
  return {
    ok: true,
    program: { steps: kept.map((s) => ({ ...s, op: mapOp(s.op) })), ret: mapArg(p.ret), retLine: p.retLine },
    info: { pruned },
  };
}

/** A problem as one line for the repair prompt and the dialog: the line
 *  number, the offending source line (DATA) and what to do. */
export function problemLine(p: Problem, code: string): string {
  if (p.line <= 0) return p.text;
  const src = (code.split('\n')[p.line - 1] ?? '').trim();
  const quoted = src.length > 80 ? `${src.slice(0, 77)}…` : src;
  return quoted ? `line ${p.line} \`${quoted}\`: ${p.text}` : `line ${p.line}: ${p.text}`;
}
