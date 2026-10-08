import { unitToken, hexToken, splitRecords, formatUnit, POINT_LIST_MAX_RECORDS } from './pointListCodec';
import { halfTable, fetchHalf, rangeHalf, FS_LUT_SIZE } from './lutTable';
import { srgbToLinear01, linearToSrgb01 } from './colorUtils';

/**
 * Blender's Color Ramp (ShaderNodeValToRGB) on the TRUSTED side: the ONE
 * reader of a Color Ramp node's `values.stops` / `values.interp`, the CPU twin
 * of `fsColorRamp` (engine/lutHelperText.ts, which bakes the same table inside
 * the preview, the export and podest), and the editor's pure stop operations.
 *
 * Storage: `values.stops` is the point-list grammar of utils/pointListCodec.ts
 * — records `POS HEX ALPHA`, 1..32 of them, positions and alpha in [0,1], the
 * hex sRGB-encoded — and `values.interp` one of RAMP_INTERPS. ABSENT means the
 * default black→white Linear ramp, so a fresh node, Reset and every byte-
 * stability snapshot read the same. The stop colours are converted to LINEAR
 * light before they blend (Blender stores them linear; the hex is how a person
 * names a colour), which is what keeps a ramp through mid-grey from going muddy.
 *
 * Every consumer — codegen, the CPU evaluator, the card strip and the editor —
 * reads the ramp the GPU bakes: `stops` is always the parse of the CANONICAL
 * string (positions rounded to 1e-4), never the raw stored text, and card and
 * edge values are fetched from the same HALF-float table the shader samples
 * (utils/lutTable.ts).
 */

export type RampInterp = 'linear' | 'constant' | 'ease' | 'bspline' | 'cardinal';
/** Display order (Blender's menu order). */
export const RAMP_INTERPS: readonly RampInterp[] = Object.freeze(['linear', 'constant', 'ease', 'bspline', 'cardinal'] as const);
const RAMP_INTERP_SET: ReadonlySet<string> = new Set(RAMP_INTERPS);
/** Set lookup on the exact string — `'__proto__'`, `'Linear'` and non-strings are not interpolations. */
export function isRampInterp(v: unknown): v is RampInterp {
  return typeof v === 'string' && RAMP_INTERP_SET.has(v);
}

export const DEFAULT_RAMP_STOPS = '0 #000000 1,1 #ffffff 1';
export const RAMP_MAX_STOPS = POINT_LIST_MAX_RECORDS;

export interface RampStop {
  readonly pos: number;
  /** Lowercase sRGB `#rrggbb`. */
  readonly hex: string;
  readonly alpha: number;
}
export interface ColorRamp {
  readonly stops: readonly RampStop[];
  readonly interp: RampInterp;
  readonly canonical: string;
  /** A stored value was present but unreadable — the default stands in, and the code says so. */
  readonly rejected: boolean;
}

/** §A5 grammar: exactly three tokens per record, ALL-OR-NOTHING, stable-sorted by position (a tie keeps its input
 *  order — that is a hard edge). null = unreadable. */
export function parseRampStops(raw: unknown): RampStop[] | null {
  const recs = splitRecords(raw, 1, RAMP_MAX_STOPS);
  if (!recs) return null;
  const out: RampStop[] = [];
  for (const rec of recs) {
    if (rec.length !== 3) return null;
    const pos = unitToken(rec[0]);
    const hex = hexToken(rec[1]);
    const alpha = unitToken(rec[2]);
    if (pos === null || hex === null || alpha === null) return null;
    out.push({ pos, hex, alpha });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

/** THE writer: formatUnit positions/alpha, lowercase hex, records joined by ',' and tokens by ' '. Its output
 *  alphabet is `[0-9.#a-f, ]` whatever the input, so it can never break out of the emitted string literal. */
export function formatRampStops(stops: readonly RampStop[]): string {
  return stops
    .map((s) => `${formatUnit(s.pos)} ${hexToken(s.hex) ?? '#000000'} ${formatUnit(s.alpha)}`)
    .join(',');
}

const freezeStops = (stops: readonly RampStop[]): readonly RampStop[] => Object.freeze(stops.map((s) => Object.freeze({ ...s })));

/** The memo key, built ONLY from strings: `String(v)` or a template literal of `v` throws on `{toString:1}`, a
 *  Symbol or a throwing `Symbol.toPrimitive` — in render, where nothing catches it. */
const part = (v: unknown): string => (typeof v === 'string' ? 's:' + v : 't:' + typeof v);
const MEMO_MAX = 64;
const memo = new Map<string, ColorRamp>();

/** Reads a property of an untrusted `values` without coercing either side. */
function field(values: unknown, key: string): unknown {
  return typeof values === 'object' && values !== null ? (values as Record<string, unknown>)[key] : undefined;
}

/** THE reader (codegen, CPU, card, editor). Total on `unknown`. stops: undefined/'' → default, not rejected;
 *  non-string or unreadable → default + rejected; interp: exact vocabulary else 'linear' (+ rejected when a key
 *  was present and wrong). `stops` is ALWAYS the parse of `canonical` — the ROUNDED stops — so every surface sees
 *  exactly the ramp the GPU bakes from the emitted string. Memoised on a string-only key (bounded). */
export function readColorRamp(values: unknown): ColorRamp {
  const rawStops = field(values, 'stops');
  const rawInterp = field(values, 'interp');
  const key = part(rawStops) + '\u0000' + part(rawInterp);
  const hit = memo.get(key);
  if (hit) return hit;

  let rejected = false;
  let canonical = DEFAULT_RAMP_STOPS;
  if (rawStops !== undefined && rawStops !== '') {
    const parsed = parseRampStops(rawStops);
    if (parsed) canonical = formatRampStops(parsed);
    else rejected = true;
  }
  let interp: RampInterp = 'linear';
  if (rawInterp !== undefined) {
    if (isRampInterp(rawInterp)) interp = rawInterp;
    else rejected = true;
  }
  const ramp: ColorRamp = Object.freeze({
    stops: freezeStops(parseRampStops(canonical) ?? []),
    interp,
    canonical,
    rejected,
  });
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, ramp);
  return ramp;
}

interface LinearStop {
  p: number;
  c: readonly number[];
}

const linearStops = new WeakMap<ColorRamp, readonly LinearStop[]>();
/** The stops in linear light, exactly as fsLut.hex decodes them (parseInt(byte)/255 → srgbToLinear01). */
function linearOf(ramp: ColorRamp): readonly LinearStop[] {
  let list = linearStops.get(ramp);
  if (!list) {
    list = ramp.stops.map((s) => ({
      p: s.pos,
      c: [1, 3, 5].map((o) => srgbToLinear01(parseInt(s.hex.slice(o, o + 2), 16) / 255)).concat(s.alpha),
    }));
    if (list.length === 0) list = [{ p: 0, c: [0, 0, 0, 1] }, { p: 1, c: [1, 1, 1, 1] }];
    linearStops.set(ramp, list);
  }
  return list;
}

/** Blender BKE_colorband_evaluate (colorband.cc) on the LINEAR stops, RGB colour mode — operation for operation
 *  the helper's `ev`, so the Float32 bake below is bit-identical to the one fsColorRamp makes. */
export function evaluateRamp(ramp: ColorRamp, x: number): [number, number, number, number] {
  const list = linearOf(ramp);
  const mode = ramp.interp;
  const cnt = list.length;
  const spline = mode === 'bspline' || mode === 'cardinal';
  const out = (c: readonly number[]): [number, number, number, number] => [c[0], c[1], c[2], c[3]];
  if (cnt === 1) return out(list[0].c);
  if (x <= list[0].p && !spline) return out(list[0].c);
  let at1 = 0;
  while (at1 < cnt && !(list[at1].p > x)) at1++;
  let rt: LinearStop;
  let lf: LinearStop;
  if (at1 === cnt) {
    lf = list[cnt - 1];
    rt = { p: 1, c: lf.c };
  } else if (at1 === 0) {
    rt = list[0];
    lf = { p: 0, c: rt.c };
  } else {
    rt = list[at1];
    lf = list[at1 - 1];
  }
  if (at1 === cnt && !spline) return out(lf.c);
  if (mode === 'constant') return out(lf.c);
  let f = lf.p !== rt.p ? (x - rt.p) / (lf.p - rt.p) : at1 !== cnt ? 0 : 1;
  if (spline) {
    const r0 = at1 >= cnt - 1 ? rt : list[at1 + 1];
    const l3 = at1 < 2 ? lf : list[at1 - 2];
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const t2 = f * f;
    const t3 = t2 * f;
    let w0: number;
    let w1: number;
    let w2: number;
    let w3: number;
    if (mode === 'cardinal') {
      const fc = 0.71;
      w0 = -fc * t3 + 2 * fc * t2 - fc * f;
      w1 = (2 - fc) * t3 + (fc - 3) * t2 + 1;
      w2 = (fc - 2) * t3 + (3 - 2 * fc) * t2 + fc * f;
      w3 = fc * t3 - fc * t2;
    } else {
      w0 = -0.16666666 * t3 + 0.5 * t2 - 0.5 * f + 0.16666666;
      w1 = 0.5 * t3 - t2 + 0.66666666;
      w2 = -0.5 * t3 + 0.5 * t2 + 0.5 * f + 0.16666666;
      w3 = 0.16666666 * t3;
    }
    const o = [0, 1, 2, 3].map((k) => {
      const v = w3 * l3.c[k] + w2 * lf.c[k] + w1 * rt.c[k] + w0 * r0.c[k];
      return v < 0 ? 0 : v > 1 ? 1 : v;
    });
    return out(o);
  }
  if (mode === 'ease') {
    const f2 = f * f;
    f = 3 * f2 - 2 * f2 * f;
  }
  const mf = 1 - f;
  return out([0, 1, 2, 3].map((k) => mf * rt.c[k] + f * lf.c[k]));
}

const halfTables = new WeakMap<ColorRamp, Uint16Array>();
/** 257×4 half floats: evaluateRamp(i/256) through a Float32Array, then toHalfFloat — fsLut.make's bake. Memoised. */
export function rampHalfTable(ramp: ColorRamp): Uint16Array {
  let half = halfTables.get(ramp);
  if (!half) {
    const vals = new Float32Array(FS_LUT_SIZE * 4);
    for (let i = 0; i < FS_LUT_SIZE; i++) vals.set(evaluateRamp(ramp, i / (FS_LUT_SIZE - 1)), i * 4);
    half = halfTable(vals);
    halfTables.set(ramp, half);
  }
  return half;
}

const CHANNELS = [0, 1, 2, 3] as const;

/** What the shader returns for Factor `t`: [r, g, b, a], LINEAR light, from the half table (Nearest for Constant). */
export function rampFetch(ramp: ColorRamp, t: number): [number, number, number, number] {
  const half = rampHalfTable(ramp);
  const nearest = ramp.interp === 'constant';
  const [r, g, b, a] = CHANNELS.map((ch) => fetchHalf(half, ch, t, nearest));
  return [r, g, b, a];
}

/** Exact per-channel range of rampFetch over Factor ∈ [lo, hi] (ClampToEdge beyond [0,1]). */
export function rampRangeOver(ramp: ColorRamp, lo: number, hi: number): { min: number[]; max: number[] } {
  const half = rampHalfTable(ramp);
  const nearest = ramp.interp === 'constant';
  const min: number[] = [];
  const max: number[] = [];
  for (const ch of CHANNELS) {
    const [a, b] = rangeHalf(half, ch, lo, hi, nearest);
    min.push(a);
    max.push(b);
  }
  return { min, max };
}

const byte = (v01: number): number => Math.round(linearToSrgb01(v01) * 255);
const alphaText = (a: number): string => String(Math.round((Number.isFinite(a) ? Math.min(Math.max(a, 0), 1) : 0) * 1000) / 1000);
const rgba = (c: readonly number[]): string => `rgba(${byte(c[0])}, ${byte(c[1])}, ${byte(c[2])}, ${alphaText(c[3])})`;
const pct = (p: number): string => `${Math.round(p * 1e4) / 100}%`;
const RAMP_CSS_SAMPLES = 33;

const cssMemo = new WeakMap<ColorRamp, string>();
/** Card/editor gradient: Constant → hard stops at the stop positions; otherwise 33 samples of evaluateRamp, each
 *  linearToSrgb01 → `rgba()`. Built in sRGB by hand — `in srgb-linear` interpolation is above the browser floor. */
export function rampCss(ramp: ColorRamp): string {
  const hit = cssMemo.get(ramp);
  if (hit) return hit;
  const parts: string[] = [];
  if (ramp.interp === 'constant') {
    const list = linearOf(ramp);
    list.forEach((s, i) => {
      const from = i === 0 ? 0 : s.p;
      const to = i === list.length - 1 ? 1 : list[i + 1].p;
      parts.push(`${rgba(s.c)} ${pct(from)}`, `${rgba(s.c)} ${pct(to)}`);
    });
  } else {
    for (let i = 0; i < RAMP_CSS_SAMPLES; i++) {
      const x = i / (RAMP_CSS_SAMPLES - 1);
      parts.push(`${rgba(evaluateRamp(ramp, x))} ${pct(x)}`);
    }
  }
  const css = `linear-gradient(to right, ${parts.join(', ')})`;
  cssMemo.set(ramp, css);
  return css;
}

/** A LINEAR rgb triple → the sRGB `#rrggbb` a stop stores (linearToSrgb01, 8-bit, lowercase). */
export function linearToHex(rgb: readonly number[]): string {
  return '#' + [0, 1, 2].map((i) => byte(rgb[i] ?? 0).toString(16).padStart(2, '0')).join('');
}

// ─── Editor ops — pure; every output goes through formatRampStops before it reaches the store ───

/** A position as the canonical string will hold it, so an op's returned index survives the round trip. */
const roundUnit = (n: number): number => Number(formatUnit(n));

/** Insert `stop` before the first stop with a GREATER position (after any it ties with). */
function insertSorted(stops: readonly RampStop[], stop: RampStop): { stops: RampStop[]; index: number } {
  const next = [...stops];
  let index = next.findIndex((s) => s.pos > stop.pos);
  if (index < 0) index = next.length;
  next.splice(index, 0, stop);
  return { stops: next, index };
}

/** A new stop at `pos` carrying the ramp's own colour and alpha there, so adding one never changes the picture.
 *  null at the 32-stop cap. */
export function addStopAt(ramp: ColorRamp, pos: number): { stops: RampStop[]; index: number } | null {
  if (ramp.stops.length >= RAMP_MAX_STOPS) return null;
  const p = roundUnit(pos);
  const c = evaluateRamp(ramp, p);
  return insertSorted(ramp.stops, { pos: p, hex: linearToHex(c), alpha: roundUnit(c[3]) });
}

/** The [+] button: midway to the left neighbour (the right one for the first stop; with one stop, towards the far
 *  end of the bar). null at the cap. */
export function insertStopNear(ramp: ColorRamp, sel: number): { stops: RampStop[]; index: number } | null {
  const stops = ramp.stops;
  if (stops.length === 0) return null;
  const i = Math.min(Math.max(Math.trunc(Number.isFinite(sel) ? sel : 0), 0), stops.length - 1);
  const here = stops[i].pos;
  let pos: number;
  if (stops.length === 1) pos = here <= 0.5 ? (here + 1) / 2 : here / 2;
  else if (i === 0) pos = (here + stops[1].pos) / 2;
  else pos = (stops[i - 1].pos + here) / 2;
  return addStopAt(ramp, pos);
}

/** null at one stop (a ramp needs one) or for an index that is not a stop. */
export function removeStop(stops: readonly RampStop[], i: number): RampStop[] | null {
  if (stops.length <= 1 || !Number.isInteger(i) || i < 0 || i >= stops.length) return null;
  return stops.filter((_, k) => k !== i);
}

/** Stops may CROSS while dragged: the moved stop is re-inserted before the first stop with a greater position,
 *  and its new index comes back so the selection follows it. */
export function moveStop(stops: readonly RampStop[], i: number, pos: number): { stops: RampStop[]; index: number } {
  if (!Number.isInteger(i) || i < 0 || i >= stops.length) return { stops: [...stops], index: 0 };
  const moved = { ...stops[i], pos: roundUnit(pos) };
  return insertSorted(stops.filter((_, k) => k !== i), moved);
}

/** Mirror the ramp: pos → 1 − pos, order reversed (so a tie — a hard edge — stays a hard edge, mirrored). */
export function flipStops(stops: readonly RampStop[]): RampStop[] {
  return [...stops].reverse().map((s) => ({ ...s, pos: roundUnit(1 - s.pos) }));
}

/** hexToken-validated; null for an invalid colour or index. */
export function setStopHex(stops: readonly RampStop[], i: number, hex: string): RampStop[] | null {
  const h = typeof hex === 'string' ? hexToken(hex) : null;
  if (h === null || !Number.isInteger(i) || i < 0 || i >= stops.length) return null;
  return stops.map((s, k) => (k === i ? { ...s, hex: h } : s));
}

/** Alpha clamped and rounded as the canonical string holds it; an invalid index returns an unchanged copy. */
export function setStopAlpha(stops: readonly RampStop[], i: number, a: number): RampStop[] {
  return stops.map((s, k) => (k === i ? { ...s, alpha: roundUnit(a) } : s));
}
