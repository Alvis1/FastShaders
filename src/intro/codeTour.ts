/**
 * The intro's code slide as data: TSL typed into the code panel, Apply, and
 * the graph follows — first a noise into the Output, then Time and Sin driving
 * the noise's scale, which makes the shader move.
 *
 * The scene starts from the code the app shows for a fresh graph
 * (`graphToCode` of a lone Output) and edits it the way a person would:
 * anchored insertions and one select-and-retype. What each Apply builds is the
 * app's own `codeToGraph` (CodeScene). The first edit retypes the starting
 * `return`, because that line is the empty Output's red fallback — left in, an
 * Apply parses it into a Vec3 node, exactly as the app would.
 *
 * Pure and node-testable, like the other tours.
 */
import { momentAt, stepMiddle, stepStart, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** One edit: insert `text` right after the first `after`, or select the first
 *  `find` and type `text` over it. */
export type CodeEdit = { after: string; text: string } | { find: string; text: string };
export type CodePlanItem = CodeEdit | 'apply';

export const CODE_PLAN: readonly CodePlanItem[] = [
  { after: 'Fn(() => {\n', text: '  const noise1 = mx_noise_float(positionGeometry);' },
  { find: 'vec3(1, 0, 0)', text: 'noise1' },
  'apply',
  { after: 'Fn(() => {', text: '\n  const time1 = time;' },
  { after: 'const time1 = time;', text: '\n  const sin1 = sin(time1);' },
  { after: 'mx_noise_float(positionGeometry', text: '.mul(sin1)' },
  'apply',
];

/** Where an edit lands in `text`: the replaced span (empty for an insert). */
export function editSpan(text: string, edit: CodeEdit): { start: number; end: number } | null {
  if ('find' in edit) {
    const i = text.indexOf(edit.find);
    return i < 0 ? null : { start: i, end: i + edit.find.length };
  }
  const i = text.indexOf(edit.after);
  return i < 0 ? null : { start: i + edit.after.length, end: i + edit.after.length };
}

/** The code at every Apply, in order — what CodeScene parses. Null if an
 *  anchor is missing from the starting code (the test pins it is not). */
export function codeSnapshots(start: string, plan: readonly CodePlanItem[] = CODE_PLAN): string[] | null {
  let text = start;
  const out: string[] = [];
  for (const item of plan) {
    if (item === 'apply') {
      out.push(text);
      continue;
    }
    const span = editSpan(text, item);
    if (!span) return null;
    text = text.slice(0, span.start) + item.text + text.slice(span.end);
  }
  return out;
}

export interface CodeGeometry {
  /** The panel's Apply button, and where the pointer waits while typing. */
  apply: Point;
  rest: Point;
}

export interface CodeState {
  text: string;
  /** Caret offset in `text`, or null while the editor is not being typed in. */
  caret: number | null;
  /** A selected span, shown before it is typed over. */
  sel: { start: number; end: number } | null;
  /** How many Applies have run — the graph shows that snapshot. */
  applied: number;
  pressed: boolean;
}

export interface CodeTour {
  geo: CodeGeometry;
  tl: Timeline<CodeState>;
  /** A still: the last Apply done, the shader moving. */
  still: number;
  /** When the last Apply lands, ms into the loop — the moment Time starts
   *  driving the graph. */
  liveFrom: number;
}

const TYPE_MS = 45;

export function buildCodeTour(start: string, geo: CodeGeometry, plan: readonly CodePlanItem[] = CODE_PLAN): CodeTour | null {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  const steps: Step<CodeState>[] = [];
  let text = start;
  let applied = 0;
  let where = geo.rest;
  const push = (ms: number, to: Point, s: Omit<CodeState, 'text' | 'applied'> & Partial<CodeState>) => {
    where = to;
    steps.push({ ms, to: at(to), state: { text, applied, ...s } });
  };

  push(900, geo.rest, { caret: null, sel: null, pressed: false });
  for (const item of plan) {
    if (item === 'apply') {
      push(700, geo.apply, { caret: null, sel: null, pressed: false });
      push(220, geo.apply, { caret: null, sel: null, pressed: true });
      applied += 1;
      push(applied === plan.filter((p) => p === 'apply').length ? 3200 : 1600, geo.apply, { caret: null, sel: null, pressed: false });
      push(600, geo.rest, { caret: null, sel: null, pressed: false });
      continue;
    }
    const span = editSpan(text, item);
    if (!span) return null;
    if (span.end > span.start) {
      push(500, where, { caret: span.end, sel: span, pressed: false });
    }
    const before = text.slice(0, span.start);
    const after = text.slice(span.end);
    // Typing: the replaced span goes with the first character, as it does when
    // a selection is typed over.
    for (let n = 1; n <= item.text.length; n++) {
      text = before + item.text.slice(0, n) + after;
      push(TYPE_MS, where, { caret: span.start + n, sel: null, pressed: false });
    }
    push(350, where, { caret: span.start + item.text.length, sel: null, pressed: false });
  }
  const tl = timeline(at(geo.rest), steps);
  // The last Apply's long hold: the step after its press.
  const lastHold = steps.findIndex((s, i) => s.state.applied === applied && i > 0 && steps[i - 1].state.pressed);
  return { geo, tl, still: stepMiddle(tl, lastHold), liveFrom: stepStart(tl, lastHold) };
}

export function codeFrame(tour: CodeTour, t: number): { cursor: Point; state: CodeState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}

export type CodeToken = 'kw' | 'str' | 'num' | 'com' | null;

const TOKEN_RE = /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|\b(\d+(?:\.\d+)?)\b|\b(import|from|const|let|return|export|default|function)\b/g;

/** Per-character token classes — the JavaScript grammar's keyword, string,
 *  number and comment, which is what Monaco colours in this code. */
export function tokenClasses(text: string): CodeToken[] {
  const out: CodeToken[] = new Array(text.length).fill(null);
  for (const m of text.matchAll(TOKEN_RE)) {
    const kind: CodeToken = m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'num' : 'kw';
    for (let i = m.index!; i < m.index! + m[0].length; i++) out[i] = kind;
  }
  return out;
}
