/**
 * MODEL TEXTURE SOURCES — every picture still inside the loaded 3D model,
 * offered to the Image node's texture picker (the Phase 5 'model' kind that
 * `textureSources.ts` has declared since day one).
 *
 * WHY it exists: dropping a .glb as "Only Mesh" put its textures nowhere an
 * Image node could reach them — the file was kept whole as the preview mesh
 * and the picker only ever listed images some Image node already held. So a
 * model arrived with its own colour, normal and roughness maps and the answer
 * to "use that texture" was "find the original file on disk". A materials
 * build turns the textures it BUILDS into Image nodes (already offered, as
 * 'project'), which left the gap looking smaller than it was: it covers one of
 * the two import choices, and only the slots the builder honours.
 *
 * WHERE THE PIXELS COME FROM: `previewMesh.bytes`, the ONE copy of the model
 * the app keeps (store, mirrored to IndexedDB). It is re-read here on the
 * trusted side with the app's own strict reader, exactly as `createPreviewMesh`
 * already re-reads it on every drop, zip import and cache restore — no new
 * parser, no new trust boundary, and nothing new retained: this module holds no
 * state at all.
 *
 * WHAT IS THEREFORE NOT REACHABLE, and this is a real limit rather than an
 * oversight: after a "Mesh with Materials" build the preview copy is the
 * STRIPPED model (`gltfStrip.ts` removes the built materials' textures so the
 * project does not carry every picture twice). Those textures ARE reachable —
 * as the Image nodes the build made. What is gone from both is the handful the
 * builder never makes: occlusion (no Output channel takes one), an emissive map
 * whose factor is black, and anything the encoder skipped for the project
 * budget. Offering those too means keeping them in the stripped copy, which
 * grows every saved project by the pictures nobody asked for; the trade is
 * deliberate and is the one thing to revisit if a user reports it.
 *
 * SECURITY: an entry here is a description — an index, a name, a size — never
 * pixels. A cell's thumbnail and a pick's payload BOTH go through the import's
 * own encoder (`encodeGltfImages` → `encodeImageFile`), so what reaches an
 * `<img>` is a re-encoded `data:` URL that passes `validImageDataUrl`, with the
 * EXIF strip, the device cap and the project budget the drop path applies. Raw
 * model bytes never reach the DOM.
 *
 * Pure and node-tested: it takes a parsed report and returns a list.
 */
import { gltfImageFileName, type GltfModelReport, type GltfSlot } from './gltfReader';
import { dominantSlot } from './gltfImportPlan';
import type { GlbSlot } from './glbImportLimits';

/** A picture inside the loaded model. NOT a value to copy: it has to be
 *  materialised through the import pipeline before a node can hold it. */
export interface ModelTextureSource {
  readonly kind: 'model';
  /** The glTF image index — the identity, and what the encoder is asked for. */
  readonly image: number;
  /** The display name the import would give this picture's Image node. */
  readonly fileName: string;
  /** Header-declared pixel size, when the reader could read it (0 otherwise:
   *  the cell prints nothing rather than a guess). */
  readonly width: number;
  readonly height: number;
  /** Encoded size of the source, bytes — what the cell's title reports. */
  readonly byteLength: number;
  /** The most demanding slot this picture serves in the model, which is what
   *  the encoder is told (`slotEncodeClass`): a normal map must not be
   *  re-encoded with a colour slot's lossy settings. A picture no material
   *  references falls back to `baseColor` — it has no slot, and colour is the
   *  only class that can hold an arbitrary picture without lying about it. */
  readonly slot: GlbSlot;
}

/** The encoder handles these four; occlusion is not one of them (the Output
 *  has no ambient-occlusion channel), so an occlusion-only picture is encoded
 *  as colour. `glbSlotPolicy` answers null for occlusion, which would refuse
 *  the encode outright. */
function encodableSlot(slot: GltfSlot): GlbSlot | null {
  return slot === 'occlusion' ? null : slot;
}

/**
 * Every offerable picture of `m`, in first-appearance order.
 *
 * Offerable means the reader could actually read it: `status === 'ok'`, bytes
 * in hand, and a SNIFFED mime (never the declared one). Everything else —
 * a KTX2-only texture, an image referenced by URI, a damaged or oversized one
 * — is skipped, because there is nothing the encoder could do with it and a
 * cell that fails on click is worse than a cell that is not there.
 *
 * De-duplicated by IMAGE index, not by texture: two textures differing only in
 * sampler share one picture, and offering it twice would read as two.
 */
export function modelTextureSources(m: GltfModelReport, modelName: string): ModelTextureSource[] {
  /** image index → the most demanding slot it serves. */
  const slotOf = new Map<number, GlbSlot>();
  for (const mat of m.materials) {
    for (const ref of mat.slots) {
      const slot = encodableSlot(ref.slot);
      if (!slot) continue;
      const tex = m.textures[ref.texture];
      if (!tex || tex.extract.status !== 'ok') continue;
      const img = tex.extract.image;
      const prev = slotOf.get(img);
      slotOf.set(img, prev === undefined ? slot : dominantSlot(prev, slot));
    }
  }

  const out: ModelTextureSource[] = [];
  for (const img of m.images) {
    // The reader's own contract: bytes exist for 'ok' and 'unsupported-format',
    // and `mime` is non-null only for 'ok'. Both are checked rather than one
    // standing in for the other.
    if (img.status !== 'ok' || !img.bytes || !img.mime) continue;
    out.push({
      kind: 'model',
      image: img.index,
      fileName: gltfImageFileName(m, img.index, modelName),
      width: img.width && img.width > 0 ? img.width : 0,
      height: img.height && img.height > 0 ? img.height : 0,
      byteLength: img.byteLength,
      slot: slotOf.get(img.index) ?? 'baseColor',
    });
  }
  return out;
}

/**
 * A cheap subscription key for the loaded model, the `textureSourcesKey`
 * trick: the picker re-parses only when this string moves.
 *
 * The mesh's own `id` — monotonic per load, so a re-drop of the same file is a
 * new key and two different models can never share one. No bytes are read:
 * sampling or hashing a 64 MiB model to decide whether to parse it is the cost
 * this key exists to avoid. '' when there is no model to read.
 */
export function modelTextureKey(mesh: { id?: number; bytes?: Uint8Array } | null | undefined): string {
  if (!mesh?.bytes || mesh.bytes.byteLength === 0 || typeof mesh.id !== 'number') return '';
  return `#${mesh.id}`;
}
