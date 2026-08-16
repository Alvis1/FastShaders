/**
 * The Data Range node's user-editable formula.
 *
 * The settings menu lets a user type an expression like `(v - lo) / (hi - lo)`
 * and have the shader evaluate it. That string travels inside a shared
 * `.fastshader`, and the module graphToCode builds is EXECUTED at the app's real
 * origin by the XR popup (and shipped inside every downloaded `.js`) — so the
 * string must never become code.
 *
 * The precedent in this codebase is `isSafeUnknownExpression`
 * (engine/graphToCode.ts) — a validate-then-pass-through design: Babel parses
 * the string, an allow-list walk approves it, and the ORIGINAL string is then
 * spliced into the module. That is defensible for `unknown` nodes, whose string
 * came out of this app's own parser. It is the wrong shape here, because a
 * formula is *designed* to be typed by a human and *designed* to be shared.
 *
 * So this module is PARSE-THEN-RE-EMIT. The input is tokenized into a closed AST
 * that contains no free-form strings at all — identifiers resolve to members of
 * the `VarId` union at parse time, function names to members of `FuncId` — and
 * the emitter writes TSL from that AST using only its own literal tables.
 *
 *   EMISSION CLOSURE (the security property). Every character emitted for a
 *   Data Range node is drawn from a finite, statically-known alphabet: the TSL
 *   names in FUNCS, the fixed method names, the punctuation `( ) , .`, numeric
 *   literals produced by `num()` from JS numbers proven finite, and the upstream
 *   reference `src` that graphToCode's own `scalarRefOf` produced. The user's
 *   string contributes ZERO characters.
 *
 * Injection is therefore not *blocked*, it is *unrepresentable*: there is no AST
 * node shape that can carry an attacker-chosen string to the emitter.
 *
 * Every rejection falls back to the built-in chain the node has always emitted,
 * so a hostile file still compiles — it just renders the mode it claims.
 */

import type { AppNode } from '@/types';
import { getNodeValues } from '@/types';
import type { ColumnStats, NormalizePlan } from './dataViz';

/** Longest formula we will even tokenize. A normalization formula is one line —
 *  the longest built-in default is 62 chars. This is also the bound the store
 *  sanitizer enforces, for the `dataB64` reason (utils/dataNode.ts): the string
 *  rides ~50 structuredClone history snapshots, the 300 ms autosave, the
 *  clipboard and every export. */
export const MAX_FORMULA_CHARS = 512;
/** Token budget. 500 nested parens is 500 tokens and dies here. */
const MAX_TOKENS = 256;
/** Recursion budget — an EXPLICIT counter, so the JS stack is never the limit. */
const MAX_DEPTH = 32;
/** AST node budget. Also bounds the cost mispricing (dataRange prices flat). */
const MAX_NODES = 128;
const MAX_NAME_CHARS = 32;
/** Longest offending lexeme echoed back to the menu. */
const MAX_GOT_CHARS = 16;

export type VarId =
  | 'v'
  | 'lo'
  | 'hi'
  | 'thresh'
  | 'm'
  | 'dmin'
  | 'dmax'
  | 'mean'
  | 'sd'
  | 'p2'
  | 'p98'
  | 'n';

export type FuncId =
  | 'abs'
  | 'sign'
  | 'floor'
  | 'ceil'
  | 'round'
  | 'fract'
  | 'sqrt'
  | 'exp'
  | 'exp2'
  | 'log'
  | 'log2'
  | 'sin'
  | 'cos'
  | 'tan'
  | 'asin'
  | 'acos'
  | 'atan'
  | 'saturate'
  | 'min'
  | 'max'
  | 'pow'
  | 'step'
  | 'clamp'
  | 'mix'
  | 'smoothstep';

export type BinOp = '+' | '-' | '*' | '/' | '^';

/**
 * The AST. **It carries no free-form strings.** `VarId` and `FuncId` are closed
 * unions whose members the parser can only produce by hitting a table entry, and
 * `num` holds a JS number already proven finite. There is no node shape that can
 * transport an attacker-chosen string to the emitter.
 */
export type FormulaAst =
  | { k: 'num'; v: number }
  | { k: 'var'; id: VarId }
  | { k: 'neg'; a: FormulaAst }
  | { k: 'bin'; op: BinOp; a: FormulaAst; b: FormulaAst }
  | { k: 'call'; fn: FuncId; args: FormulaAst[] };

/** Stable CODES, never sentences: this pure layer must hold no UI strings, and
 *  an enumerable set is what keeps the i18n obligation finite. */
export type FormulaErrorCode =
  /** No key, not a string, or blank — use the built-in chain SILENTLY. */
  | 'absent'
  | 'too-long'
  /** Token / node / depth budget. */
  | 'too-complex'
  | 'bad-char'
  | 'bad-number'
  | 'unknown-name'
  | 'not-a-function'
  | 'bad-arity'
  | 'syntax'
  /** Emit-time: a constant fold produced NaN or ±Infinity. */
  | 'non-finite';

export interface FormulaError {
  code: FormulaErrorCode;
  /** Character offset into the formula, for the menu's caret hint. */
  at: number;
  /** The offending lexeme, capped. Rendered as TEXT by React, never emitted. */
  got?: string;
}

export type ParseResult = { ok: true; ast: FormulaAst } | { ok: false; err: FormulaError };

/**
 * Did the user actually author a formula on this node?
 *
 * The ONE predicate every surface asks, so the canvas chip, the settings menu
 * and code generation cannot disagree about what "has a formula" means. A
 * whitespace-only string is NOT one: `parseFormula` trims first and reports it
 * as `absent`, so the shader is already emitting the plain built-in chain — a
 * surface that called it custom would mark and red-flag a node that is doing
 * the completely normal thing.
 */
export function hasCustomFormula(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim() !== '';
}

/**
 * A short English phrase for a rejection, used in the GENERATED CODE comment.
 *
 * Generated source is canonical English throughout (`// Empty shader — add
 * nodes to begin`), so unlike the menu's `ERROR_TEXT` this one belongs in the
 * pure layer: it never reaches the UI and never goes through `t()`.
 */
export function formulaErrorSummary(code: FormulaErrorCode): string {
  switch (code) {
    case 'too-long':
      return 'formula too long';
    case 'too-complex':
      return 'formula too complex';
    case 'bad-char':
      return 'unexpected character';
    case 'bad-number':
      return 'invalid number';
    case 'unknown-name':
      return 'unknown name';
    case 'not-a-function':
      return 'that name is a value, not a function';
    case 'bad-arity':
      return 'wrong number of arguments';
    case 'non-finite':
      return 'divides by zero on this data';
    default:
      return 'syntax error';
  }
}

/**
 * Variable table.
 *
 * A `Map`, not an object literal — the prototype-chain hardening class already
 * applied to `VALID_SWIZZLE` and the `TOHSL_*` tables in graphToCode. A bare
 * `Record` indexed by an adversarial string resolves `constructor`,
 * `__proto__`, `toString` and `valueOf` through the prototype to truthy values.
 */
const VARS = new Map<string, VarId>([
  ['v', 'v'],
  ['value', 'v'],
  ['lo', 'lo'],
  ['hi', 'hi'],
  ['thresh', 'thresh'],
  ['m', 'm'],
  ['min', 'dmin'],
  ['max', 'dmax'],
  ['mean', 'mean'],
  ['sd', 'sd'],
  ['p2', 'p2'],
  ['p98', 'p98'],
  ['n', 'n'],
  ['count', 'n'],
]);

/** The variable names offered in the menu's hint line, in table order. */
export const FORMULA_VAR_NAMES = [...new Set(VARS.keys())];

interface FuncEntry {
  id: FuncId;
  arity: number;
  /** The `three/tsl` export name. THIS string — not the user's spelling — is
   *  what reaches the module. A homoglyph that somehow tokenized and somehow hit
   *  a table entry would still emit this. */
  tsl: string;
  /** CPU constant-fold, so a formula with no `v` in it becomes a literal. */
  fold: (a: number[]) => number;
}

const F = (id: FuncId, arity: number, fold: (a: number[]) => number): [string, FuncEntry] => [
  id,
  { id, arity, tsl: id, fold },
];

/**
 * Function table: fixed name, fixed arity, fixed TSL symbol, fixed fold.
 *
 * Every one is emitted in FREE-FUNCTION form, never as a method. Measured
 * against the shipped three/tsl: `a.mix(b,c)`, `a.smoothstep(b,c)` and
 * `a.step(b)` all displace the receiver out of the first slot. Using the free
 * form for every named function removes that whole bug class in one rule
 * instead of maintaining a per-function receiver-slot table.
 *
 * Deliberately ABSENT:
 *   - `mod` / `%` — GLSL mod is floor-modulo, WGSL `%` truncated; they disagree
 *     for negative operands, so a folded constant could differ from the same
 *     expression per-fragment on one backend.
 *   - two-argument `atan` — no `atan2` exists on a node; 1-arity only.
 *   - comparisons / `select` / booleans — they introduce a second value domain
 *     and the `>= 0.5` vs `bool()` truthiness trap documented twice in
 *     CLAUDE.md (Discard, select).
 *   - vector constructors — the node's output port is declared `float` and
 *     `portShapeForHandle` returns 1 for it unconditionally. Scalar-ness is a
 *     GRAMMAR INVARIANT here: `v` is scalar (scalarRefOf narrows with `.x`),
 *     every literal is scalar, and no production widens.
 */
const FUNCS = new Map<string, FuncEntry>([
  F('abs', 1, (a) => Math.abs(a[0])),
  F('sign', 1, (a) => Math.sign(a[0])),
  F('floor', 1, (a) => Math.floor(a[0])),
  F('ceil', 1, (a) => Math.ceil(a[0])),
  F('round', 1, (a) => Math.round(a[0])),
  F('fract', 1, (a) => a[0] - Math.floor(a[0])),
  F('sqrt', 1, (a) => Math.sqrt(a[0])),
  F('exp', 1, (a) => Math.exp(a[0])),
  F('exp2', 1, (a) => 2 ** a[0]),
  F('log', 1, (a) => Math.log(a[0])),
  F('log2', 1, (a) => Math.log2(a[0])),
  F('sin', 1, (a) => Math.sin(a[0])),
  F('cos', 1, (a) => Math.cos(a[0])),
  F('tan', 1, (a) => Math.tan(a[0])),
  F('asin', 1, (a) => Math.asin(a[0])),
  F('acos', 1, (a) => Math.acos(a[0])),
  F('atan', 1, (a) => Math.atan(a[0])),
  F('saturate', 1, (a) => Math.min(1, Math.max(0, a[0]))),
  F('min', 2, (a) => Math.min(a[0], a[1])),
  F('max', 2, (a) => Math.max(a[0], a[1])),
  F('pow', 2, (a) => Math.pow(a[0], a[1])),
  F('step', 2, (a) => (a[1] < a[0] ? 0 : 1)),
  F('clamp', 3, (a) => Math.min(a[2], Math.max(a[1], a[0]))),
  F('mix', 3, (a) => a[0] + (a[1] - a[0]) * a[2]),
  F('smoothstep', 3, (a) => {
    const t = Math.min(1, Math.max(0, (a[2] - a[0]) / (a[1] - a[0])));
    return t * t * (3 - 2 * t);
  }),
]);

/** The TSL symbols this module can ever emit. Exported so the contract test can
 *  assert every one exists as a real `three/tsl` function — a name that does not
 *  exist produces perfect-looking source and a blank preview pane. */
export const FORMULA_TSL_SYMBOLS: string[] = [
  ...[...FUNCS.values()].map((f) => f.tsl),
  // Emitted by the operator branches of `walk`.
  'add',
  'sub',
  'mul',
  'div',
  'pow',
  'negate',
  'float',
];

/** The function names offered in the menu's hint line. */
export const FORMULA_FUNC_NAMES = [...FUNCS.keys()];

// ASCII by explicit code-unit range. NOT /\w/ (unicode-aware in some engines),
// and NOT Number()-delegated digit detection — `Number('٥') === 5`, so a scanner
// that let Number() decide would silently accept an Arabic-Indic homoglyph.
const isDigit = (c: string) => c >= '0' && c <= '9';
const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

type Tok =
  | { t: 'num'; v: number; at: number }
  | { t: 'name'; s: string; at: number }
  | { t: 'op'; s: BinOp; at: number }
  | { t: 'lp' | 'rp' | 'comma'; at: number };

class Fail extends Error {
  constructor(readonly e: FormulaError) {
    super(e.code);
  }
}

/** A `function` declaration, not a `const` arrow: TypeScript only lets a
 *  `never`-returning call narrow control flow when the callee is declared this
 *  way, and the parser leans on `if (!tk) fail(...)` throughout. */
function fail(code: FormulaErrorCode, at: number, got?: string): never {
  throw new Fail({ code, at, got: got === undefined ? undefined : got.slice(0, MAX_GOT_CHARS) });
}

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (out.length >= MAX_TOKENS) fail('too-complex', i);

    if (isDigit(c) || (c === '.' && isDigit(s[i + 1] ?? ''))) {
      const start = i;
      while (isDigit(s[i])) i++;
      if (s[i] === '.') {
        i++;
        while (isDigit(s[i])) i++;
      }
      if (s[i] === 'e' || s[i] === 'E') {
        const mark = i;
        i++;
        if (s[i] === '+' || s[i] === '-') i++;
        // 'e' was not an exponent after all — back off so `2e` lexes as `2`
        // followed by the name `e`, which then fails as an unknown name.
        if (!isDigit(s[i])) i = mark;
        else while (isDigit(s[i])) i++;
      }
      const lex = s.slice(start, i);
      if (lex.length > MAX_NAME_CHARS) fail('bad-number', start, lex);
      const v = Number(lex);
      // 1e999 → Infinity. A non-finite literal must never reach the emitter,
      // where num() would silently print it as '0' and change what the shader
      // computes.
      if (!Number.isFinite(v)) fail('bad-number', start, lex);
      out.push({ t: 'num', v, at: start });
      continue;
    }

    if (isAlpha(c)) {
      const start = i;
      while (isAlpha(s[i]) || isDigit(s[i])) i++;
      const lex = s.slice(start, i);
      if (lex.length > MAX_NAME_CHARS) fail('unknown-name', start, lex);
      out.push({ t: 'name', s: lex, at: start });
      continue;
    }

    if (c === '(') {
      out.push({ t: 'lp', at: i++ });
      continue;
    }
    if (c === ')') {
      out.push({ t: 'rp', at: i++ });
      continue;
    }
    if (c === ',') {
      out.push({ t: 'comma', at: i++ });
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^') {
      out.push({ t: 'op', s: c, at: i++ });
      continue;
    }
    // Everything else lands here: '.', ';', '[', '"', '\\', backtick, U+00A0,
    // U+200B, a lone surrogate, a Cyrillic or fullwidth homoglyph. An invisible
    // character is a REJECTION, never a silent skip.
    //
    // String.prototype.normalize() is deliberately never called and case is
    // never folded: normalizing would MAP homoglyph-adjacent forms onto real
    // names, manufacturing the vulnerability it looks like it prevents.
    fail('bad-char', i, c);
  }
  return out;
}

/**
 * Grammar, precedence low → high:
 *
 *   expr    := term (('+' | '-') term)*        left-assoc
 *   term    := unary (('*' | '/') unary)*      left-assoc
 *   unary   := ('-' | '+') unary | power
 *   power   := primary ('^' unary)?            RIGHT-assoc
 *   primary := number | name | name '(' args? ')' | '(' expr ')'
 *
 * `unary` sits LOOSER than `^`, so `-2^2` is `-(2^2)` = −4 (mathematical
 * convention) and `2^-3` parses. There is no member operator, so `v.abs()` is a
 * scan error at the `.` — the language has no method syntax.
 */
class Parser {
  private i = 0;
  private depth = 0;
  private nodes = 0;

  constructor(private readonly t: Tok[]) {}

  private end(): number {
    return this.t.length ? this.t[this.t.length - 1].at + 1 : 0;
  }

  private peek(): Tok | undefined {
    return this.t[this.i];
  }

  private mk<T extends FormulaAst>(n: T): T {
    if (++this.nodes > MAX_NODES) fail('too-complex', this.peek()?.at ?? this.end());
    return n;
  }

  /** One counter guarding EVERY recursive entry point, so 500 nested parens can
   *  never reach the JS stack — and neither can 500 unary minuses, which do not
   *  pass through parseExpr. */
  private enter(): void {
    if (++this.depth > MAX_DEPTH) fail('too-complex', this.peek()?.at ?? this.end());
  }

  private leave(): void {
    this.depth--;
  }

  expectEnd(): void {
    if (this.i !== this.t.length) fail('syntax', this.peek()!.at);
  }

  parseExpr(): FormulaAst {
    this.enter();
    let a = this.parseTerm();
    for (let tk = this.peek(); tk?.t === 'op' && (tk.s === '+' || tk.s === '-'); tk = this.peek()) {
      this.i++;
      a = this.mk({ k: 'bin' as const, op: tk.s, a, b: this.parseTerm() });
    }
    this.leave();
    return a;
  }

  private parseTerm(): FormulaAst {
    this.enter();
    let a = this.parseUnary();
    for (let tk = this.peek(); tk?.t === 'op' && (tk.s === '*' || tk.s === '/'); tk = this.peek()) {
      this.i++;
      a = this.mk({ k: 'bin' as const, op: tk.s, a, b: this.parseUnary() });
    }
    this.leave();
    return a;
  }

  private parseUnary(): FormulaAst {
    this.enter();
    const tk = this.peek();
    let out: FormulaAst;
    if (tk?.t === 'op' && (tk.s === '-' || tk.s === '+')) {
      this.i++;
      const a = this.parseUnary();
      out = tk.s === '-' ? this.mk({ k: 'neg' as const, a }) : a;
    } else {
      out = this.parsePower();
    }
    this.leave();
    return out;
  }

  private parsePower(): FormulaAst {
    this.enter();
    const base = this.parsePrimary();
    const tk = this.peek();
    let out: FormulaAst = base;
    if (tk?.t === 'op' && tk.s === '^') {
      this.i++;
      // Right-associative, and the exponent goes through parseUnary so `2^-3`
      // works and `2^3^2` is `2^(3^2)`.
      out = this.mk({ k: 'bin' as const, op: '^' as const, a: base, b: this.parseUnary() });
    }
    this.leave();
    return out;
  }

  private parsePrimary(): FormulaAst {
    this.enter();
    const tk = this.peek();
    if (!tk) fail('syntax', this.end());
    let out: FormulaAst;

    if (tk.t === 'num') {
      this.i++;
      out = this.mk({ k: 'num' as const, v: tk.v });
    } else if (tk.t === 'lp') {
      this.i++;
      out = this.parseExpr();
      if (this.peek()?.t !== 'rp') fail('syntax', this.peek()?.at ?? this.end());
      this.i++;
    } else if (tk.t === 'name') {
      this.i++;
      if (this.peek()?.t === 'lp') {
        const fn = FUNCS.get(tk.s);
        // A name followed by '(' that is not in FUNCS. Reported distinctly from
        // 'unknown-name' so the menu can say "min is a value, not a function".
        if (!fn) fail(VARS.has(tk.s) ? 'not-a-function' : 'unknown-name', tk.at, tk.s);
        this.i++;
        const args: FormulaAst[] = [];
        if (this.peek()?.t !== 'rp') {
          for (;;) {
            args.push(this.parseExpr());
            if (this.peek()?.t === 'comma') {
              this.i++;
              continue;
            }
            break;
          }
        }
        if (this.peek()?.t !== 'rp') fail('syntax', this.peek()?.at ?? this.end());
        this.i++;
        if (args.length !== fn!.arity) fail('bad-arity', tk.at, tk.s);
        // The FuncId written into the AST is the TABLE'S OWN value, not `tk.s`.
        out = this.mk({ k: 'call' as const, fn: fn!.id, args });
      } else {
        const id = VARS.get(tk.s);
        if (!id) fail('unknown-name', tk.at, tk.s);
        out = this.mk({ k: 'var' as const, id: id! });
      }
    } else {
      fail('syntax', tk.at);
    }

    this.leave();
    return out!;
  }
}

/**
 * Parse a stored formula value.
 *
 * NEVER `String(raw)`. Coercion is what turns `['(v-lo)']` into a valid formula
 * and `{}` into `'[object Object]'` — the exact-identity read is the noiseRange
 * convention applied to a string.
 */
export function parseFormula(raw: unknown): ParseResult {
  if (typeof raw !== 'string') return { ok: false, err: { code: 'absent', at: 0 } };
  if (raw.trim() === '') return { ok: false, err: { code: 'absent', at: 0 } };
  if (raw.length > MAX_FORMULA_CHARS) return { ok: false, err: { code: 'too-long', at: 0 } };

  try {
    const p = new Parser(tokenize(raw));
    const ast = p.parseExpr();
    p.expectEnd();
    return { ok: true, ast };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, err: e.e };
    // A parser bug must degrade to the built-in chain, never take the graph
    // down: graphToCode runs on every keystroke and has no error boundary, and
    // the 300 ms autosave would then persist the poison.
    return { ok: false, err: { code: 'syntax', at: 0 } };
  }
}

export type FormulaEnv = Readonly<Record<VarId, number>>;

/** Finite or the stated fallback. Every binding must be finite: a NaN reaching a
 *  fold would poison the whole expression, and the emitter's non-finite reject
 *  should mean "the FORMULA divides by zero", not "the environment was broken". */
const fin = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

/**
 * Bind every variable the grammar can name.
 *
 * TOTAL by construction: an affine plan has no `thresh`, and a symlog plan has
 * no `lo`/`hi`, so each derives the other's vocabulary the same way
 * `planNormalize` itself would. Without totality a formula would have an
 * "unbound but syntactically valid" state — the class of bug that produces a
 * blank preview with no error.
 */
export function formulaEnv(
  plan: NormalizePlan,
  stats: ColumnStats | null,
  manual: { lo: number; hi: number },
): FormulaEnv {
  let lo: number;
  let hi: number;
  let thresh: number;
  let m: number;
  if (plan.kind === 'symlog') {
    m = fin(plan.m, 1);
    thresh = fin(plan.thresh, m * 1e-3);
    lo = -m;
    hi = m;
  } else {
    lo = fin(plan.lo, 0);
    hi = fin(plan.hi, 1);
    m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    thresh = m * 1e-3;
  }
  const s = stats;
  return Object.freeze({
    // Never read — `v` is the one non-constant, substituted by the emitter.
    v: NaN,
    lo,
    hi,
    thresh,
    m,
    dmin: fin(s ? s.min : manual.lo, 0),
    dmax: fin(s ? s.max : manual.hi, 1),
    mean: fin(s ? s.mean : (manual.lo + manual.hi) / 2, 0),
    // sd = 0 with no column is deliberate: `(v - mean) / sd` then folds to
    // Infinity, the emitter rejects, and the built-in chain runs. Honest failure
    // with an explanation, rather than a shader that paints Infinity.
    sd: fin(s ? s.sd : 0, 0),
    p2: fin(s ? s.p2 : manual.lo, 0),
    p98: fin(s ? s.p98 : manual.hi, 1),
    n: fin(s ? s.count : 0, 0),
  });
}

export type EmitResult = { ok: true; code: string } | { ok: false; err: FormulaError };

/**
 * A folded constant, or a TSL expression string.
 *
 * INVARIANT: every `{c:false}` string is either `name(...)` or a
 * `<receiver>.method(...)` chain. Both are self-delimiting, so the emitter never
 * needs parentheses and can never produce an ambiguous concatenation — which is
 * why there is no precedence logic on the way OUT.
 */
type Val = { c: true; n: number } | { c: false; s: string };

/** Mirrors graphToCode's own `num`. Every literal goes through it even though
 *  folds are already finite-checked — two independent guards on the one thing
 *  that can print `Infinity` into a module. */
const num = (n: number): string => (Number.isFinite(n) ? String(n) : '0');

const chk = (n: number, at: number): number => (Number.isFinite(n) ? n : fail('non-finite', at));

const FOLD: Record<BinOp, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '^': (a, b) => Math.pow(a, b),
};

function walk(a: FormulaAst, src: string, env: FormulaEnv, imp: (n: string) => void): Val {
  switch (a.k) {
    case 'num':
      return { c: true, n: a.v };

    case 'var':
      return a.id === 'v' ? { c: false, s: src } : { c: true, n: chk(env[a.id], 0) };

    case 'neg': {
      const x = walk(a.a, src, env, imp);
      return x.c ? { c: true, n: chk(-x.n, 0) } : { c: false, s: `${x.s}.negate()` };
    }

    case 'call': {
      // FuncId came from FUNCS, so this lookup cannot miss.
      const fn = FUNCS.get(a.fn)!;
      const args = a.args.map((x) => walk(x, src, env, imp));
      if (args.every((x) => x.c)) {
        return { c: true, n: chk(fn.fold(args.map((x) => (x as { c: true; n: number }).n)), 0) };
      }
      // FREE-FUNCTION FORM, ALWAYS — measured: a.mix(b,c), a.smoothstep(b,c)
      // and a.step(b) all displace the receiver out of slot 1.
      imp(fn.tsl);
      const parts = args.map((x) => (x.c ? num(x.n) : x.s));
      return { c: false, s: `${fn.tsl}(${parts.join(', ')})` };
    }

    case 'bin': {
      const L = walk(a.a, src, env, imp);
      const R = walk(a.b, src, env, imp);
      if (L.c && R.c) return { c: true, n: chk(FOLD[a.op](L.n, R.n), 0) };

      switch (a.op) {
        case '+':
        case '*': {
          // Commutative: keep the node as the receiver so the chain reads like
          // the built-in one (`v.sub(-2).mul(0.25)`).
          const method = a.op === '+' ? 'add' : 'mul';
          if (!L.c) return { c: false, s: `${L.s}.${method}(${R.c ? num(R.n) : R.s})` };
          return { c: false, s: `${(R as { c: false; s: string }).s}.${method}(${num(L.n)})` };
        }
        case '-':
          if (!L.c) return { c: false, s: `${L.s}.sub(${R.c ? num(R.n) : R.s})` };
          imp('sub');
          return { c: false, s: `sub(${num(L.n)}, ${(R as { c: false; s: string }).s})` };
        case '/':
          if (R.c) {
            // Division by a compile-time constant becomes multiplication by the
            // reciprocal — `div` is 4× `mul` in complexity.json, the same choice
            // the built-in affine branch already documents. chk() rejects a
            // divide by zero rather than letting num() print it as 0 and
            // silently change the meaning.
            const inv = chk(1 / R.n, 0);
            return L.c
              ? { c: true, n: chk(L.n * inv, 0) }
              : { c: false, s: `${L.s}.mul(${num(inv)})` };
          }
          if (!L.c) return { c: false, s: `${L.s}.div(${R.s})` };
          imp('div');
          return { c: false, s: `div(${num(L.n)}, ${R.s})` };
        case '^':
          if (!L.c) return { c: false, s: `${L.s}.pow(${R.c ? num(R.n) : R.s})` };
          imp('pow');
          return { c: false, s: `pow(${num(L.n)}, ${(R as { c: false; s: string }).s})` };
      }
    }
  }
}

/**
 * Turn a parsed formula into a TSL expression.
 *
 * `src` is the upstream scalar reference graphToCode already built
 * (`scalarRefOf`) — `data1_col1`, `uv().x`, … It is the ONLY string from outside
 * this module that reaches the output, and it was produced by the emitter, not
 * by the user.
 *
 * `addImport` is graphToCode's own, already bound to the `three/tsl` module.
 */
export function emitFormula(
  ast: FormulaAst,
  src: string,
  env: FormulaEnv,
  addImport: (name: string) => void,
): EmitResult {
  // Imports are BUFFERED and flushed only on success. `addImport` is
  // graphToCode's LIVE registry, and a formula rejected mid-walk — a
  // non-finite fold AFTER a function subexpression already registered its
  // name — would otherwise leave the refused formula's imports in a module
  // whose body is the fallback chain: phantom imports whose presence depends
  // on which subtree of a REJECTED formula happened to walk first.
  const pending = new Set<string>();
  try {
    const v = walk(ast, src, env, (n) => pending.add(n));
    let code: string;
    if (v.c) {
      // A formula with no `v` in it folds to a constant. It still has to be a
      // TSL NODE: the caller appends `.clamp(0.0, 1.0)` when the clamp checkbox
      // is on, and a bare `0.5` has no methods.
      pending.add('float');
      code = `float(${num(v.n)})`;
    } else {
      code = v.s;
    }
    for (const n of pending) addImport(n);
    return { ok: true, code };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, err: e.e };
    return { ok: false, err: { code: 'syntax', at: 0 } };
  }
}

/**
 * The formula each plan kind stands for, in the language's own syntax and in
 * SYMBOLIC form (`lo`/`hi`, not the baked numbers) — so a formula survives the
 * data changing and stays comparable to the default text.
 *
 * These are EQUIVALENT to the built-in chains, not byte-identical to them: the
 * built-in text hand-types `.add(1.0)` while computed values go through `num()`,
 * and no single formatter reproduces both. Their numeric agreement is pinned by
 * test instead — that catches the failure that actually matters (the box showing
 * a formula that is not what the shader computes) without pinning bytes that are
 * allowed to differ.
 */
export function defaultFormulaText(kind: NormalizePlan['kind']): string {
  switch (kind) {
    case 'affine':
      return '(v - lo) / (hi - lo)';
    case 'log':
      return '(log2(max(v, lo)) - log2(lo)) / (log2(hi) - log2(lo))';
    case 'symlog':
      return 'sign(v) * log2(1 + abs(v) / thresh) / log2(1 + m / thresh) * 0.5 + 0.5';
  }
}

/**
 * Evaluate a parsed formula on the CPU at a given `v`. Used by the settings menu
 * to sanity-check a formula, and by the tests that pin the default texts against
 * the built-in chains. Returns null when the result is not finite.
 */
export function evalFormula(ast: FormulaAst, v: number, env: FormulaEnv): number | null {
  const go = (a: FormulaAst): number => {
    switch (a.k) {
      case 'num':
        return a.v;
      case 'var':
        return a.id === 'v' ? v : env[a.id];
      case 'neg':
        return -go(a.a);
      case 'call':
        return FUNCS.get(a.fn)!.fold(a.args.map(go));
      case 'bin':
        return FOLD[a.op](go(a.a), go(a.b));
    }
  };
  try {
    const out = go(ast);
    return Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Bound the stored formula on graphs entering the store from outside the menu.
 *
 * SCOPE: type and SIZE only — deliberately NOT grammar. The grammar gate lives
 * at the emitter, which is the only place the string could become code, so
 * coverage there is a property of the CODE PATH rather than of a maintained list
 * of call sites. This function exists for the reason `sanitizeDataNodes` exists:
 * an unbounded string is structuredClone'd into ~50 history snapshots,
 * JSON.stringify'd into every 300 ms autosave, and re-embedded into every
 * export — a denial of service on the editor that the emitter's rejection does
 * nothing about.
 *
 * Removing this function must not change one byte of any generated module; that
 * is asserted directly, so the two gates can never be confused for each other.
 *
 * Returns the SAME array when nothing changed — the autosave subscriber and
 * `selectionOnlyGraphChange` compare by reference.
 */
export function sanitizeDataRangeNodes(nodes: AppNode[]): AppNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    if ((n.data as { registryType?: string } | undefined)?.registryType !== 'dataRange') return n;
    const values = getNodeValues(n as Parameters<typeof getNodeValues>[0]);
    // Plain property access, NEVER `'formula' in values` — `getNodeValues` is
    // `data.values ?? {}`, which guards nullish and nothing else, so a tampered
    // `values: 5` reaches here as a primitive and `in` THROWS on it. That throw
    // lands inside `loadGraph`'s outer catch, which returns null and silently
    // discards the user's ENTIRE saved graph on boot (the autosave then
    // overwrites it, so it is destroyed rather than skipped); on the import path
    // it escapes after pushHistory + setShaderName have already run, which is
    // the mid-apply failure `extractProjectState`'s shape gate exists to
    // prevent. `sanitizeDataNodes` gets this right and is the shape to copy.
    const f = (values as { formula?: unknown }).formula;
    if (f === undefined) return n;
    if (typeof f === 'string' && f.length <= MAX_FORMULA_CHARS) return n;
    changed = true;
    const next = { ...values };
    delete next.formula;
    return { ...n, data: { ...n.data, values: next } } as AppNode;
  });
  return changed ? out : nodes;
}
