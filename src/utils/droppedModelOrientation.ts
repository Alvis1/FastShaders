/**
 * "Match the model" for pictures dropped on the canvas TOGETHER with a model:
 * they are stored for THAT model (utils/pictureOrientation.ts), not the one on
 * screen. The preview shows the dropped model only after its own read — a
 * textured GLB only after its import dialog — long after the pictures are
 * encoded, so asking the store decided them against the PREVIOUS model: a GLB
 * dropped with its own texture got the app orientation (mirrored on the GLB,
 * and kept out of its material slots by the single-GLB export), and a picture
 * dropped with an OBJ over a UV-complete GLB got the glTF one.
 *
 * So the dropped file's own bytes are asked, through the trusted-side reader's
 * ONE keepable adapter (`gltfPreviewFacts`, utils/gltfReader.ts — the reader the
 * preview's `createPreviewMesh` runs on the same bytes), behind the preview's
 * own pre-read size gate at the larger cap an offered `.glb` gets: a file the
 * preview would refuse unread is not read here either. Kept out of
 * pictureOrientation.ts, whose predicate reads no bytes at all. Never throws.
 */
import { gltfPreviewFacts } from './gltfReader';
import { preReadModelGate } from './gltfCompression';
import { detectMeshKind, isGltfKind } from './previewMesh';

/** `'gltf'` when `model` is a glTF/GLB whose every drawn primitive carries TEXCOORD_0, else undefined. */
export async function droppedModelPictureOrientation(model: File): Promise<'gltf' | undefined> {
  try {
    const kind = detectMeshKind(model.name);
    if (!isGltfKind(kind)) return undefined;
    if (preReadModelGate(kind, model.size, true)) return undefined;
    const facts = gltfPreviewFacts(new Uint8Array(await model.arrayBuffer()), kind);
    return facts?.uv0 === 'all' ? 'gltf' : undefined;
  } catch {
    return undefined;
  }
}
