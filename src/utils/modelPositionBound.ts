/**
 * Model-space position bound: the built-in shapes are NOT fitted (the sphere
 * has radius 1, the plane is 2 × 2, the cube ±0.7) and fit-bounds puts a
 * dropped model, the teapot and a splat within ±0.8 — ±1 holds for all of
 * them. Not for a skinned or animated model (fit-bounds scales its root, so
 * its positions stay in authored units), nor positionLocal under a
 * displacement or inside a raymarch scope (docs/dev/codegen.md).
 *
 * A LEAF with two readers that must agree: cpuEvaluator's range for Position
 * (`analyticalRange`), and a noise card's window when its `pos` is unwired —
 * which IS Position — so the card shows the span the default sphere samples.
 */
export const MODEL_POSITION_BOUND = 1;
