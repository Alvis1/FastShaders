/**
 * The hands-on lesson data model (the Tutorials tab, `src/tutorials/`).
 *
 * A lesson is a list of STEPS the user performs on the REAL canvas — add a
 * node, wire two sockets, set a value, expose a hidden Output channel — each
 * with a caption that teaches the concept behind it. The panel evaluates the
 * live graph against the current step (`tutorialRun.ts`) and unlocks Next when
 * it holds; "Do it for me" performs the step through the store's own write
 * paths (`tutorialAutoStep.ts`).
 *
 * Lessons are authored as plain registry data — type ids, port ids, values —
 * never as TSL code, so `tutorialDefs.ts` stays a LEAF that the asset browser
 * can import statically without pulling the Babel parser onto the boot wave
 * (`bootWave.test.ts`). This file holds types, constants and one leaf
 * predicate (`graphIsBlank`) the store reads at takeover.
 */

/** The role every lesson starts with: the Output the takeover leaves on the canvas. */
export const OUT_ROLE = 'out';

/** A lesson's step cap — long enough for a five-node graph built one wire at a
 *  time, short enough that a lesson stays one idea (`tutorialDefs.test.ts`). */
export const MAX_TUTORIAL_STEPS = 16;
/** Caption / hint length caps: the panel is ~340 px wide and never scrolls. */
export const MAX_CAPTION_CHARS = 160;
export const MAX_HINT_CHARS = 120;

export interface TutorialDef {
  /** `tut-*`, the id the done-list stores and tests key on. */
  id: string;
  /** English; the Latvian lives in lv.json `ui` under this exact text (like the intro captions). */
  title: string;
  /** One or two sentences for the tile tooltip and the start screen. */
  summary: string;
  /** The built-in recipe (Presets tab) whose graph this lesson builds. The
   *  auto path must reproduce that graph's SHADER (tutorialAutoStep.test.ts
   *  compares the fully inlined return expressions), and the finish screen
   *  names it as the place to find the finished version. */
  recipeId?: string;
  /** That recipe's English name (lv.json `assets` translates it), for the finish
   *  screen's "find the finished version on the Presets tab" line — kept here so
   *  the leaf never imports the Babel-bearing preset library; the test holds it
   *  equal to the library's. */
  recipeName?: string;
  /** Also byte-identical to the recipe's emitted module — holds only when the
   *  add order matches the recipe's statement order (variable names are claimed
   *  in topological order seeded by array order). */
  byteExact?: true;
  steps: readonly TutorialStep[];
}

interface StepBase {
  /** Stable within the lesson (tests, telemetry-free analytics never). */
  id: string;
  /** What to do and why — one instruction, one concept sentence. */
  caption: string;
  /** Where to find the thing, shown on request ("Show hint"). */
  hint?: string;
}

/** A node the user adds. `values` are applied on the AUTO path only — the
 *  colours and ramp stops a lesson does not teach — and are never a condition:
 *  a value the lesson DOES teach is its own `set` step. */
export interface AddStep extends StepBase {
  kind: 'add';
  role: string;
  type: string;
  values?: Readonly<Record<string, number | string>>;
}

/** A wire, always authored output → input: `from` names an output handle on
 *  the first role, `to` an input handle on the second (the Output's channel
 *  handles are bare: `color`, `emissive`, `position`, …). */
export interface WireStep extends StepBase {
  kind: 'wire';
  from: readonly [role: string, handle: string];
  to: readonly [role: string, handle: string];
}

/** A stored value — an unwired input's number box (`values[portId]`), a
 *  `defaultValues` parameter (a noise node's `scale`, Time's `speed`) or one
 *  of the stored keys (`signed`, `stops`, `interp`, `hex`). Numbers compare
 *  within `tolerance` (default 1e-6), strings exactly, `#rrggbb` case-free. */
export interface SetStep extends StepBase {
  kind: 'set';
  role: string;
  key: string;
  value: number | string;
  tolerance?: number;
}

/** Make a hidden Output channel a visible socket (right-click → tick). The
 *  Output has no drag-reveal, so every wire into a non-default channel needs
 *  one of these first. `opacity` ALSO means Transparent: the Output menu
 *  couples the two, and an opaque material ignores Opacity entirely. */
export interface ExposeStep extends StepBase {
  kind: 'expose';
  role: string;
  handle: string;
}

/** A caption only — the idea at the start, the "Try: …" at the end. Always satisfied. */
export interface LookStep extends StepBase {
  kind: 'look';
}

export type TutorialStep = AddStep | WireStep | SetStep | ExposeStep | LookStep;

/** The store's session-only record of the running lesson. */
export interface TutorialRun {
  id: string;
  /** `ask` = the tile was pressed over real work and the panel is asking before
   *  the takeover; `run` = the canvas holds the lesson's Output. */
  phase: 'ask' | 'run';
  /** The step on screen; `steps.length` is the finish screen. */
  step: number;
  /** The highest step the user has advanced PAST — Next stays enabled on a
   *  step already passed even when a later step replaced its wire. Raised by
   *  `tutorialGo`, never lowered. */
  reached: number;
  /** role → node id. `out` is bound by the takeover. */
  bindings: Readonly<Record<string, string>>;
}

/**
 * "Nothing to lose": a canvas that holds at most a lone Output, no wire and no
 * board stroke. A tile press over such a canvas takes over at once; over
 * anything else the panel ASKS first, because the autosave writes the lesson
 * graph over `fs:graph` 300 ms later and the old graph then survives only in
 * in-memory history until a reload. A leaf predicate (no node types read), so
 * the store can import it without a cycle.
 */
export function graphIsBlank(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  drawings: readonly unknown[],
): boolean {
  return nodes.length <= 1 && edges.length === 0 && drawings.length === 0;
}
