/**
 * The intro scenes' clock: a loop of steps, each easing a set of numbers (the
 * pointer, a dragged node's offset) toward its target while holding a discrete
 * scene state. Pure — the scenes add what is particular to them on top.
 */

export interface Point {
  x: number;
  y: number;
}

/** The numbers a step eases toward. Every step names every key. */
export type Key = Readonly<Record<string, number>>;

export interface Step<S> {
  ms: number;
  to: Key;
  state: S;
}

export interface Timeline<S> {
  start: Key;
  steps: Step<S>[];
  /** Loop length, ms. */
  total: number;
}

export interface Moment<S> {
  key: Record<string, number>;
  state: S;
  /** Scene fade at the loop's two ends, 0–1. */
  opacity: number;
  /** Index of the running step. */
  step: number;
}

const FADE_MS = 400;

export function timeline<S>(start: Key, steps: Step<S>[]): Timeline<S> {
  return { start, steps, total: steps.reduce((t, s) => t + s.ms, 0) };
}

/** When step `index` begins, ms into the loop. */
export function stepStart<S>(tl: Timeline<S>, index: number): number {
  return tl.steps.slice(0, index).reduce((t, s) => t + s.ms, 0);
}

/** The middle of step `index` — a still that belongs to it. */
export function stepMiddle<S>(tl: Timeline<S>, index: number): number {
  return stepStart(tl, index) + tl.steps[index].ms / 2;
}

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

/** The timeline at `t` ms, wrapped into the loop. */
export function momentAt<S>(tl: Timeline<S>, t: number): Moment<S> {
  const time = ((t % tl.total) + tl.total) % tl.total;
  let from = tl.start;
  let t0 = 0;
  let index = tl.steps.length - 1;
  let e = 1;
  for (let i = 0; i < tl.steps.length; i++) {
    const s = tl.steps[i];
    if (time < t0 + s.ms) {
      index = i;
      e = ease((time - t0) / s.ms);
      break;
    }
    from = s.to;
    t0 += s.ms;
  }
  const step = tl.steps[index];
  const key: Record<string, number> = {};
  for (const k of Object.keys(step.to)) key[k] = from[k] + (step.to[k] - from[k]) * e;
  return {
    key,
    state: step.state,
    opacity: Math.min(1, time / FADE_MS, (tl.total - time) / FADE_MS),
    step: index,
  };
}
