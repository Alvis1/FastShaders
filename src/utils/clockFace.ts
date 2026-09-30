/**
 * The Time node's clock face — ONE geometry model, shared by the live node
 * (ClockFaceSvg with an animated hand) and the static asset-browser /
 * overview tile (phase 0). Pure math, no DOM — node-env testable.
 * Why one model and an SVG: docs/dev/node-visuals-and-designer.md.
 */

/** Face edge length in CSS px. The dial is inscribed in it. */
export const CLOCK_SIZE = 56;
/** Dial radius (rim inset by 4px). */
export const CLOCK_R = CLOCK_SIZE / 2 - 4;

export interface ClockTick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The 12 hour marks — short radial segments just inside the rim. */
export function clockTicks(size: number = CLOCK_SIZE): ClockTick[] {
  const c = size / 2;
  const r = size / 2 - 4;
  const ticks: ClockTick[] = [];
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    ticks.push({
      x1: c + Math.cos(angle) * (r - 4),
      y1: c + Math.sin(angle) * (r - 4),
      x2: c + Math.cos(angle) * (r - 1),
      y2: c + Math.sin(angle) * (r - 1),
    });
  }
  return ticks;
}

/**
 * Hand rotation in DEGREES about the face centre for `phase` seconds — one
 * sweep per 60, 0 = 12 o'clock (the SVG hand is drawn pointing straight up).
 * Handles the negative phases a negative speed integrates to, and degrades a
 * non-finite phase to 0 rather than emitting an invalid transform.
 */
export function clockHandAngle(phase: number): number {
  if (!Number.isFinite(phase)) return 0;
  return ((((phase % 60) + 60) % 60) / 60) * 360;
}
