/**
 * The GLB import's LIMITS and its SLOT TABLE (GLB Phase 5): the numbers the
 * build-from-materials path is held to, in ONE place, for the builder (Step 8)
 * and the dialog's estimate (Step 9) alike.
 *
 * A LEAF that imports NOTHING, on purpose. The store reads
 * `ALLOW_MANY_MATERIALS_KEY` at MODULE SCOPE, and anything reachable from
 * the store's own import cycle (outputMaterials → exposedPorts → edgeUtils →
 * useAppStore) would put that read across the cycle during initialisation —
 * the costTable TDZ failure (utils/costTable.ts's head comment). Nothing here
 * may import, not even a type: `glbImportLimits.test.ts` pins it.
 *
 * Two corrections to the specs it came from (integration plan §3.10):
 *   - ONE slot table, holding the higher, conservative bits-per-pixel of the
 *     two drafts in each column (colour 1.5, normal lossless 7.5, ORM lossless
 *     6, a data map from a lossy source 1.8). The figures are INFERRED from
 *     the research doc's libwebp-CLI measurements (a 1024² lossless normal at
 *     0.9–1.2M chars is 5.2–6.9 bpp), erring high, and must be re-measured with
 *     the Chrome and WebKit encoders before shipping: an underestimate is the
 *     dangerous direction, since the builder then meets a budget the dialog
 *     promised it would not.
 *   - The Import-at ladder starts at 1024, the largest slot cap: a 2048 rung
 *     could never differ from "full".
 *
 * Deliberately NOT here: the pre-read cap (`GLB_READ_MAX_BYTES`, the ONE copy
 * lives in gltfCompression.ts beside the gate that uses it) and the side an
 * unreadable texture is assumed to have (`UNTRUSTED_TEXTURE_SIDE`, in
 * textureMemory.ts, which the dialog's estimate imports).
 *
 * Owner rules this table encodes (integration plan §5, Q12): colour is stored
 * LOSSY at up to 1024 px, even from a PNG; a normal or ORM map at up to 512 px,
 * LOSSLESS-ONLY when its source is lossless (it halves rather than going lossy)
 * and lossy from a JPEG source. Ignore-limits lifts the BUDGETS, never these
 * slot sizes — which is why `encodeImageFile`'s `maxDim` is applied after the
 * ignore-limits cap and is not relaxed by it.
 */

/** The toolbar setting that lets a model with more than
 *  `GLB_IMPORT_MATERIAL_LIMIT` materials build sections (N11). A study
 *  CONDITION, not a preference: reset by `cleanSlateForStudy`. Only the exact
 *  string `'1'` is on (`allowManyMaterialsFrom`). */
export const ALLOW_MANY_MATERIALS_KEY = 'fs:allowManyMaterials';

/** How many buildable glTF materials a model may have before the dialog
 *  refuses to build it without the setting above (N11; the count is the
 *  reader's `buildableMaterialIndices`). The hard ceiling past it is
 *  `MAX_INDEX_MATERIALS`, the editor's own section cap. */
export const GLB_IMPORT_MATERIAL_LIMIT = 10;

/** The "Import at {res} px" rungs, largest first: the dialog offers the
 *  largest one whose estimate fits the image budget. */
export const IMPORT_AT_LADDER = [1024, 512, 256, 128] as const;

/** The material slots the builder BUILDS. Occlusion is deliberately absent:
 *  the Output node has no ambient-occlusion channel, so an occlusion texture
 *  is reported ("not imported"), never encoded, and `glbSlotPolicy` answers
 *  null for it — an ORM image shared with metallicRoughness is priced once,
 *  under that slot. */
export type GlbSlot = 'baseColor' | 'emissive' | 'normal' | 'metallicRoughness';

export interface GlbSlotPolicy {
  /** The long-side cap an extracted texture of this slot is stored at. */
  readonly maxDim: number;
  /** A colour slot: stored lossy (and mipmapped); never lossless-only. */
  readonly colour: boolean;
  /** Estimated bits per pixel when stored lossless (a data map from a lossless
   *  source). Equal to `lossyBpp` for a colour slot, which is never lossless. */
  readonly losslessBpp: number;
  /** Estimated bits per pixel when stored lossy. */
  readonly lossyBpp: number;
}

const COLOUR_POLICY: GlbSlotPolicy = Object.freeze({ maxDim: 1024, colour: true, losslessBpp: 1.5, lossyBpp: 1.5 });
const NORMAL_POLICY: GlbSlotPolicy = Object.freeze({ maxDim: 512, colour: false, losslessBpp: 7.5, lossyBpp: 1.8 });
const ORM_POLICY: GlbSlotPolicy = Object.freeze({ maxDim: 512, colour: false, losslessBpp: 6, lossyBpp: 1.8 });

/** The policy for one slot, or null for anything that is not a built slot.
 *  A `switch` over literals, never a Record lookup: a slot name can be
 *  derived from a file, and a plain object answers `constructor` and
 *  `__proto__`. The objects are frozen and shared. */
export function glbSlotPolicy(slot: unknown): GlbSlotPolicy | null {
  switch (slot) {
    case 'baseColor':
    case 'emissive':
      return COLOUR_POLICY;
    case 'normal':
      return NORMAL_POLICY;
    case 'metallicRoughness':
      return ORM_POLICY;
    default:
      return null;
  }
}

/** Read the stored setting: on only for the exact string `'1'` (validated,
 *  never coerced — localStorage is writable by anything at this origin). */
export function allowManyMaterialsFrom(raw: unknown): boolean {
  return raw === '1';
}
