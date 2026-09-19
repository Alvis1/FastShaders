/**
 * The seam lens — the hover affordance every draggable window divider shows.
 *
 * A seam is a plain line, and the WHOLE line is the drag target (see the
 * `.fs-seam` rules in styles/controls.css). Hovering it opens the line around
 * the pointer: the stroke splits into two, bulges out to enclose a panel-white
 * gap, and rejoins the single line tangentially on both sides, with a short
 * grip line drawn down the middle of the gap — the "friction" mark that says
 * this is a thing you drag. It follows the pointer along the seam, so it is
 * always exactly where the hand is, and it replaces the fixed grip tab (a
 * diamond on a --ctl-size plate parked at one spot on each seam), whose two
 * bad properties were that it hung ~24px into a neighbouring pane and that it
 * was the ONLY place the seam could be grabbed.
 *
 * At a JUNCTION — where two seams meet, and a drag moves both — the bulge
 * becomes a RING: a circle on the crossing with the same stripe through its
 * middle. The circle is the joint the two lines share, so it reads as "this
 * point moves both"; the stripe stays so it still reads as a drag mark.
 *
 * This module is the PURE half — the SVG path data and the along-seam
 * coordinate maths — so it is node-testable. SeamLens.tsx renders it and
 * writes the pointer position onto the host. (Named seamLensGeometry, not
 * seamLens: on this case-insensitive filesystem a file differing from
 * SeamLens.tsx only by case fails `tsc` and confuses Vite's resolver — the
 * titleSplit.ts / NodeTitle.tsx trap.)
 *
 * Geometry is authored in a (u, v) frame — u ALONG the seam, v ACROSS it —
 * and mapped to (x, y) per orientation, so both seam directions share one
 * construction rather than two hand-mirrored path strings.
 */

/** 'v' = a VERTICAL line (the column seam); 'h' = a HORIZONTAL one (the
 *  preview/code seam and the asset bar's top edge). */
export type SeamOrientation = 'v' | 'h';

export const SEAM_LENS = {
  /**
   * How far the two strokes stand off the seam's centre-line at the widest
   * point, in px. The gap between them is 2 × this minus the seam's own
   * thickness (2px on desktop), so 6 leaves a 10px panel-white gap around the
   * 2px grip line — 4px of white either side, enough to read as a split and
   * not as a thick line. (5 / 36 / 12 at first; scaled ×1.2 on 2026-09-16 by
   * owner request — "make it +0.2 bigger".)
   */
  half: 6,
  /** Half the bulge's length along the seam, in px. */
  run: 43,
  /** Half the grip line's length, in px. Shorter than the bulge so it sits
   *  inside the white, clear of the curves. */
  gripRun: 14,
  /** The junction ring's radius, in px — well over twice the bulge's
   *  half-width, so the circle reads as a joint and not as a fatter bulge
   *  (12 at first; ×1.3 on 2026-09-16 by owner request, "make the circle 0.3
   *  larger"). */
  ringR: 16,
  /** Half the ring's stripe, in px. Inside the ring with room to spare. */
  ringGrip: 9,
  /**
   * How far the SVG box extends past the stroke centre-lines — room for half
   * the stroke width. Sized for the coarse-pointer seam (6px → 3px overhang)
   * with a px to spare; a wider seam token needs this raised.
   */
  overscan: 4,
} as const;

export interface LensPaths {
  /** The bulge outline — panel-white fill, seam-coloured stroke. */
  outline: string;
  /** The grip line down the middle of the gap. */
  grip: string;
  /** The junction ring — same fill and stroke as the bulge. */
  ring: string;
  /** The ring's stripe, along the seam. */
  ringGrip: string;
  /** SVG box, with the origin at the bulge's (and the ring's) centre. */
  viewBox: string;
  width: number;
  height: number;
}

/**
 * The bulge is two cubic Béziers per side. Each leaves the seam with a
 * tangent ALONG the seam, reaches ±half at the pointer with the same tangent,
 * and returns the same way — so the split strokes meet the single line
 * without a corner, which is what makes the seam look like it OPENED rather
 * than like a shape was dropped on it. The `S` segments reflect the previous
 * control point about the current point, which is exactly the mirror the
 * second half of each side needs.
 */
function buildPaths(orientation: SeamOrientation): LensPaths {
  const { half, run, gripRun, ringR, ringGrip, overscan } = SEAM_LENS;
  // (u along, v across) → "x,y"
  const pt = (u: number, v: number) => (orientation === 'v' ? `${v},${u}` : `${u},${v}`);
  const outline = [
    `M ${pt(-run, 0)}`,
    `C ${pt(-run / 2, 0)} ${pt(-run / 2, half)} ${pt(0, half)}`,
    `S ${pt(run / 2, 0)} ${pt(run, 0)}`,
    `C ${pt(run / 2, 0)} ${pt(run / 2, -half)} ${pt(0, -half)}`,
    `S ${pt(-run / 2, 0)} ${pt(-run, 0)}`,
    'Z',
  ].join(' ');
  const grip = `M ${pt(-gripRun, 0)} L ${pt(gripRun, 0)}`;
  // Two half-circle arcs; the sweep flag's meaning flips with the axis swap,
  // but two halves close into the same circle either way.
  const ring = [
    `M ${pt(-ringR, 0)}`,
    `A ${ringR} ${ringR} 0 1 0 ${pt(ringR, 0)}`,
    `A ${ringR} ${ringR} 0 1 0 ${pt(-ringR, 0)}`,
    'Z',
  ].join(' ');
  const ringGripPath = `M ${pt(-ringGrip, 0)} L ${pt(ringGrip, 0)}`;
  const along = 2 * (run + overscan);
  const across = 2 * (Math.max(half, ringR) + overscan);
  const width = orientation === 'v' ? across : along;
  const height = orientation === 'v' ? along : across;
  return {
    outline,
    grip,
    ring,
    ringGrip: ringGripPath,
    viewBox: `${-width / 2} ${-height / 2} ${width} ${height}`,
    width,
    height,
  };
}

const PATHS: Record<SeamOrientation, LensPaths> = {
  v: buildPaths('v'),
  h: buildPaths('h'),
};

/** Path data for one orientation. Built once per orientation at module init —
 *  a SplitPane re-renders on every drag frame, and the strings never change. */
export function lensPaths(orientation: SeamOrientation): LensPaths {
  return PATHS[orientation];
}

/** The subset of a DOMRect the along-seam maths needs. */
export interface SeamBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Where along the seam the pointer is, in px from the seam's start — the
 * value the host publishes as `--fs-lens-at`.
 *
 * Clamped to the seam's own extent: a captured drag routinely carries the
 * pointer past the seam's end (above the top of a column seam, say), and the
 * lens must stay ON the line rather than float off its end.
 */
export function lensAlong(
  orientation: SeamOrientation,
  box: SeamBox,
  clientX: number,
  clientY: number,
): number {
  const raw = orientation === 'v' ? clientY - box.top : clientX - box.left;
  const length = orientation === 'v' ? box.height : box.width;
  if (!(length > 0)) return 0;
  return Math.max(0, Math.min(length, raw));
}
