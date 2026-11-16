/**
 * Model-space position bound: the built-in shapes are NOT fitted (the sphere
 * has radius 1, the plane is 2 × 2, the cube ±0.7) and fit-bounds puts the
 * teapot, the bunny and a splat within ±0.8 — ±1 holds for all of them. Not
 * for a DROPPED model, which keeps its own units since 2026-11-16 (fit-bounds
 * `keepScale`, the camera scales instead), nor positionLocal under a
 * displacement or inside a raymarch scope (docs/dev/codegen.md).
 *
 * A LEAF with two readers that must agree: cpuEvaluator's range for Position
 * (`analyticalRange`), and a noise card's window when its `pos` is unwired —
 * which IS Position — so the card shows the span the default sphere samples.
 */
export const MODEL_POSITION_BOUND = 1;
