/**
 * ONE clock for every animated editor surface — and it is the 3D VIEW'S clock.
 *
 * Each rAF loop used to mint its own epoch (`startTime = first frame's
 * timestamp`), so `t` meant "seconds since THIS component's loop started": a
 * sin card whose loop had run 48 s showed sin(48.3) while the edge info chip —
 * whose loop starts on hover — evaluated the same wire at t ≈ 0.15. No two
 * surfaces could agree except by coincidence, and cpuEvaluator's per-time
 * cache buckets were never shared between surfaces (each loop's per-frame
 * times differ, which is exactly the situation its bucket comment describes).
 *
 * All loops now derive t from this module's zero. rAF callbacks in the same
 * frame receive the SAME timestamp, so every surface evaluates at an identical
 * t per frame — one shared cache bucket per frame instead of one per surface.
 *
 * Since 2026-11-16 that zero is the SHADER's (owner: "the noise node visual
 * does not sync with the iframe"). The sandboxed preview's `time` is three's
 * NodeFrame clock — wall seconds since ITS document's first frame, restarted
 * at 0 by every cold rebuild (a Model change, the backend toggle) — while this
 * clock started at app load, so a noise card, a sin card and the Time hand ran
 * ahead of the mesh by an amount that grew with every rebuild. The stage now
 * reports the wall instant its `time` read 0 (`fs:shader-clock`, see
 * SHADER_CLOCK_SCRIPT in tslToPreviewHTML.ts) and ShaderPreview hands it to
 * `followShaderClock`, so `appTime()` IS the shader's `time` to within a frame.
 * Until a stage reports (boot, the embed, which has no preview), t counts from
 * app load as before. Hot swaps keep the stage's clock; a cold rebuild resets
 * it and every editor surface jumps back with the mesh, which is the point.
 */
const EPOCH = performance.now();

/** Where t = 0 sits on THIS document's `performance.now()` timeline. */
let zero = EPOCH;

/**
 * Seconds since the shader's `time` was 0 (since app start until a stage has
 * reported). Inside a rAF loop pass the callback's timestamp (same timeline
 * as performance.now(), and identical across every callback of one frame);
 * call bare elsewhere.
 */
export function appTime(rafTimestamp: number = performance.now()): number {
  return (rafTimestamp - zero) / 1000;
}

/**
 * The longest shader clock believed: 115 days. The preview never folds its
 * `time` (podest does), so a real document cannot get there; the bound only
 * keeps a forged report from handing every surface an astronomical t.
 */
const MAX_SHADER_SECONDS = 1e7;
/** A zero up to 1 s in the FUTURE is clock skew between the two documents'
 *  `performance.timeOrigin`s on a freshly booted stage; more is a forgery. */
const MAX_FUTURE_MS = 1000;

/**
 * Follow the 3D view's clock: `shaderZeroMs` is the wall instant
 * (`performance.timeOrigin`-based, milliseconds) at which the stage's `time`
 * read 0. The message is FORGEABLE — the stage runs the user's shader — so
 * anything but a plausible finite number is ignored; what it can move is
 * display-only (which t the editor's cards draw). Returns whether it was taken.
 */
export function followShaderClock(shaderZeroMs: unknown): boolean {
  if (typeof shaderZeroMs !== 'number' || !Number.isFinite(shaderZeroMs)) return false;
  const local = shaderZeroMs - performance.timeOrigin;
  const ageMs = performance.now() - local;
  if (!(ageMs >= -MAX_FUTURE_MS && ageMs <= MAX_SHADER_SECONDS * 1000)) return false;
  zero = local;
  return true;
}
