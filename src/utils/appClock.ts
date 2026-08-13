/**
 * ONE clock for every animated editor surface.
 *
 * Each rAF loop used to mint its own epoch (`startTime = first frame's
 * timestamp`), so `t` meant "seconds since THIS component's loop started": a
 * sin card whose loop had run 48 s showed sin(48.3) while the edge info chip —
 * whose loop starts on hover — evaluated the same wire at t ≈ 0.15. No two
 * surfaces could agree except by coincidence, and cpuEvaluator's per-time
 * cache buckets were never shared between surfaces (each loop's per-frame
 * times differ, which is exactly the situation its bucket comment describes).
 *
 * All loops now derive t from this module-scope epoch. rAF callbacks in the
 * same frame receive the SAME timestamp, so every surface evaluates at an
 * identical t per frame — one shared cache bucket per frame instead of one
 * per surface.
 *
 * The 3D preview is deliberately out of scope: it runs three's own clock
 * inside a sandboxed iframe that rebuilds on every edit, so editor surfaces
 * agree with each other, not with the GPU.
 */
const EPOCH = performance.now();

/**
 * Seconds since app start. Inside a rAF loop pass the callback's timestamp
 * (same timeline as performance.now(), and identical across every callback
 * of one frame); call bare elsewhere.
 */
export function appTime(rafTimestamp: number = performance.now()): number {
  return (rafTimestamp - EPOCH) / 1000;
}
