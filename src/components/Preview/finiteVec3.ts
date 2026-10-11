/**
 * The ONE validator for an `{x, y, z}` the preview gets from somewhere it does
 * not control: a stage report (`fs:camera`, `fs:rotation`) or a stored
 * preference (`fs:previewCameraPos`, `fs:previewRotation`).
 *
 * Both sources are adversarial. The sandboxed document runs the loaded shader,
 * so its reports are forgeable, and a `.fastshader` writes the stored keys. The
 * old check was `typeof x === 'number'`, which NaN and Infinity both pass:
 *
 *   - A forged `{type:'fs:rotation', x:NaN}` was stored, and the next cold
 *     rebuild baked `rotation="NaN 0 0"` into the document. The model's world
 *     matrix went NaN, so the model vanished. It stayed gone across Reset, a
 *     Model change and opening another shader, until Play or a reload
 *     (measured in the real app, review 2026-10-11).
 *   - A stored `{"x":1e999}` parses to Infinity, and the turntable's
 *     `mod360(Infinity)` is NaN, which poisons it the same way.
 *
 * `Number.isFinite` is false for every non-number, so it also covers the
 * `typeof` check it replaces. The result is always a FRESH object holding only
 * the three numbers, so no extra field of a report or a stored value travels
 * on. "Validated, never coerced": a numeric string is rejected, never parsed
 * (storage-and-limits.md).
 *
 * A LEAF: one type-only import.
 */
import type { CameraPosition } from '@/engine/tslToPreviewHTML';

export function finiteVec3(p: unknown): CameraPosition | null {
  if (typeof p !== 'object' || p === null) return null;
  const { x, y, z } = p as { x?: unknown; y?: unknown; z?: unknown };
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x: x as number, y: y as number, z: z as number };
}

/**
 * A camera this close to the origin is not one the user put there. The orbit
 * controls stop at `minDistance: 2` (tslToPreviewHTML's scene), and an old bug
 * saved (0, 0, 0) on every frame by reading the camera-entity wrapper instead
 * of the camera. Restoring it would put the camera inside the mesh. The stored
 * position on reload and the live `fs:camera` report both use this test.
 */
export function cameraTooClose(p: CameraPosition): boolean {
  return Math.hypot(p.x, p.y, p.z) < 1;
}

/**
 * How far from the origin a reported orbit TARGET may sit and still be kept.
 * The controls pan without a limit, but the previewed object is 1.6 units
 * across and the camera stops at `maxDistance: 80`; a target past this is not
 * a pan anyone made. A forged one (the report is forgeable like the rest)
 * would aim every later document of the session at nothing.
 */
export const MAX_CAMERA_TARGET_RADIUS = 100;

/**
 * The orbit target of an `fs:camera` report (`tx`, `ty`, `tz`), validated like
 * the position: three finite numbers, within MAX_CAMERA_TARGET_RADIUS. Null
 * otherwise, which restores the controls' own target (the origin).
 */
export function cameraTarget(report: unknown): CameraPosition | null {
  if (typeof report !== 'object' || report === null) return null;
  const { tx, ty, tz } = report as { tx?: unknown; ty?: unknown; tz?: unknown };
  const t = finiteVec3({ x: tx, y: ty, z: tz });
  return t && Math.hypot(t.x, t.y, t.z) <= MAX_CAMERA_TARGET_RADIUS ? t : null;
}
