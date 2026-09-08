/**
 * The subdivision slider's stops.
 *
 * The control is a POWER-OF-TWO ladder drawn as EQUAL SECTIONS: the slider's
 * value is the INDEX of a stop, not the segment count, so every notch is the
 * same width on the track and one notch always means "twice as many segments".
 * That matches how the cost actually behaves — a primitive's quad count and the
 * teapot's triangle count both go as N², so the interesting range (1…16) is
 * squeezed into the first 12% of a linear 1…128 track while the top half of
 * that track is a 25 ms / 6.2 MB re-tessellation per pixel of travel.
 *
 * It also bounds the re-tessellation work a drag can cause: a linear track
 * emits up to 127 distinct values, this one emits at most `STEPS.length - 1`.
 *
 * Pure and node-testable (ShaderPreview.tsx is a React component and the vitest
 * env is `node`), so `subdivisionSteps.test.ts` calls these rather than
 * grepping the component for them.
 */
import { SUBDIVISION_CAP } from '@/engine/tslToPreviewHTML';

/** One segment per axis — the coarsest a primitive can be. */
export const SUBDIVISION_MIN = 1;
/**
 * The app-wide ceiling (128, the Utah Teapot page's own limit): the slider, the
 * primitives' segment clamp and the teapot's patch resolution all share it.
 */
export const SUBDIVISION_MAX = SUBDIVISION_CAP;
/** Smooth enough for displacement without being the top of the ladder. */
export const SUBDIVISION_DEFAULT = 64;

/**
 * Every power of two from the floor to the cap, ascending: [1, 2, …, 128].
 * Derived rather than written out so it cannot drift from the cap — the whole
 * point of `SUBDIVISION_MAX = SUBDIVISION_CAP`.
 */
export const SUBDIVISION_STEPS: readonly number[] = (() => {
  const out: number[] = [];
  for (let v = SUBDIVISION_MIN; v <= SUBDIVISION_MAX; v *= 2) out.push(v);
  return out;
})();

/**
 * The nearest stop to `v`, measured in DOUBLINGS rather than in segments: 96 is
 * one and a half doublings above 64 and half a doubling below 128, and log
 * space is what puts it on 128 — the same spacing the user sees on the track.
 * Non-finite input falls back to the default rather than to the floor, so a
 * corrupt persisted value does not silently hand back a 1-segment plane.
 */
export function snapSubdivision(v: number): number {
  if (!Number.isFinite(v)) return SUBDIVISION_DEFAULT;
  if (v <= SUBDIVISION_MIN) return SUBDIVISION_MIN;
  if (v >= SUBDIVISION_MAX) return SUBDIVISION_MAX;
  return SUBDIVISION_STEPS[Math.round(Math.log2(v))];
}

/** The slider position for a value: the index of the stop it snaps to. */
export function subdivisionIndex(v: number): number {
  const snapped = snapSubdivision(v);
  const i = SUBDIVISION_STEPS.indexOf(snapped);
  return i === -1 ? SUBDIVISION_STEPS.indexOf(SUBDIVISION_DEFAULT) : i;
}

/** The value at a slider position, clamped so a junk index cannot escape. */
export function subdivisionAt(index: number): number {
  if (!Number.isFinite(index)) return SUBDIVISION_DEFAULT;
  const i = Math.max(0, Math.min(SUBDIVISION_STEPS.length - 1, Math.round(index)));
  return SUBDIVISION_STEPS[i];
}

/**
 * Read a persisted / imported value. It CLAMPS and SNAPS rather than resetting:
 * a value stored under the old 256 ceiling lands on 128 and an off-ladder 100
 * lands on 128, because either becoming 64 would read as the setting having
 * been lost. Only unparseable input falls back to the default.
 */
export function validateSubdivision(raw: string | null): number {
  const v = parseInt(raw ?? '', 10);
  if (Number.isNaN(v)) return SUBDIVISION_DEFAULT;
  return snapSubdivision(Math.max(SUBDIVISION_MIN, Math.min(SUBDIVISION_MAX, v)));
}
