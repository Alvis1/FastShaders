/**
 * Intro scene — double-click a node (double-tap on touch) and every one of its
 * socket labels shows at once and stays; a click on empty canvas puts them
 * away. Pure: the timeline. The labels are the canvas's own (TypedHandle's
 * text, shown by the `[data-fs-labels-shown]` rule labelPeek.ts sets).
 */
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** The scene's two nodes whose labels are shown: the Image (outputs only —
 *  a fresh one has no inputs) and Mix (inputs and an output). */
export type LabelsNode = 'image' | 'mix';

export interface LabelsState {
  /** The node whose labels are pinned; null = none. */
  peek: LabelsNode | null;
  pressed: boolean;
  /** The pointer is a fingertip (a touch device). */
  touch: boolean;
  /** The gesture named under the scene while it is made. */
  cap: 'click' | 'tap' | null;
}

export interface LabelsTour {
  tl: Timeline<LabelsState>;
  /** Stills: the Image's labels up (mouse), Mix's (touch). */
  image: number;
  mix: number;
}

export interface LabelsGeometry {
  /** Where each node is double-clicked / double-tapped: on its body, clear
   *  of its sockets and value boxes. */
  image: Point;
  mix: Point;
  /** Empty canvas, where the closing click lands. */
  rest: Point;
}

const PRESS_MS = 150;
/** The gap between the two presses — well inside the double-click window. */
const GAP_MS = 140;

export function buildLabelsTour(geo: LabelsGeometry): LabelsTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  const s = (patch: Partial<LabelsState>): LabelsState => ({ peek: null, pressed: false, touch: false, cap: null, ...patch });
  /** Two presses on `p`; the labels open on the second. */
  const double = (p: Point, node: LabelsNode, touch: boolean): Step<LabelsState>[] => {
    const cap = touch ? ('tap' as const) : ('click' as const);
    return [
      { ms: PRESS_MS, to: at(p), state: s({ pressed: true, touch, cap }) },
      { ms: GAP_MS, to: at(p), state: s({ touch, cap }) },
      { ms: PRESS_MS, to: at(p), state: s({ pressed: true, touch, cap, peek: node }) },
      { ms: 900, to: at(p), state: s({ touch, cap, peek: node }) },
    ];
  };
  const steps: Step<LabelsState>[] = [
    { ms: 600, to: at(geo.rest), state: s({}) },
    { ms: 800, to: at(geo.image), state: s({}) },
    ...double(geo.image, 'image', false),
  ];
  const imageAt = steps.length;
  steps.push(
    { ms: 2400, to: at(geo.image), state: s({ peek: 'image' }) },
    { ms: 700, to: at(geo.rest), state: s({ peek: 'image' }) },
    { ms: PRESS_MS, to: at(geo.rest), state: s({ pressed: true }) },
    { ms: 700, to: at(geo.rest), state: s({}) },
    // A touch device: the same gesture as two taps.
    { ms: 300, to: at(geo.rest), state: s({ touch: true }) },
    { ms: 800, to: at(geo.mix), state: s({ touch: true }) },
    ...double(geo.mix, 'mix', true),
  );
  const mixAt = steps.length;
  steps.push(
    { ms: 2400, to: at(geo.mix), state: s({ touch: true, peek: 'mix' }) },
    { ms: 700, to: at(geo.rest), state: s({ touch: true, peek: 'mix' }) },
    { ms: PRESS_MS, to: at(geo.rest), state: s({ touch: true, pressed: true }) },
    { ms: 800, to: at(geo.rest), state: s({ touch: true }) },
  );
  const tl = timeline(at(geo.rest), steps);
  return { tl, image: stepMiddle(tl, imageAt), mix: stepMiddle(tl, mixAt) };
}

/** The pair's two presses, first press to second, ms — what labelPeek counts
 *  against `DOUBLE_ACTIVATE_MS`. */
export const LABELS_PAIR_MS = PRESS_MS + GAP_MS;

export function labelsFrame(tour: LabelsTour, t: number): { cursor: Point; state: LabelsState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}
