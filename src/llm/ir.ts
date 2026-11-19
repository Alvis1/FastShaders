/**
 * The generator's internal form: a flat list of steps whose references are
 * step INDICES, never names. The model's text is walked into this form
 * (dialect.ts) and canonical TSL is written back out of it (emit.ts), so the
 * only things that cross from a reply into the app are checked identifiers
 * and finite numbers — the Data Range formula's parse-then-re-emit rule.
 */

/** One component of a vector, as the parser reads a one-letter swizzle. */
export type Component = 'x' | 'y' | 'z' | 'w';

/** A value passed to a step. */
export type Arg =
  /** An earlier step's result. */
  | { k: 'ref'; id: number }
  /** A finite number. */
  | { k: 'num'; v: number }
  /** A bare input (`positionWorld`, `time`); the parser makes ONE node per
   *  distinct name used this way. */
  | { k: 'global'; name: string }
  /** One component of a step or input (`u.y`). */
  | { k: 'swz'; of: Arg; c: Component };

export type StepOp =
  | { op: 'uniform'; value: number }
  | { op: 'uniformColor'; hex: number }
  | { op: 'color'; hex: number }
  | { op: 'float'; v: number }
  | { op: 'int'; v: number }
  /** `const p = positionGeometry;` — its OWN node (the parser does not merge
   *  aliases), which is what keeps the built-ins' graphs unchanged. */
  | { op: 'alias'; global: string }
  /** `uv()`, or the tiled `mul(uv(), vec2(a, b))` the UV node stores. */
  | { op: 'uv'; tiling: [number, number] | null }
  /** `time.mul(speed)` — Time's speed lives on the node. */
  | { op: 'time'; speed: Arg }
  /** A noise call: position, scale (`pos.mul(scale)`), and the 0…1 remap. */
  | { op: 'noise'; fn: string; pos: Arg; scale: Arg; unsigned: boolean }
  /** Any other catalogue function, its arguments in port order. */
  | { op: 'call'; fn: string; args: Arg[] };

export interface Step {
  /** The const's name (uniform names are user-visible; see names.ts). */
  name: string;
  /** 1-based line in the model's program, for problem lines; 0 when made up. */
  line: number;
  op: StepOp;
  /** True for a uniform the walker made up a name for (an inline uniform). */
  madeUpName?: boolean;
}

export interface Program {
  steps: Step[];
  ret: Arg;
  retLine: number;
}

export const isUniformStep = (s: Step): boolean => s.op.op === 'uniform' || s.op.op === 'uniformColor';

/** Steps an Arg reads, directly. */
export function argRefs(a: Arg, out: number[] = []): number[] {
  if (a.k === 'ref') out.push(a.id);
  else if (a.k === 'swz') argRefs(a.of, out);
  return out;
}

export function stepRefs(op: StepOp): number[] {
  switch (op.op) {
    case 'time': return argRefs(op.speed);
    case 'noise': return [...argRefs(op.pos), ...argRefs(op.scale)];
    case 'call': return op.args.flatMap((a) => argRefs(a));
    default: return [];
  }
}

/** Number as the hash and the emitter write it: `-0` is `0`. */
export function fmtNum(v: number): string {
  return Object.is(v, -0) ? '0' : String(v);
}

/** Operations whose operands may be reordered without changing the value. */
const COMMUTATIVE = new Set(['add', 'mul']);

/**
 * A key for WHAT A VALUE COMPUTES, independent of names and of the several
 * graph shapes that compute the same thing. The gate compares the key of the
 * model's program with the key of graphToCode's re-emission of the parsed
 * graph: any form the parser dropped or misread changes the key, while the
 * forms it legitimately normalises do not — `time.mul(3)` (Time's speed) and
 * `mul(time, 3)`, `noise(p.mul(k))` (the noise's scale) and `noise(mul(p, k))`,
 * the unsigned remap and `add(mul(noise, 0.5), 0.5)`, `uv()` tiling and its
 * product, an alias and the bare input it names.
 *
 * Uniforms key on their NAME and value: a renamed or re-valued uniform is a
 * different program as far as the user is concerned.
 *
 * Keys are INTERNED (`#<n>`) in a table the two programs share, so a key stays
 * short however much the steps share: written out in full, thirty steps that
 * each square the previous one would spell a billion characters.
 */
export type KeyTable = Map<string, string>;

export function semanticKeys(p: Program, table: KeyTable): { ofArg: (a: Arg) => string; ofStep: (i: number) => string } {
  const intern = (structural: string): string => {
    let k = table.get(structural);
    if (k === undefined) { k = `#${table.size}`; table.set(structural, k); }
    return k;
  };
  const memo = new Map<number, string>();
  const ofArg = (a: Arg): string => {
    switch (a.k) {
      case 'num': return fmtNum(a.v);
      case 'global': return `$${a.name}`;
      case 'ref': return ofStep(a.id);
      case 'swz': return intern(`${ofArg(a.of)}.${a.c}`);
    }
  };
  const call = (fn: string, args: string[]): string =>
    intern(`${fn}(${(COMMUTATIVE.has(fn) ? [...args].sort() : args).join(',')})`);
  const ofStep = (i: number): string => {
    const hit = memo.get(i);
    if (hit !== undefined) return hit;
    const op = p.steps[i]?.op;
    let key: string;
    if (!op) key = '?';
    else switch (op.op) {
      case 'uniform': key = intern(`U[${p.steps[i].name}=${fmtNum(op.value)}]`); break;
      case 'uniformColor': key = intern(`UC[${p.steps[i].name}=${op.hex}]`); break;
      case 'color': key = intern(`color(${op.hex})`); break;
      case 'float': key = intern(`float(${fmtNum(op.v)})`); break;
      case 'int': key = intern(`int(${fmtNum(op.v)})`); break;
      case 'alias': key = `$${op.global}`; break;
      case 'uv': {
        const t = op.tiling;
        key = t && !(t[0] === 1 && t[1] === 1) ? call('mul', ['uv()', call('vec2', [fmtNum(t[0]), fmtNum(t[1])])]) : 'uv()';
        break;
      }
      case 'time': {
        const s = ofArg(op.speed);
        key = s === '1' ? '$time' : call('mul', ['$time', s]);
        break;
      }
      case 'noise': {
        const scale = ofArg(op.scale);
        const pos = ofArg(op.pos);
        key = call(op.fn, [scale === '1' ? pos : call('mul', [pos, scale])]);
        if (op.unsigned) key = call('add', [call('mul', [key, '0.5']), '0.5']);
        break;
      }
      case 'call': key = call(op.fn, op.args.map(ofArg)); break;
    }
    memo.set(i, key);
    return key;
  };
  return { ofArg, ofStep };
}
