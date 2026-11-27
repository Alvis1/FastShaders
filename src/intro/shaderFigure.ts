/**
 * The three spheres at the top of the "What is a shader?" tab, as PURE
 * geometry: SVG path data in a 96-unit box, no React. Drawn rather than
 * shipped as picture files, so they stay sharp at any zoom and load nothing.
 *
 *  1. One colour: the blue the first lesson (One Color) paints.
 *  2. A pattern: the Stripes lesson's two colours as bands from pole to pole.
 *     That lesson's U × 8 → Fract → Constant ramp makes eight periods round
 *     the whole sphere, so the half facing the viewer shows eight bands.
 *  3. A moved surface: the same blue with its outline pushed in and out,
 *     r(θ) = R·(1 + 0.08·sin 8θ), over a dashed circle where the surface was.
 *
 * One flat light from the upper left falls on all three: a darker crescent
 * (the shape minus a disc moved toward the light) and a light spot. No
 * gradient and no blur, as everywhere in the app. The fills are readings, so
 * they stay the same in both themes; the outline and the dashed circle take
 * theme tokens in CSS (IntroWindow.css).
 */

export const VIEW = 96;
export const CX = 48;
export const CY = 48;
export const R = 36;
export const WAVE_AMPLITUDE = 0.08;
export const WAVE_LOBES = 8;
export const STRIPE_COUNT = 8;

export const ONE_COLOR = '#4fc3f7';
export const STRIPE_DARK = '#263238';
export const STRIPE_LIGHT = '#eceff1';

/** Where the light comes FROM: up and to the left (a screen angle, y down). */
export const LIGHT_ANGLE = -0.75 * Math.PI;
/** The lit disc is the sphere's own disc moved this far (× R) toward the light. */
export const SHADOW_SHIFT = 0.32;
/** Samples round a sampled outline. A multiple of 8, so the middle of the
 *  shadow (straight away from the light, at 45°) falls on a sample. */
export const SAMPLES = 192;

/** A star-shaped outline: the shape's radius at a screen angle, from (CX, CY). */
export type Outline = (theta: number) => number;
export const circleOutline: Outline = () => R;
export const wavyOutline: Outline = (theta) => R * (1 + WAVE_AMPLITUDE * Math.sin(WAVE_LOBES * theta));

/** Two decimals, and never "-0". */
const num = (n: number): number => {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
};
const point = (theta: number, r: number) => `${num(CX + r * Math.cos(theta))},${num(CY + r * Math.sin(theta))}`;
const sampleAngle = (k: number) => (2 * Math.PI * k) / SAMPLES;

/** A closed outline, through SAMPLES points. */
export function outlinePath(outline: Outline): string {
  const pts: string[] = [];
  for (let k = 0; k < SAMPLES; k++) pts.push(point(sampleAngle(k), outline(sampleAngle(k))));
  return `M${pts[0]}L${pts.slice(1).join(' ')}Z`;
}

const LIT_X = CX + SHADOW_SHIFT * R * Math.cos(LIGHT_ANGLE);
const LIT_Y = CY + SHADOW_SHIFT * R * Math.sin(LIGHT_ANGLE);
/** The lit disc's centre, for the test. */
export const LIT_CENTRE = { x: LIT_X, y: LIT_Y } as const;

/** How far the lit disc reaches along the ray from the centre at `theta`.
 *  The centre is inside the disc (SHADOW_SHIFT < 1), so the ray leaves it once. */
export function litReach(theta: number): number {
  const vx = LIT_X - CX;
  const vy = LIT_Y - CY;
  const b = Math.cos(theta) * vx + Math.sin(theta) * vy;
  return b + Math.sqrt(b * b + R * R - (vx * vx + vy * vy));
}

/**
 * The shadow: the part of the shape OUTSIDE the lit disc, a crescent on the
 * side away from the light. It is walked in the outline's own steps, from the
 * middle of the shadow outward until the lit disc reaches the outline on
 * either side, so its outer edge lies on the outline's own points. Each tip is
 * placed where the disc meets the outline, found by linear interpolation
 * between the last step in shade and the first in light.
 */
export function crescentPath(outline: Outline): string {
  const away = Math.round(((LIGHT_ANGLE + Math.PI) / (2 * Math.PI)) * SAMPLES);
  const depth = (k: number) => outline(sampleAngle(k)) - litReach(sampleAngle(k));
  let lo = away;
  while (lo > away - SAMPLES / 2 && depth(lo - 1) > 0) lo--;
  let hi = away;
  while (hi < away + SAMPLES / 2 && depth(hi + 1) > 0) hi++;
  const tip = (inShade: number, inLight: number) => {
    const a = depth(inShade);
    const b = depth(inLight);
    if (b > 0) return point(sampleAngle(inShade), outline(sampleAngle(inShade)));
    const theta = sampleAngle(inShade) + (sampleAngle(inLight) - sampleAngle(inShade)) * (a / (a - b));
    return point(theta, outline(theta));
  };
  const outer: string[] = [];
  const inner: string[] = [];
  for (let k = lo; k <= hi; k++) {
    outer.push(point(sampleAngle(k), outline(sampleAngle(k))));
    inner.push(point(sampleAngle(k), litReach(sampleAngle(k))));
  }
  return `M${tip(lo, lo - 1)}L${outer.join(' ')} ${tip(hi, hi + 1)} ${inner.reverse().join(' ')}Z`;
}

export interface StripeBand {
  /** Longitudes in degrees: −90 is the left edge, 0 faces the viewer, 90 the right edge. */
  from: number;
  to: number;
  dark: boolean;
  d: string;
}

/** Half a meridian, pole to pole: the half-ellipse through x = R·sin λ on the
 *  equator, drawn down (top pole to bottom) or back up. */
function meridian(lambdaDeg: number, down: boolean): string {
  const x = R * Math.sin((lambdaDeg * Math.PI) / 180);
  const end = `${num(CX)},${num(down ? CY + R : CY - R)}`;
  if (Math.abs(x) < 1e-9) return `L${end}`;
  // Clockwise on screen (sweep 1): down on the right, or up on the left.
  const sweep = x > 0 === down ? 1 : 0;
  return `A${num(Math.abs(x))},${num(R)} 0 0 ${sweep} ${end}`;
}

/** The front half in `count` bands of equal longitude, from the left edge to
 *  the right, alternating light and dark. Each band runs pole to pole. */
export function stripeBands(count = STRIPE_COUNT): StripeBand[] {
  const bands: StripeBand[] = [];
  for (let i = 0; i < count; i++) {
    const from = -90 + (180 * i) / count;
    const to = -90 + (180 * (i + 1)) / count;
    bands.push({
      from,
      to,
      dark: i % 2 === 1,
      d: `M${num(CX)},${num(CY - R)}${meridian(from, true)}${meridian(to, false)}Z`,
    });
  }
  return bands;
}

/** The light spot: an ellipse on the lit side, long across the light. */
export const HIGHLIGHT = {
  cx: num(CX + 0.42 * R * Math.cos(LIGHT_ANGLE)),
  cy: num(CY + 0.42 * R * Math.sin(LIGHT_ANGLE)),
  rx: num(0.2 * R),
  ry: num(0.12 * R),
  rotate: num((LIGHT_ANGLE * 180) / Math.PI + 90),
} as const;

/** Every path the tab draws, computed once when the intro's chunk loads. */
export const SPHERE_PATHS = {
  circleShadow: crescentPath(circleOutline),
  wavy: outlinePath(wavyOutline),
  wavyShadow: crescentPath(wavyOutline),
  darkStripes: stripeBands()
    .filter((b) => b.dark)
    .map((b) => b.d),
} as const;
