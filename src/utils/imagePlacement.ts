/**
 * The Image node's PLACEMENT — how its picture is mirrored, tiled, offset and
 * turned on the UVs — read in ONE place. graphToCode's image branch, the
 * restore fold below and the GLB export (engine/glbExportPlan.ts) take the
 * Flip thresholds, the stored Tile/Offset numbers and the turn's sign from
 * `readImagePlacement`, so they cannot drift apart.
 *
 * The chain, as graphToCode emits it (c = (½, ½)):
 *
 *   base → [legacy xf] → mirror → ×tile → +offset → turn ψ about c → texture()
 *
 *   base    a wired UV, else the splat point, else `uv(uvSet)`;
 *   xf      the LEGACY `xf*` keys (utils/imageUvMapping.ts), emitted for a node
 *           that still holds them — after a restore, only one the fold below
 *           cannot express (RESIDUE);
 *   mirror  `u → 1 − u` per axis, exactly where that axis's Flip box is
 *           ticked, in BOTH orientations — the card thumbnail's own rule.
 *           Nothing else mirrors: the app orientation's baked 1-u "correction"
 *           made every picture read MIRRORED on three's primitives and the
 *           Teapot (their UVs run u right, v up), and was removed 2026-10-08;
 *   tile    ×(tileX, tileY), then +(offsetX, offsetY): sockets, so a wired
 *           edge replaces the stored number in the emitter;
 *   turn    w = R(ψ)(s − c) + c (`turnMatrix`), ψ = θ·(exactly one Flip
 *           ticked ? −1 : 1) — `turnSignOf`, the ONE sign the reader, the KHR
 *           import, the fold and the export share. The factor is the mirror's
 *           determinant (ψ·det = θ), so a positive θ turns the picture the
 *           SAME way in every orientation × flip state on any one shape: on
 *           screen the sense is θ·sign(det uv→screen)·sign(tileX·tileY),
 *           COUNTER-clockwise on UVs that run u right and v up (the Sphere,
 *           Plane, Cube and Teapot, and the generated spherical UVs of the
 *           Bunny and of an OBJ without UVs) and clockwise on glTF (v-down)
 *           model UVs — the sign three.js's `Texture.rotation` and glTF's
 *           KHR_texture_transform `rotation` use, so a model's φ imports as
 *           θ = φ on an unflipped node. A negative Tile on
 *           one axis mirrors once more and reverses it: the import and the
 *           fold never write one (`storedPlacement` makes a negative scale
 *           that axis's Flip), but a Tile the user types negative stays.
 *           A wired Direction replaces the whole path, the turn included.
 *
 * KHR_texture_transform is T·R·S, so the turn has to come LAST, after the
 * tile, for an export to be exact; it pivots on the picture's centre, so a
 * clamped picture stays on the surface, and Offset keeps sliding along the
 * surface's X/Y. With Tile X ≠ Tile Y a turned picture stretches along the
 * surface axes — KHR's order, and the price of that exactness.
 *
 * Every read is the emitter's own: the flags and the stored numbers through
 * `valueNum` (a `Number()` that cannot throw), a non-finite one reading as the
 * default, the turn through `readPictureRotation`'s strict read. Imports only
 * the two leaves it is built on — never the store, and never edgeUtils, which
 * imports the store.
 */
import {
  readImageUvMapping,
  readPictureRotation,
  gltfUvMatrix,
  turnMatrix,
  turnSignOf,
  storedPlacement,
  snap,
  withPictureRotation,
  withoutLegacyTransform,
  MAX_UV_TRANSFORM_MAGNITUDE,
  type GltfUvTransform,
} from './imageUvMapping';
import { valueNum } from './valueCoerce';

export interface ImagePlacement {
  /** The bytes are stored top-down (`orientation: 'gltf'`). */
  readonly gltf: boolean;
  /** The two Flip boxes as TICKED — the threshold the card's thumbnail uses. */
  readonly flipX: boolean;
  readonly flipY: boolean;
  /** Whether each axis MIRRORS in the chain: exactly its ticked box, in both
   *  orientations (see the header). */
  readonly mirrorX: boolean;
  readonly mirrorY: boolean;
  /** The STORED Tile/Offset numbers; a wired socket overrides them in the emitter. */
  readonly tileX: number;
  readonly tileY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** θ: the stored turn in radians (`readPictureRotation`), 0 = none. */
  readonly theta: number;
  /** `turnSignOf`: (exactly one Flip ticked ? −1 : 1), the mirror's determinant. */
  readonly turnSign: 1 | -1;
  /** ψ = θ·turnSign: the turn the chain applies, `turnMatrix(psi)`. */
  readonly psi: number;
  /** The legacy KHR transform (`xf*`), null when absent or the identity. */
  readonly xf: GltfUvTransform | null;
}

/** A stored number the way the emitter reads it: `valueNum`, and the default
 *  when that is not finite. Plain property access — `values` may even be a
 *  primitive, and `in` would throw on one. */
function stored(values: unknown, key: string, dflt: number): number {
  const raw = values === null || values === undefined ? undefined : (values as Record<string, unknown>)[key];
  const v = valueNum(raw);
  return Number.isFinite(v) ? v : dflt;
}

/** THE placement read. Never throws, whatever `values` holds. */
export function readImagePlacement(values: Readonly<Record<string, unknown>>): ImagePlacement {
  const mapping = readImageUvMapping(values);
  const gltf = mapping.orientation === 'gltf';
  const flipX = stored(values, 'flipX', 0) >= 0.5;
  const flipY = stored(values, 'flipY', 0) >= 0.5;
  const theta = readPictureRotation(values);
  const turnSign = turnSignOf(flipX, flipY);
  return {
    gltf,
    flipX,
    flipY,
    // Each ticked box mirrors its axis, whatever the orientation — never a
    // baked default: the app's old `1-u` read mirrored on every primitive.
    mirrorX: flipX,
    mirrorY: flipY,
    tileX: stored(values, 'tileX', 1),
    tileY: stored(values, 'tileY', 1),
    offsetX: stored(values, 'offsetX', 0),
    offsetY: stored(values, 'offsetY', 0),
    theta,
    turnSign,
    // Never −0: an unturned node must read as exactly that.
    psi: theta === 0 ? 0 : theta * turnSign,
    xf: mapping.transform,
  };
}

/**
 * The chain at one UV point on the CPU, with the numbers graphToCode emits for
 * an UNWIRED node — the snapped legacy matrix, the mirror, the stored
 * tile/offset, the snapped turn. What the fold's recheck compares; Direction
 * is not modelled.
 */
export function placementAt(p: ImagePlacement, u: number, v: number): [number, number] {
  let x = u;
  let y = v;
  if (p.xf) {
    const m = gltfUvMatrix(p.xf);
    [x, y] = [m.m00 * x + m.m01 * y + m.tx, m.m10 * x + m.m11 * y + m.ty];
  }
  if (p.mirrorX) x = 1 - x;
  if (p.mirrorY) y = 1 - y;
  x = x * p.tileX + p.offsetX;
  y = y * p.tileY + p.offsetY;
  const t = turnMatrix(p.psi);
  return [t.m00 * x + t.m01 * y + t.tx, t.m10 * x + t.m11 * y + t.ty];
}

/** The four placement sockets, in registry order. */
export const PLACEMENT_SOCKETS = ['tileX', 'tileY', 'offsetX', 'offsetY'] as const;
export type PlacementSocket = (typeof PLACEMENT_SOCKETS)[number];

function isPlacementSocket(h: unknown): h is PlacementSocket {
  return h === 'tileX' || h === 'tileY' || h === 'offsetX' || h === 'offsetY';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Every node's WIRED placement sockets, in one pass over a graph: an edge into
 * one, or a collapsed group's boundary socket standing for one
 * (`collapsedInputs`, which `unwrapCollapsedGroupEdges` turns back into that
 * edge for codegen). A LOCAL scan of the arrays as handed in — the restore
 * paths run it before anything else has repaired them, so every element is
 * read as unknown — keyed in a `Map`, since the ids come from files. A
 * boundary list on any node counts, collapsed or not: a blocked fold costs
 * nothing, a fold past a wire would change the picture. Only nodes with at
 * least one wired socket get an entry.
 */
export function wiredPlacementIndex(
  edges: readonly unknown[],
  nodes: readonly unknown[],
): Map<string, Set<PlacementSocket>> {
  const index = new Map<string, Set<PlacementSocket>>();
  const add = (nodeId: unknown, handle: unknown): void => {
    if (typeof nodeId !== 'string' || !isPlacementSocket(handle)) return;
    const set = index.get(nodeId);
    if (set) set.add(handle);
    else index.set(nodeId, new Set([handle]));
  };
  if (Array.isArray(edges)) {
    for (const e of edges) if (isObject(e)) add(e.target, e.targetHandle);
  }
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      const inputs = isObject(n) && isObject(n.data) ? n.data.collapsedInputs : undefined;
      if (!Array.isArray(inputs)) continue;
      for (const s of inputs) if (isObject(s)) add(s.originalNodeId, s.originalHandleId);
    }
  }
  return index;
}

/** The wired placement sockets of ONE node (see `wiredPlacementIndex`). */
export function wiredPlacementSockets(
  nodeId: string,
  edges: readonly unknown[],
  nodes: readonly unknown[],
): Set<PlacementSocket> {
  return wiredPlacementIndex(edges, nodes).get(nodeId) ?? new Set<PlacementSocket>();
}

/** One way to write the legacy transform as a turn β after the tile K'. */
interface FoldRow {
  readonly beta: number;
  readonly kx: number;
  readonly ky: number;
}

/** Three non-collinear points: two affine maps that agree on them agree everywhere. */
const RECHECK_POINTS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [0, 1]];

/**
 * Fold a node's legacy `xf*` transform into Tile, Offset and Rotation, keeping
 * its Flips except where a tile would turn negative — EXACTLY, or not at all.
 * Run on every restore path, inside `sanitizeImageNodes`, never from a menu or
 * an effect.
 *
 * Today's chain is K∘(D·(M·s + t) + e) + o, then the node's own turn, where
 * M = R(θx)·S is the xf's matrix (`gltfUvMatrix`), t its offset, D = diag(dx,
 * dy) and e = (ex, ey) the mirror (dx = −1, ex = 1 on a mirrored axis), K the
 * tile and o the offset. Since D·R(θ)·D = R(σθ) with σ = dx·dy, its linear
 * part is R(ψ)·K·R(σθx)·S·D, and folding needs R(β)·K' = K·R(σθx)·S — whose
 * columns are orthogonal only on these rows (cθ, sθ snapped; the first that
 * holds wins):
 *
 *   sθ = 0, cθ = −1   β = σθx, K' = K∘S   a half turn, kept as a Rotation
 *   sθ = 0            β = 0,   K' = cθ·K∘S
 *   kx = ky           β = σθx, K' = K∘S
 *   kx = −ky          β = −σθx, K' = K∘S
 *   cθ = 0            β = σθx, K' = (ky·sx, kx·sy)
 *
 * The half-turn row is a choice: −1·K∘S is just as exact, but a half turn
 * then reads as two negative tiles — both Flips toggled, once stored — and
 * folds to something other than what importing the same KHR transform
 * writes. It is only PREFERRED — if its recheck fails, the −1·K∘S row is tried
 * next.
 *
 * With Q = K∘(D·t + e) + o, the constant part gives
 *   o' = Q − K'∘e + (R(−β)(Q − c) − (Q − c)),   ψ' = ψ + β,
 * and the node stores that through `storedPlacement`, as the KHR import does:
 * a negative K' becomes that axis's Flip toggled, tile |k| and offset o' + k,
 * and θ' = ψ'·turnSignOf(the resulting Flips) — (θ + turnSign·β) mod 2π when
 * no Flip moves — so a fold never WRITES a negative tile (a node's own
 * negative tile under a legacy transform included). S and t are read off the
 * SNAPPED matrix when sθ = 0, so a pure-scale fold with no negative scale
 * re-emits the very digits the legacy stage did — an unedited, unrotated KHR
 * import keeps its bytes (`uv().mul(vec2(2, 2)).add(vec2(0.25, 0))`).
 *
 * The node stays RESIDUE — the SAME object comes back, legacy keys and all,
 * and it emits as it always did — when a placement socket is wired
 * (`wiredPlacementSockets`), when no row holds (an uneven tile under an
 * oblique turn: exactly where today's GLB export is already inexact), when a
 * result is non-finite or past 1e6, or when the old and new chains differ by
 * more than 1e-9 (relative to the numbers involved) at (0,0), (1,0) or (0,1).
 * A folded node holds no `xf*` key, so a second run returns it unchanged.
 */
export function foldLegacyUvTransform(
  values: Record<string, string | number>,
  wired: boolean,
): Record<string, string | number> {
  const p = readImagePlacement(values);
  const xf = p.xf;
  if (!xf || wired) return values;

  const dx = p.mirrorX ? -1 : 1;
  const dy = p.mirrorY ? -1 : 1;
  const sigma = dx * dy;
  const m = gltfUvMatrix(xf);
  const thx = xf.rotation % (2 * Math.PI);
  const own = turnMatrix(thx);
  const cs = own.m00;
  const sn = own.m01;
  const sx = sn === 0 ? m.m00 / cs : xf.scaleX;
  const sy = sn === 0 ? m.m11 / cs : xf.scaleY;
  const kx = p.tileX;
  const ky = p.tileY;

  const rows: FoldRow[] = [];
  if (sn === 0) {
    if (cs === -1) rows.push({ beta: sigma * thx, kx: kx * sx, ky: ky * sy });
    rows.push({ beta: 0, kx: cs * kx * sx, ky: cs * ky * sy });
  } else if (kx === ky) {
    rows.push({ beta: sigma * thx, kx: kx * sx, ky: ky * sy });
  } else if (kx === -ky) {
    rows.push({ beta: -sigma * thx, kx: kx * sx, ky: ky * sy });
  } else if (cs === 0) {
    rows.push({ beta: sigma * thx, kx: ky * sx, ky: kx * sy });
  }
  for (const row of rows) {
    const folded = foldWith(values, p, m.tx, m.ty, row);
    if (folded) return folded;
  }
  return values;
}

/** One row of the fold, written and rechecked; null when it does not hold. */
function foldWith(
  values: Record<string, string | number>,
  p: ImagePlacement,
  tx: number,
  ty: number,
  row: FoldRow,
): Record<string, string | number> | null {
  const ex = p.mirrorX ? 1 : 0;
  const ey = p.mirrorY ? 1 : 0;
  const qx = p.tileX * ((p.mirrorX ? -1 : 1) * tx + ex) + p.offsetX;
  const qy = p.tileY * ((p.mirrorY ? -1 : 1) * ty + ey) + p.offsetY;
  const tileX = snap(row.kx);
  const tileY = snap(row.ky);
  // R(−β)(Q − c) − (Q − c): the offset that keeps the picture where the turn
  // about c would otherwise move it.
  const back = turnMatrix(-row.beta);
  const cx = qx - 0.5;
  const cy = qy - 0.5;
  const s = storedPlacement({
    flipX: p.flipX,
    flipY: p.flipY,
    tileX,
    tileY,
    offsetX: snap(qx - tileX * ex + (back.m00 * cx + back.m01 * cy - cx)),
    offsetY: snap(qy - tileY * ey + (back.m10 * cx + back.m11 * cy - cy)),
    psi: p.psi + row.beta,
  });
  const written = [s.tileX, s.tileY, s.offsetX, s.offsetY];
  if (!written.every((n) => Number.isFinite(n) && Math.abs(n) <= MAX_UV_TRANSFORM_MAGNITUDE)) return null;

  const placed: Record<string, string | number> = withoutLegacyTransform(values);
  // A Flip the fold toggled is written the way the menu's checkbox writes it;
  // one it left alone keeps whatever the file held.
  if (s.flipX !== p.flipX) placed.flipX = s.flipX ? 1 : 0;
  if (s.flipY !== p.flipY) placed.flipY = s.flipY ? 1 : 0;
  Object.assign(placed, { tileX: s.tileX, tileY: s.tileY, offsetX: s.offsetX, offsetY: s.offsetY });
  const next = withPictureRotation(placed, s.theta);
  const after = readImagePlacement(next);
  // Relative to the numbers involved: float error grows with them, a wrong
  // fold does not hide behind them.
  const tol = 1e-9 * Math.max(1, ...written.map(Math.abs), Math.abs(qx), Math.abs(qy));
  for (const [u, v] of RECHECK_POINTS) {
    const was = placementAt(p, u, v);
    const now = placementAt(after, u, v);
    if (!(Math.abs(was[0] - now[0]) <= tol && Math.abs(was[1] - now[1]) <= tol)) return null;
  }
  return next;
}
