/**
 * The Fresnel node's CPU twin (LEAF). `fsFresnel` (engine/moduleHelpers.ts)
 * operation for operation — Cycles `fresnel_dielectric_cos` with η clamped to
 * [1e-5, 1e4] and the `max(g + c, 1e-6)` guard — so the card's number and the
 * shader agree. engine/fresnelNode.test.ts holds both against a transcription
 * of Cycles.
 */

/** fsFresnel on the CPU, operation for operation: [Fresnel, Facing] for |N·V| = c. */
export function fresnelFacing(c: number, ior: number, front = true): [number, number] {
  const e = Math.min(Math.max(ior, 1e-5), 1e4);
  const r = front ? e : 1 / e;
  const cc = Math.abs(c);
  const g2 = r * r - 1 + cc * cc;
  const g = Math.sqrt(Math.max(g2, 0));
  const a = (g - cc) / Math.max(g + cc, 1e-6);
  const b = (cc * (g + cc) - 1) / (cc * (g - cc) + 1);
  return [g2 > 0 ? 0.5 * a * a * (1 + b * b) : 1, 1 - cc];
}
