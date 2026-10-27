/**
 * Which part of the generated module each node wrote — graphToCode's
 * `nodeSpans`, the code panel's node → code highlight
 * (components/CodeEditor/useNodeCodeHighlight.ts). BOOKKEEPING, never
 * emission: nothing here produces a byte of the module, and graphToCode's
 * text is the same with or without it.
 *
 * graphToCode records what it already knows while it emits — which plan
 * iteration pushed which lines (`PlanMark`), where each custom-sink scope's
 * chain was copied into its Fn, the return line's per-Output columns, the
 * Split reads — and hands the assembled line array here. Attribution is by
 * WHO PUSHED THE LINE, never by scanning the text for a variable name: a name
 * scan cannot tell `float1` from `float10`, a node from a property of the same
 * name, or the march's own `pos` from a node's.
 *
 * Positions are counted in the JOINED module by Monaco's own line rule
 * (`\r\n`, `\r` or `\n`), not by array index: an `unknown` node's verbatim
 * `rawExpression` can hold line breaks of its own, and every line after it
 * would otherwise be off by that many.
 *
 * Pure leaf: types only, so it adds nothing to the boot wave.
 */
import type { CodeSpan } from '@/types';

/** One plan iteration of graphToCode's body loop: the lines it pushed into
 *  `target` (`[from, to)`) and into the module-scope setup (`[setupFrom, setupTo)`). */
export interface PlanMark {
  nodeId: string;
  target: readonly string[];
  from: number;
  to: number;
  setupFrom: number;
  setupTo: number;
}

/** A span as offsets into the joined module, `[from, to)`. */
export interface OffsetSpan {
  from: number;
  to: number;
  kind: CodeSpan['kind'];
  inline: boolean;
}

/** Everything `assembleNodeSpans` needs from one graphToCode pass. Indices
 *  are into `out`, the module's line array before the join. */
export interface SpanAssembly {
  out: readonly string[];
  /** Where `setupLines[0]` landed. */
  setupBase: number;
  /** Where each body array's line 0 landed — `mainLines` once, a custom-sink
   *  scope array once per Fn it was copied into. An array with NO base (a
   *  scope whose Fn was never emitted) gives its marks no span. */
  bases: ReadonlyMap<readonly string[], readonly number[]>;
  marks: readonly PlanMark[];
  /** The driving custom sink's program `[from, to)`, minus the copied chains. */
  sink: { id: string; from: number; to: number; chains: readonly (readonly [number, number])[] } | null;
  discard: { index: number; owner: string } | null;
  /** The return line: owned WHOLE by `whole`, else by column ranges. */
  ret: { index: number; whole: string | null; cols: readonly { nodeId: string; from: number; to: number }[] };
  /** Each Split → consumer wire and the reference it emits. */
  splitReads: readonly { splitId: string; consumerId: string; ref: string }[];
}

/** The start offset of every element of `lines` in `lines.join('\n')`. */
export function joinedOffsets(lines: readonly string[]): number[] {
  const off = new Array<number>(lines.length);
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    off[i] = at;
    at += lines[i].length + 1;
  }
  return off;
}

/**
 * Offset → Monaco position, by Monaco's line rule (`\r\n`, `\r`, `\n` each
 * ONE break). A column never points past its line's end, so an offset inside
 * a `\r\n` pair reads as the end of the line before it.
 */
export function positionIndex(code: string): (offset: number) => { lineNumber: number; column: number } {
  const starts = [0];
  const ends: number[] = [];
  for (const m of code.matchAll(/\r\n|\r|\n/g)) {
    ends.push(m.index);
    starts.push(m.index + m[0].length);
  }
  ends.push(code.length);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { lineNumber: lo + 1, column: Math.min(offset, ends[lo]) - starts[lo] + 1 };
  };
}

const IDENT = /[\w$]/;

/**
 * Every offset in `[from, to)` where `ref` occurs as a whole reference: the
 * character before it is no identifier character and no `.` (so `a.float1`,
 * `_float1` and `float10` are not `float1`), the one after it no identifier
 * character (so `x.x` is not the start of `x.xy`). An empty ref has none.
 */
export function refOccurrences(code: string, ref: string, from: number, to: number): number[] {
  const hits: number[] = [];
  if (ref === '') return hits;
  let at = code.indexOf(ref, from);
  while (at >= 0 && at + ref.length <= to) {
    const before = at > 0 ? code[at - 1] : '';
    const after = code[at + ref.length] ?? '';
    if (!IDENT.test(before) && before !== '.' && !IDENT.test(after)) hits.push(at);
    at = code.indexOf(ref, at + 1);
  }
  return hits;
}

/** Node id → its spans in `code`, sorted by position. */
export function assembleNodeSpans(code: string, a: SpanAssembly): Map<string, CodeSpan[]> {
  const off = joinedOffsets(a.out);
  const endOf = (i: number): number => off[i] + a.out[i].length;
  const byNode = new Map<string, OffsetSpan[]>();
  const add = (id: string, span: OffsetSpan): void => {
    if (span.to <= span.from) return;
    const list = byNode.get(id);
    if (list) list.push(span);
    else byNode.set(id, [span]);
  };
  const lines = (first: number, last: number, kind: CodeSpan['kind']): OffsetSpan =>
    ({ from: off[first], to: endOf(last), kind, inline: false });

  for (const m of a.marks) {
    if (m.to > m.from) for (const b of a.bases.get(m.target) ?? []) add(m.nodeId, lines(b + m.from, b + m.to - 1, 'own'));
    if (m.setupTo > m.setupFrom) add(m.nodeId, lines(a.setupBase + m.setupFrom, a.setupBase + m.setupTo - 1, 'setup'));
  }

  // The sink owns its program minus the chains copied into it — those lines
  // were each pushed by a member node, whose marks above already claim them.
  if (a.sink) {
    const { id, from, to, chains } = a.sink;
    const inChain = (i: number): boolean => chains.some(([s, e]) => i >= s && i < e);
    let run = -1;
    for (let i = from; i <= to; i++) {
      const own = i < to && !inChain(i);
      if (own && run < 0) run = i;
      if (!own && run >= 0) {
        add(id, lines(run, i - 1, 'own'));
        run = -1;
      }
    }
  }
  if (a.discard && a.discard.owner) add(a.discard.owner, lines(a.discard.index, a.discard.index, 'own'));
  if (a.ret.whole) add(a.ret.whole, lines(a.ret.index, a.ret.index, 'own'));
  const retAt = off[a.ret.index];
  for (const c of a.ret.cols) add(c.nodeId, { from: retAt + c.from, to: retAt + c.to, kind: 'own', inline: true });

  // A Split emits no line of its own: its swizzle is inlined into each
  // consumer. Its "code" is those reads, inside the consumer's own text.
  for (const { splitId, consumerId, ref } of a.splitReads) {
    for (const span of [...(byNode.get(consumerId) ?? [])]) {
      if (span.kind !== 'own') continue;
      for (const at of refOccurrences(code, ref, span.from, span.to)) {
        if ((byNode.get(splitId) ?? []).some((s) => s.from === at)) continue;
        add(splitId, { from: at, to: at + ref.length, kind: 'use', inline: true });
      }
    }
  }

  const pos = positionIndex(code);
  const out = new Map<string, CodeSpan[]>();
  for (const [id, list] of byNode) {
    list.sort((x, y) => x.from - y.from || x.to - y.to);
    out.set(id, list.map((s) => {
      const start = pos(s.from);
      const end = pos(s.to);
      return {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
        kind: s.kind,
        inline: s.inline,
      };
    }));
  }
  return out;
}
