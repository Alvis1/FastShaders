/**
 * The intro's image slide as data: a photo dragged in from outside the window
 * and dropped on the canvas, the app's "Convert image to optimized format?"
 * answered Yes, the Image node landing where it was dropped, and the
 * "resized for your device" notice acknowledged.
 *
 * Pure and node-testable, like the other tours. What the dialogs and the node
 * SAY is the app's: ImageScene runs the real import encode on the photo.
 */
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** What the scene measures, in stage px. */
export interface ImageGeometry {
  /** Where the drag enters from (outside the stage) and where it is let go —
   *  the node's top-left, as a drop places it. */
  enter: Point;
  drop: Point;
  /** The question's Yes, and the notice's OK. */
  yes: Point;
  ok: Point;
}

export interface ImageState {
  /** The file is being dragged under the pointer. */
  dragging: boolean;
  /** "Convert image to optimized format?" is open. */
  ask: boolean;
  /** The Image node is on the canvas. */
  node: boolean;
  /** The "resized for your device" notice is open. */
  notice: boolean;
  pressed: boolean;
}

export interface ImageTour {
  geo: ImageGeometry;
  tl: Timeline<ImageState>;
  /** Stills: the question, the notice, and the node alone. */
  asking: number;
  noticed: number;
  placed: number;
}

const LEAVE: Point = { x: 70, y: 60 };

export function buildImageTour(geo: ImageGeometry, opts: { notice: boolean }): ImageTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  const s = (patch: Partial<ImageState>): ImageState => ({
    dragging: false, ask: false, node: false, notice: false, pressed: false, ...patch,
  });
  const steps: Step<ImageState>[] = [
    { ms: 500, to: at(geo.enter), state: s({ dragging: true, pressed: true }) },
    { ms: 1400, to: at(geo.drop), state: s({ dragging: true, pressed: true }) },
    { ms: 300, to: at(geo.drop), state: s({ dragging: true, pressed: true }) },
  ];
  const askingAt = steps.length;
  steps.push(
    { ms: 700, to: at(geo.drop), state: s({ ask: true }) },
    { ms: 800, to: at(geo.yes), state: s({ ask: true }) },
    { ms: 260, to: at(geo.yes), state: s({ ask: true, pressed: true }) },
  );
  let noticedAt = -1;
  if (opts.notice) {
    // The app raises the notice as the node lands, so both arrive together.
    noticedAt = steps.length;
    steps.push(
      { ms: 3600, to: at(geo.yes), state: s({ node: true, notice: true }) },
      { ms: 700, to: at(geo.ok), state: s({ node: true, notice: true }) },
      { ms: 260, to: at(geo.ok), state: s({ node: true, notice: true, pressed: true }) },
    );
  }
  const placedAt = steps.length;
  const last = opts.notice ? geo.ok : geo.yes;
  steps.push(
    { ms: 2400, to: at(last), state: s({ node: true }) },
    { ms: 700, to: at({ x: last.x + LEAVE.x, y: last.y + LEAVE.y }), state: s({ node: true }) },
  );
  const tl = timeline(at(geo.enter), steps);
  return {
    geo,
    tl,
    asking: stepMiddle(tl, askingAt),
    noticed: noticedAt >= 0 ? stepMiddle(tl, noticedAt) : stepMiddle(tl, placedAt),
    placed: stepMiddle(tl, placedAt),
  };
}

export function imageFrame(tour: ImageTour, t: number): { cursor: Point; state: ImageState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}
