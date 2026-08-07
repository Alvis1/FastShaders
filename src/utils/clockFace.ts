/**
 * The Time node's clock face — ONE drawing routine, shared by the live canvas
 * node (ClockNode, which re-draws it every rAF from an integrated phase) and
 * the static asset-browser / overview tile (NodePreviewCard's ClockCardContent,
 * which draws it once).
 *
 * The two used to hold byte-identical copies of ~50 lines of canvas code, which
 * had already drifted: the tile seeded its hand from `Date.now()`, so a Time
 * tile pointed somewhere arbitrary while a Time node dropped on the canvas
 * starts at 12 o'clock. Same drift class `micGeometry.ts` was created to close
 * for the Mic node.
 *
 * Pure canvas work, no React and no imports — the caller owns its own context
 * (both callers pass a `willReadFrequently` one: an accelerated canvas inside
 * the React Flow viewport makes Safari rasterize the zoomed graph at 1×).
 */

/** Canvas edge length in CSS px. The face is inscribed in it. */
export const CLOCK_SIZE = 56;

/**
 * Draw the whole face at `phase` seconds (the hand sweeps once per 60). Clears
 * first, so it is safe to call repeatedly on one context.
 */
export function drawClockFace(
  ctx: CanvasRenderingContext2D,
  phase: number,
  size: number = CLOCK_SIZE,
): void {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;

  ctx.clearRect(0, 0, size, size);

  // Face
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Hour marks
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const inner = r - 4;
    const outer = r - 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Seconds hand
  const secAngle = ((phase % 60) / 60) * Math.PI * 2 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(secAngle) * (r - 6), cy + Math.sin(secAngle) * (r - 6));
  ctx.strokeStyle = '#e74c3c';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Centre dot
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fillStyle = '#e74c3c';
  ctx.fill();
}
