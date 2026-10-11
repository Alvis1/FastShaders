/**
 * Which way round a picture added from a FILE is stored — "Match the model"
 * (owner, 2026-10-09).
 *
 * glTF stores TEXCOORD_0 v-DOWN (its UV origin is the picture's top-left
 * corner), while three's primitives, the Utah Teapot, an OBJ's `vt` and the
 * spherical UVs the preview generates for a model without its own all run
 * v-UP. An Image node's `orientation` is the one key that says which a picture
 * is stored for (`'gltf'` = `Texture.flipY = false`, utils/imageUvMapping.ts).
 * A model's own textures always carry `'gltf'` (the GLB import and the
 * model-texture pick write it). A picture from a file carried the app
 * orientation everywhere, so on a glTF model's own UVs it read mirrored top to
 * bottom until Flip Y was ticked, and the single-GLB export kept it out of the
 * model's material slots (`not-gltf-oriented`, engine/glbExportPlan.ts).
 *
 * So a picture added from a file while the 3D pane SHOWS a glTF/GLB model
 * whose every drawn primitive carries TEXCOORD_0 is stored the glTF way. It is
 * decided ONCE, when the picture is written into its node, by every path that
 * brings a file's bytes into an Image node: the canvas drop (NodeEditor
 * `placeImageFile`), that drop's "Add anyway" (the store's
 * `resolveLimitNotice`, re-encoded or not) and "From file…" (ImageNodeSettings
 * `fillImageNodeFromFile`, its own "Add anyway" included). The Texture picker
 * asks it too, for the one pick with no orientation to copy: a payload its
 * holders store BOTH ways — this rule's own doing, one file added under two
 * models (`pickTextureValues`, utils/textureSources.ts). A later model change
 * never rewrites a stored value — Flip Y puts the picture right on another
 * shape. Study sessions included: no study rule pins the orientation.
 *
 * Two exceptions, each a picture whose right frame is known better:
 *   - "From file…" into a node whose Flip Y is TICKED keeps the node's own
 *     orientation (`replacementPictureOrientation`). The tick was set against
 *     it — before this rule it was the documented way to put a picture right
 *     on a glTF model — so a new orientation under it mirrored the replacement.
 *   - Pictures dropped TOGETHER with a model are decided against THAT model
 *     (utils/droppedModelOrientation.ts), not the one on screen: the preview
 *     shows the dropped model only after its own read, and a textured GLB only
 *     after its import dialog, long after the pictures are encoded.
 *
 * Trusted-side facts only: `PreviewMesh.gltf.uv0`, which the glTF reader
 * derives inside the ONE read `createPreviewMesh` already makes (no second
 * parse here, and never the sandbox's forgeable mesh inventory). Everything
 * else answers false — the app orientation, values
 * byte-identical to before: a built-in shape or the Raymarch window on screen
 * (`shownPreviewMesh`), an OBJ (with or without `vt`), a Gaussian splat, a glTF
 * without TEXCOORD_0 or with it on only SOME primitives (no one orientation is
 * right on every part), a glTF the strict reader refused (`gltf: null`), and no
 * model at all. Every read is a typeof-checked plain property access on store
 * state, so a malformed facts object answers false rather than throwing.
 *
 * A picture sampled only as a SKY (a wired Direction, or only an Output's
 * Environment) ignores the stored orientation at emission (graphToCode's
 * `imageSampledOnlyAsSky`): a panorama has no mesh UVs to match.
 */
import { shownPreviewMesh } from './outputMaterials';
import { isGltfKind } from './previewMesh';
import { readImagePlacement } from './imagePlacement';
import { readImageUvMapping } from './imageUvMapping';

/** The two store fields the answer reads — `useAppStore.getState()` fits. */
export interface PictureOrientationState {
  previewMesh: unknown;
  previewShowsModel?: boolean;
}

/** Does the 3D pane show a glTF/GLB model drawn entirely on its OWN UVs? */
export function previewShowsGltfUvs(state: PictureOrientationState): boolean {
  const pm = shownPreviewMesh(state);
  if (!pm || typeof pm !== 'object') return false;
  if (!isGltfKind((pm as { kind?: unknown }).kind)) return false;
  const facts: unknown = (pm as { gltf?: unknown }).gltf;
  if (!facts || typeof facts !== 'object') return false;
  return (facts as { uv0?: unknown }).uv0 === 'all';
}

/**
 * The `orientation` a picture added from a file is stored with: `'gltf'` over
 * a glTF model's own UVs, else undefined — no key, the app orientation.
 * Exactly what `makeImageNodeFromEncode` and `withImagePayload` take.
 */
export function filePictureOrientation(state: PictureOrientationState): 'gltf' | undefined {
  return previewShowsGltfUvs(state) ? 'gltf' : undefined;
}

/**
 * The `orientation` "From file…" gives the picture it writes into an EXISTING
 * node (`current` = that node's values): the file rule above — unless the
 * node's Flip Y is ticked, in which case the node keeps its own orientation.
 * App orientation + Flip Y reads exactly as the glTF orientation without it,
 * so storing `'gltf'` under the tick turned the replacement upside down on the
 * very model the tick had put the old picture right on.
 */
export function replacementPictureOrientation(
  state: PictureOrientationState,
  current: Readonly<Record<string, unknown>>,
): 'gltf' | undefined {
  if (readImagePlacement(current).flipY) return readImageUvMapping(current).orientation === 'gltf' ? 'gltf' : undefined;
  return filePictureOrientation(state);
}
