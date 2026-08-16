import { describe, it, expect } from 'vitest';
import { parseExpression } from '@babel/parser';
import {
  parseFormula,
  emitFormula,
  formulaEnv,
  evalFormula,
  defaultFormulaText,
  sanitizeDataRangeNodes,
  MAX_FORMULA_CHARS,
  FORMULA_TSL_SYMBOLS,
  type FormulaErrorCode,
  type FormulaAst,
  type VarId,
} from './dataRangeFormula';
import { planNormalize, columnStats, NORMALIZE_MODES, type NormalizePlan } from './dataViz';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

/**
 * The Data Range formula language.
 *
 * The headline test here is "emission closure" (see below): the user's string
 * must contribute ZERO characters to the emitted module. Everything else — the
 * rejection table, the budgets, the homoglyph cases — exists to show that the
 * rejection paths all land on the same fallback rather than on a broken shader.
 */

const ENV = formulaEnv({ kind: 'affine', lo: -2, hi: 4 }, null, { lo: 0, hi: 1 });

/** Parse-and-emit in one step, with imports collected. */
function emit(src: string, ref = 'v') {
  const imports: string[] = [];
  const p = parseFormula(src);
  if (!p.ok) return { ok: false as const, err: p.err, imports };
  const e = emitFormula(p.ast, ref, ENV, (n) => imports.push(n));
  return e.ok
    ? { ok: true as const, code: e.code, imports }
    : { ok: false as const, err: e.err, imports };
}

/** The error code a source is rejected with, or null when it is accepted. */
function reject(src: unknown): FormulaErrorCode | null {
  const p = parseFormula(src);
  if (!p.ok) return p.err.code;
  const e = emitFormula(p.ast, 'v', ENV, () => {});
  return e.ok ? null : e.err.code;
}

describe('dataRangeFormula: grammar', () => {
  it('parses the canonical default of every plan kind', () => {
    for (const kind of ['affine', 'log', 'symlog'] as const) {
      const p = parseFormula(defaultFormulaText(kind));
      expect(p.ok, kind).toBe(true);
    }
  });

  it('binds - and + left-associatively', () => {
    // 1-2-3 is (1-2)-3 = -4, not 1-(2-3) = 2.
    expect(evalFormula((parseFormula('1-2-3') as { ast: FormulaAst }).ast, 0, ENV)).toBe(-4);
  });

  it('binds ^ right-associatively and looser than unary minus', () => {
    const ev = (s: string) => evalFormula((parseFormula(s) as { ast: FormulaAst }).ast, 0, ENV);
    // 2^3^2 = 2^(3^2) = 512, not (2^3)^2 = 64.
    expect(ev('2^3^2')).toBe(512);
    // -2^2 = -(2^2) = -4 (mathematical convention), not (-2)^2 = 4.
    expect(ev('-2^2')).toBe(-4);
    // A negative exponent must parse at all.
    expect(ev('2^-3')).toBeCloseTo(0.125, 12);
  });

  it('gives * and / precedence over + and -', () => {
    expect(evalFormula((parseFormula('1+2*3') as { ast: FormulaAst }).ast, 0, ENV)).toBe(7);
  });

  it('reads min/max as a VALUE bare and as a FUNCTION before a paren', () => {
    // The two never collide: FUNCS is consulted only when '(' follows.
    expect(reject('min')).toBeNull();
    expect(reject('min(1, 2)')).toBeNull();
    // ...and a variable used as a function is reported distinctly, so the menu
    // can say "that is a value, not a function" instead of "unknown name".
    expect(reject('lo(1)')).toBe('not-a-function');
  });

  it('accepts `value` as an alias for `v` and `count` for `n`', () => {
    expect(emit('value * 2').code).toBe('v.mul(2)');
    expect(reject('count')).toBeNull();
  });
});

describe('dataRangeFormula: rejection table', () => {
  // Each row is (input, expected code). Every one of these falls back to the
  // built-in chain, so the shader still compiles in every case.
  const CASES: [unknown, FormulaErrorCode][] = [
    // --- not a string: NEVER String()-coerced. `String(['(v-lo)'])` is a VALID
    //     formula, which is exactly why coercion is forbidden here.
    [undefined, 'absent'],
    [null, 'absent'],
    [5, 'absent'],
    [true, 'absent'],
    [['(v-lo)'], 'absent'],
    [{}, 'absent'],
    [NaN, 'absent'],
    // --- blank
    ['', 'absent'],
    ['   ', 'absent'],
    // --- budgets
    ['v+'.repeat(400) + 'v', 'too-long'],
    ['('.repeat(500) + 'v' + ')'.repeat(500), 'too-long'],
    // 40 nested parens: inside the char cap, killed by MAX_DEPTH.
    ['('.repeat(40) + 'v' + ')'.repeat(40), 'too-complex'],
    // Unary minuses do NOT pass through parseExpr — the depth counter has to be
    // in every recursive entry point, not just one.
    ['-'.repeat(40) + 'v', 'too-complex'],
    // --- hostile identifiers
    ['zzz', 'unknown-name'],
    ['window', 'unknown-name'],
    ['globalThis', 'unknown-name'],
    ['eval', 'unknown-name'],
    ['fetch', 'unknown-name'],
    // Map-not-Record: a bare object would resolve these through the prototype.
    ['constructor', 'unknown-name'],
    ['__proto__', 'unknown-name'],
    ['toString', 'unknown-name'],
    ['valueOf', 'unknown-name'],
    ['hasOwnProperty', 'unknown-name'],
    // --- no method syntax exists, so '.' after a name is a scan error
    ['v.mul(2)', 'bad-char'],
    ['v.abs()', 'bad-char'],
    ['window.fetch(1)', 'bad-char'],
    // --- injection shapes. Note these die at SCAN time (';', '=' and '[' are
    //     not in any token class) rather than at parse time — a stronger
    //     rejection than a syntax error, and one that cannot depend on parser
    //     state.
    ['0); globalThis.__x=1; float(0', 'bad-char'],
    ['v[0]', 'bad-char'],
    ['x = 1', 'bad-char'],
    ['`${v}`', 'bad-char'],
    ['v; drop', 'bad-char'],
    ['await v', 'unknown-name'],
    // --- homoglyphs. normalize() is never called, so these stay rejected.
    ['аbs(v)', 'bad-char'], // Cyrillic 'а'
    ['ａbs(v)', 'bad-char'], // fullwidth 'ａ'
    ['٥', 'bad-char'], // Arabic-Indic 5 — Number('٥') === 5
    // --- invisible characters are a REJECTION, never a silent skip
    ['v​+1', 'bad-char'], // zero-width space
    ['v +1', 'bad-char'], // NBSP
    ['v +1', 'bad-char'], // line separator
    ['\ud800v', 'bad-char'], // lone surrogate
    // --- numbers
    ['1e999', 'bad-number'],
    // --- arity
    ['min(1)', 'bad-arity'],
    ['clamp(v, 0)', 'bad-arity'],
    ['abs(1, 2)', 'bad-arity'],
    // --- syntax
    ['(v', 'syntax'],
    ['v)', 'syntax'],
    ['*v', 'syntax'],
    ['v +', 'syntax'],
    ['', 'absent'],
    // --- emit-time non-finite: the fold, not the parse, catches these
    ['v / 0', 'non-finite'],
    ['log2(0)', 'non-finite'],
    ['1 / (hi - hi)', 'non-finite'],
  ];

  for (const [input, code] of CASES) {
    it(`rejects ${JSON.stringify(input)?.slice(0, 40) ?? String(input)} as ${code}`, () => {
      expect(reject(input)).toBe(code);
    });
  }

  it('reports an offset and a capped lexeme for scan errors', () => {
    const p = parseFormula('v + аbs(1)');
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.err.at).toBe(4);
      expect((p.err.got ?? '').length).toBeLessThanOrEqual(16);
    }
  });

  it('never lets a rejected formula throw', () => {
    for (const [input] of CASES) expect(() => reject(input)).not.toThrow();
  });
});

describe('dataRangeFormula: emission closure', () => {
  /**
   * THE security property. Every character the emitter writes must come from
   * its own tables — the user's string contributes none.
   *
   * Mechanically: Babel-parse the emitted expression and assert that every
   * Identifier name and every non-computed member property is drawn from the
   * known alphabet. A hostile substring surviving into the output would show up
   * here as an identifier nobody declared.
   */
  const ALLOWED = new Set([
    ...FORMULA_TSL_SYMBOLS,
    // The chained operator methods the emitter can write.
    'add',
    'sub',
    'mul',
    'div',
    'pow',
    'negate',
    // The upstream reference we pass in as `src`.
    'v',
  ]);

  const VALID = [
    '(v - lo) / (hi - lo)',
    '(log2(max(v, lo)) - log2(lo)) / (log2(hi) - log2(lo))',
    'sign(v) * log2(1 + abs(v) / thresh) / log2(1 + m / thresh) * 0.5 + 0.5',
    'smoothstep(lo, hi, v)',
    'mix(0, 1, v)',
    'clamp(v, lo, hi)',
    'step(mean, v)',
    'v ^ 2',
    '2 ^ v',
    '-v',
    '1 - v',
    'v * 2 + 1',
    '1 / v',
    'sqrt(abs(v))',
    'saturate((v - p2) / (p98 - p2))',
    'fract(v * n)',
    'atan(v) / 3.14159',
    'exp2(v) - 1',
    'pow(v, 0.4545)',
    'min(max(v, lo), hi)',
  ];

  const HOSTILE = CASES_HOSTILE();
  function CASES_HOSTILE(): string[] {
    return [
      '0); globalThis.__x=1; float(0',
      'v.mul(fetch("http://evil"))',
      'constructor',
      '__proto__',
      'eval("x")',
      '`${document.cookie}`',
      'v[0]',
      'window.location="http://evil"',
      'аbs(v)',
      'v​+1',
      '1e999',
      'v / 0',
      "'; DROP TABLE --",
      'v + (()=>{})()',
      'new Function("x")',
      'import("evil")',
      'v, alert(1)',
      'v && alert(1)',
      'v ? 1 : 2',
      'require("fs")',
    ];
  }

  // A strictly positive domain, so the log-family defaults in VALID actually
  // emit: log2(lo) with lo < 0 is NaN and is CORRECTLY rejected as non-finite,
  // which is a property of the data, not of the grammar.
  const POS_ENV = formulaEnv({ kind: 'log', lo: 0.5, hi: 10 }, null, { lo: 0.5, hi: 10 });

  const emitPos = (src: string) => {
    const imports: string[] = [];
    const p = parseFormula(src);
    if (!p.ok) return { ok: false as const, imports };
    const e = emitFormula(p.ast, 'v', POS_ENV, (n) => imports.push(n));
    return e.ok ? { ok: true as const, code: e.code, imports } : { ok: false as const, imports };
  };

  it('emits only known identifiers for every valid formula', () => {
    for (const src of VALID) {
      const r = emitPos(src);
      expect(r.ok, src).toBe(true);
      if (!r.ok) continue;
      const ast = parseExpression(r.code);
      const seen: string[] = [];
      walkIdentifiers(ast as unknown as Record<string, unknown>, seen);
      for (const name of seen) {
        expect(ALLOWED.has(name), `${src} → ${r.code} leaked identifier "${name}"`).toBe(true);
      }
    }
  });

  it('emits nothing at all for every hostile formula', () => {
    for (const src of HOSTILE) {
      const r = emit(src);
      expect(r.ok, `${src} must not emit`).toBe(false);
    }
  });

  it('only ever imports symbols that exist in its own table', () => {
    for (const src of VALID) {
      const r = emitPos(src);
      if (!r.ok) continue;
      for (const name of r.imports) {
        expect(FORMULA_TSL_SYMBOLS, `${src} imported ${name}`).toContain(name);
      }
    }
  });

  it('folds a constant-only formula into a float() node', () => {
    // It must still be a NODE — the caller appends `.clamp(0.0, 1.0)`, and a
    // bare `0.5` has no methods.
    const r = emit('0.25 + 0.25');
    expect(r.ok && r.code).toBe('float(0.5)');
    expect(r.ok && r.imports).toContain('float');
  });

  it('never emits a chained form of a receiver-displacing function', () => {
    // Measured against the shipped three/tsl: a.mix(b,c), a.smoothstep(b,c) and
    // a.step(b) ALL move the receiver out of slot 1. The emitter therefore uses
    // the free-function form for every named function — this pins that rule so
    // a "tidy it into a chain" refactor fails loudly.
    for (const src of ['mix(0, 1, v)', 'smoothstep(lo, hi, v)', 'step(mean, v)']) {
      const r = emit(src);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.code).not.toMatch(/\.(mix|smoothstep|step)\(/);
        expect(r.code).toMatch(/^(mix|smoothstep|step)\(/);
      }
    }
  });

  it('turns division by a constant into multiplication by the reciprocal', () => {
    // `div` is 4× `mul` in the complexity table for an identical result when the
    // divisor is known at compile time — the same choice the built-in affine
    // branch documents.
    expect(emit('v / 4').code).toBe('v.mul(0.25)');
    // ...but a runtime divisor stays a real division.
    expect(emit('4 / v').code).toBe('div(4, v)');
  });
});

describe('dataRangeFormula: the emitted chain computes what the formula says', () => {
  /**
   * The emitter and `evalFormula` are two implementations of one semantics, so
   * they are a DRIFT PAIR. Every other test here proves the emitter is
   * consistent with itself; this one executes the emitted TSL chain and checks
   * the NUMBER.
   *
   * It is what catches an argument landing in the wrong slot — the `mix` class
   * of bug, where the source looks perfect and the picture is silently wrong.
   * The stub implements each operation directly (never via the module's own
   * FUNCS folds) so a mistake in a fold cannot cancel itself out.
   */
  class N {
    constructor(readonly x: number) {}
    add(o: N | number) { return new N(this.x + num(o)); }
    sub(o: N | number) { return new N(this.x - num(o)); }
    mul(o: N | number) { return new N(this.x * num(o)); }
    div(o: N | number) { return new N(this.x / num(o)); }
    pow(o: N | number) { return new N(Math.pow(this.x, num(o))); }
    negate() { return new N(-this.x); }
  }
  const num = (o: N | number) => (o instanceof N ? o.x : o);
  const un = (f: (n: number) => number) => (a: N | number) => new N(f(num(a)));

  /** Exactly the identifiers `emitFormula` is allowed to write. */
  const SCOPE: Record<string, unknown> = {
    float: (a: number) => new N(a),
    sub: (a: N | number, b: N | number) => new N(num(a) - num(b)),
    div: (a: N | number, b: N | number) => new N(num(a) / num(b)),
    pow: (a: N | number, b: N | number) => new N(Math.pow(num(a), num(b))),
    abs: un(Math.abs),
    sign: un(Math.sign),
    floor: un(Math.floor),
    ceil: un(Math.ceil),
    round: un(Math.round),
    fract: un((x) => x - Math.floor(x)),
    sqrt: un(Math.sqrt),
    exp: un(Math.exp),
    exp2: un((x) => 2 ** x),
    log: un(Math.log),
    log2: un(Math.log2),
    sin: un(Math.sin),
    cos: un(Math.cos),
    tan: un(Math.tan),
    asin: un(Math.asin),
    acos: un(Math.acos),
    atan: un(Math.atan),
    saturate: un((x) => Math.min(1, Math.max(0, x))),
    min: (a: N | number, b: N | number) => new N(Math.min(num(a), num(b))),
    max: (a: N | number, b: N | number) => new N(Math.max(num(a), num(b))),
    step: (e: N | number, x: N | number) => new N(num(x) < num(e) ? 0 : 1),
    clamp: (x: N | number, lo: N | number, hi: N | number) =>
      new N(Math.min(num(hi), Math.max(num(lo), num(x)))),
    mix: (a: N | number, b: N | number, t: N | number) =>
      new N(num(a) + (num(b) - num(a)) * num(t)),
    smoothstep: (e0: N | number, e1: N | number, x: N | number) => {
      const t = Math.min(1, Math.max(0, (num(x) - num(e0)) / (num(e1) - num(e0))));
      return new N(t * t * (3 - 2 * t));
    },
  };

  function runEmitted(code: string, vValue: number): number {
    const scope: Record<string, unknown> = { ...SCOPE, v: new N(vValue) };
    const keys = Object.keys(scope);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function(...keys, `return ${code};`);
    const out = fn(...keys.map((k) => scope[k]));
    return out instanceof N ? out.x : (out as number);
  }

  const ENV_POS = formulaEnv({ kind: 'affine', lo: 0.5, hi: 10 }, null, { lo: 0.5, hi: 10 });

  const FORMULAS = [
    '(v - lo) / (hi - lo)',
    'v - 1',
    '1 - v',
    'v / 4',
    '4 / v',
    'v * 2 + 1',
    '1 + v * 2',
    '2 - v * 3',
    '-v',
    '-v + 1',
    'v ^ 2',
    '2 ^ v',
    '1 - 2 - v',
    'v / 2 / 4',
    'abs(v - 3)',
    'min(v, 2)',
    'max(2, v)',
    'clamp(v, 1, 3)',
    'mix(10, 20, v)',
    'smoothstep(0, 4, v)',
    'step(2, v)',
    'sqrt(abs(v))',
    'log2(max(v, lo))',
    'sign(v) * 2',
    'saturate(v / 8)',
    '(log2(max(v, lo)) - log2(lo)) / (log2(hi) - log2(lo))',
  ];

  it('agrees with evalFormula at every sample v', () => {
    const SAMPLES = [-3, -1, -0.25, 0, 0.5, 1, 2, 3.5, 8];
    for (const src of FORMULAS) {
      const p = parseFormula(src);
      expect(p.ok, src).toBe(true);
      if (!p.ok) continue;
      for (const vv of SAMPLES) {
        const e = emitFormula(p.ast, 'v', ENV_POS, () => {});
        expect(e.ok, `${src} @ v=${vv}`).toBe(true);
        if (!e.ok) continue;
        const emittedValue = runEmitted(e.code, vv);
        const expected = evalFormula(p.ast, vv, ENV_POS);
        if (expected === null || !Number.isFinite(emittedValue)) continue;
        expect(Math.abs(emittedValue - expected), `${src} @ v=${vv} → ${e.code}`).toBeLessThan(
          1e-9,
        );
      }
    }
  });

  it('catches a receiver landing in the wrong slot', () => {
    // Sanity-check the harness itself: if the emitter chained smoothstep (which
    // would put v in the FIRST slot instead of the third), the number changes.
    // This asserts the harness can tell those two apart, so the test above is
    // not vacuous.
    const good = runEmitted('smoothstep(0, 4, v)', 1);
    const bad = runEmitted('smoothstep(4, v, 0)', 1);
    expect(good).not.toBe(bad);
  });
});

/** Collect every Identifier name and non-computed member property in a Babel AST. */
function walkIdentifiers(node: Record<string, unknown> | null, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const type = node.type as string | undefined;
  if (type === 'Identifier') out.push(node.name as string);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    if (Array.isArray(value)) {
      for (const v of value) walkIdentifiers(v as Record<string, unknown>, out);
    } else if (value && typeof value === 'object') {
      walkIdentifiers(value as Record<string, unknown>, out);
    }
  }
}

describe('dataRangeFormula: formulaEnv', () => {
  const ALL_VARS: VarId[] = [
    'lo',
    'hi',
    'thresh',
    'm',
    'dmin',
    'dmax',
    'mean',
    'sd',
    'p2',
    'p98',
    'n',
  ];

  it('binds every variable finitely for every mode, with and without data', () => {
    // TOTALITY. Without it a formula would have an "unbound but syntactically
    // valid" state, which is the class of bug that produces a blank preview
    // with no error message anywhere.
    const withStats = columnStats([-2, -1, 0, 1, 4]);
    const flat = columnStats([3, 3, 3]);
    const manuals = [
      { lo: 0, hi: 1 },
      { lo: 5, hi: 5 },
      { lo: 1, hi: -1 },
      { lo: NaN, hi: Infinity },
    ];
    for (const mode of NORMALIZE_MODES) {
      for (const stats of [withStats, flat, null]) {
        for (const manual of manuals) {
          const env = formulaEnv(planNormalize(mode, stats, manual), stats, manual);
          for (const id of ALL_VARS) {
            expect(Number.isFinite(env[id]), `${mode}/${id}`).toBe(true);
          }
        }
      }
    }
  });

  it('gives a symlog plan an lo/hi vocabulary and an affine plan a thresh/m one', () => {
    const sym = formulaEnv({ kind: 'symlog', thresh: 0.004, m: 4 }, null, { lo: 0, hi: 1 });
    expect(sym.lo).toBe(-4);
    expect(sym.hi).toBe(4);
    const aff = formulaEnv({ kind: 'affine', lo: -2, hi: 4 }, null, { lo: 0, hi: 1 });
    expect(Number.isFinite(aff.thresh)).toBe(true);
    expect(aff.m).toBe(4);
  });
});

describe('dataRangeFormula: default text matches the built-in chains', () => {
  /**
   * The box must show a formula that IS what the shader computes. The two paths
   * are deliberately separate (the built-in text hand-types `.add(1.0)` while
   * computed values go through num(), so no single formatter reproduces both),
   * so their agreement is pinned NUMERICALLY rather than textually.
   */
  const SAMPLES = [-10, -4, -2, -1, -0.5, 0, 0.5, 1, 2, 4, 10];

  /** A JS reimplementation of exactly what graphToCode's built-in branch emits. */
  function builtin(plan: NormalizePlan, v: number): number {
    if (plan.kind === 'affine') return (v - plan.lo) * (1 / (plan.hi - plan.lo));
    if (plan.kind === 'log') {
      const l0 = Math.log2(plan.lo);
      return (Math.log2(Math.max(v, plan.lo)) - l0) * (1 / (Math.log2(plan.hi) - l0));
    }
    const invT = 1 / plan.thresh;
    const invY = 1 / Math.log2(1 + plan.m / plan.thresh);
    return Math.sign(v) * (Math.log2(Math.abs(v) * invT + 1) * invY) * 0.5 + 0.5;
  }

  it('agrees to 1e-12 for every mode, including the degenerate ones', () => {
    const stats = columnStats([-2, -1, 0, 1, 4]);
    const flat = columnStats([3, 3, 3]);
    const zeroCrossing = columnStats([0, 1, 2]);
    for (const mode of NORMALIZE_MODES) {
      for (const s of [stats, flat, zeroCrossing, null]) {
        const manual = { lo: 0, hi: 1 };
        const plan = planNormalize(mode, s, manual);
        const env = formulaEnv(plan, s, manual);
        const p = parseFormula(defaultFormulaText(plan.kind));
        expect(p.ok, plan.kind).toBe(true);
        if (!p.ok) continue;
        for (const v of SAMPLES) {
          const a = evalFormula(p.ast, v, env);
          const b = builtin(plan, v);
          if (!Number.isFinite(b)) continue;
          expect(a, `${mode}/${plan.kind}/v=${v}`).not.toBeNull();
          expect(Math.abs((a as number) - b), `${mode}/${plan.kind}/v=${v}`).toBeLessThan(1e-12);
        }
      }
    }
  });
});

describe('dataRangeFormula: sanitizeDataRangeNodes', () => {
  const node = (values: Record<string, unknown>) =>
    makeNode('n1', 'dataRange', values as Record<string, string | number>) as AppNode;

  it('returns the SAME array when nothing needed changing', () => {
    // The autosave subscriber and selectionOnlyGraphChange compare by
    // reference, so a fresh array on every load would defeat both.
    const nodes = [node({ mode: 'minmax', formula: 'v * 2' })];
    expect(sanitizeDataRangeNodes(nodes)).toBe(nodes);
  });

  it('leaves a node with no formula key untouched', () => {
    const nodes = [node({ mode: 'log' })];
    expect(sanitizeDataRangeNodes(nodes)).toBe(nodes);
  });

  it('drops an over-length formula', () => {
    const nodes = [node({ formula: 'v'.repeat(MAX_FORMULA_CHARS + 1) })];
    const out = sanitizeDataRangeNodes(nodes);
    expect(out).not.toBe(nodes);
    expect('formula' in (out[0].data as { values: object }).values).toBe(false);
  });

  it('drops a non-string formula', () => {
    for (const junk of [5, true, null, {}, ['v']]) {
      const nodes = [node({ formula: junk })];
      const out = sanitizeDataRangeNodes(nodes);
      expect('formula' in (out[0].data as { values: object }).values).toBe(false);
    }
  });

  it('survives a primitive `values` instead of throwing', () => {
    // getNodeValues only guards nullish, so a tampered `values: 5` arrives as a
    // primitive. `'formula' in 5` throws — and that throw is swallowed by
    // loadGraph's outer catch, which discards the user's WHOLE saved graph, and
    // escapes applyProjectToStore after pushHistory/setShaderName have run.
    for (const junk of [5, 'x', true, 0, '', false]) {
      const nodes = [
        { id: 'n1', type: 'shader', position: { x: 0, y: 0 }, data: { registryType: 'dataRange', values: junk } },
      ] as unknown as AppNode[];
      expect(() => sanitizeDataRangeNodes(nodes), String(junk)).not.toThrow();
      expect(sanitizeDataRangeNodes(nodes)).toBe(nodes);
    }
  });

  it('leaves non-dataRange nodes alone', () => {
    const nodes = [makeNode('m1', 'multiply', { formula: 'x'.repeat(9999) }) as AppNode];
    expect(sanitizeDataRangeNodes(nodes)).toBe(nodes);
  });
});
