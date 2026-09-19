import { t } from '@/i18n';
import type { Language } from '@/i18n';
import { fillMeshRefusal, modelTooLargeRefusal, type MeshRefusal } from './previewMesh';
import type { GltfImageStatus, GltfReadRefusal, GltfReadRefusalReason } from './gltfReader';
import { fillTemplate } from './fillTemplate';
import { formatMiB } from './formatSize';
import { DecoderLoadError, MAX_DECODER_FILE_BYTES, type DecoderNeeds } from './meshDecoders';

/**
 * The translated wording for the 3D model notices — the one place a
 * `MeshRefusal` becomes a sentence in the reader's language (the
 * soundStatusMessage.ts precedent: a utils module that owns shared wording and
 * imports `t`). It is a separate module so `previewMesh.ts`, which the store,
 * the engine and FeedbackModal import, takes no i18n VALUE import.
 *
 * Each key below is the English text AND its lv.json `ui` key, so a reword
 * must move the lv.json entry with it.
 */

/** Shown (as an info line, not an error) when a KTX2 transcode failed and the
 *  loader's plugin fell back to the texture's own PNG/JPEG image. */
export const MESH_KTX2_FALLBACK_KEY = "This model's KTX2 textures are shown with their fallback images.";

/** Shown (as an info line) when a KTX2 texture could not be decoded AND had no
 *  fallback image, so the material renders without it. */
export const MESH_KTX2_MISSING_KEY = "Some of this model's KTX2 textures could not be decoded and are not shown.";

/** Shown when saving the model on screen to the IndexedDB cache hit the quota. */
export const MESH_CACHE_FULL_KEY = 'This 3D model will not be restored after a reload — browser storage is full.';

/**
 * Shown in the preview's overlay when the decoder a compressed model needs
 * could not be fetched (utils/meshDecoders.ts). `{ext}` is Draco, meshopt or
 * KTX2, never translated; `{reason}` is the fetch's own error text, or one of
 * the two reasons below.
 */
export const MESH_DECODER_LOAD_KEY = 'Could not load the {ext} decoder ({reason}). Reload to retry.';

/** The two `{reason}`s the app writes itself (a `DecoderLoadError`'s `kind`),
 *  so a Latvian sentence does not carry an English clause. An HTTP status line
 *  or the engine's own fetch error is inserted as it came. */
export const MESH_DECODER_EMPTY_KEY = 'the file is empty';
export const MESH_DECODER_TOO_LARGE_KEY = 'the file is over {mb} MB';

/**
 * A decoder fetch failure as a sentence in `lang`. `loadDecoderPayload` always
 * rejects with a `DecoderLoadError`; anything else is named after the first
 * decoder the model needed, with its own text as the reason.
 */
export function decoderLoadMessage(err: unknown, needs: DecoderNeeds, lang: Language): string {
  const ext = err instanceof DecoderLoadError
    ? err.ext
    : needs.draco ? 'Draco' : needs.meshopt ? 'meshopt' : 'KTX2';
  let reason: string;
  if (err instanceof DecoderLoadError) {
    if (err.kind === 'empty') reason = t(MESH_DECODER_EMPTY_KEY, lang);
    else if (err.kind === 'too-large') {
      reason = fillTemplate(t(MESH_DECODER_TOO_LARGE_KEY, lang), { mb: formatMiB(MAX_DECODER_FILE_BYTES, lang) });
    } else reason = err.reason;
  }
  else if (err instanceof Error && err.message) reason = err.message;
  else reason = String(err);
  return fillTemplate(t(MESH_DECODER_LOAD_KEY, lang), { ext, reason });
}

/**
 * A model refusal as a sentence in `lang`: its key translated, then filled.
 *
 * `{limit}` — the cap that was APPLIED, on the one key that carries it — is
 * filled HERE and not in `fillMeshRefusal`, which fills `{name}`/`{ext}`/
 * `{size}` only. That is two passes, and the ORDER is what keeps fillTemplate's
 * single-pass promise: this one inserts a formatted NUMBER, which cannot spell a
 * placeholder, and the file name — the only value whoever made the file chose —
 * is inserted by the second pass and never rescanned.
 * The limit rounds to NEAREST rather than up: every cap is a whole number of MiB
 * so the two agree today, and rounding a CAP up would claim more room than is
 * actually enforced (the 'up' rule is for the measured size beside it, so one
 * byte over never prints equal to the limit).
 */
export function meshRefusalMessage(r: MeshRefusal, lang: Language): string {
  const template = t(r.key, lang);
  return fillMeshRefusal(
    r,
    r.limitBytes === undefined ? template : fillTemplate(template, { limit: formatMiB(r.limitBytes, lang, 'nearest') }),
    lang,
  );
}

/* ── the glTF model reader's refusals and skips (Phase 5) ────────────────── */

/**
 * Why a model's materials cannot be BUILT into a shader. The model itself may
 * still load model-only (a reader refusal withdraws the build, never the drop),
 * so P5c shows this as an INFO line. `{name}` is the file name, quoted by
 * `gltfBuildRefusalMessage`; `{reason}` is one of the sentences below.
 */
export const GLTF_BUILD_REFUSED_KEY = "Can't build a shader from the materials of {name}. {reason}";

/**
 * The `{reason}` per reader refusal (`GltfReadRefusal.reason`). `too-large` is
 * not here: it routes to the ordinary too-large sentence (N3) with the size.
 * A `Map`, not a record: the key is read off a value the reader derived from a
 * file, and a record would resolve `constructor` & co.
 */
export const GLTF_READ_REASON_KEYS: ReadonlyMap<Exclude<GltfReadRefusalReason, 'too-large'>, string> = new Map([
  ['unreadable', 'Its file structure could not be read.'],
  ['too-complex', 'It has more nodes, meshes, materials or textures than FastShaders reads.'],
  ['external-data', 'Part of its data is stored in separate files; export it as a single .glb.'],
  ['invalid-model', 'Its scene description is invalid.'],
]);

/** Why ONE texture of a built material was not imported: an image status the
 *  reader reports (never 'ok'), or a texture's own extract status. */
export type GltfImageSkip = Exclude<GltfImageStatus, 'ok'> | 'ktx2-only' | 'no-readable-source';

/**
 * The per-texture skip FRAGMENT the import report slots into its "skipped"
 * outcome (P5c's N14 lines). `no-readable-source` (every source of the texture
 * is unusable, none of them KTX2) reads as the unsupported-format text. The
 * literal "64" in the too-large text is pinned against GLTF_IMAGE_MAX_BYTES.
 */
export const GLTF_IMAGE_SKIP_KEYS: ReadonlyMap<Exclude<GltfImageSkip, 'no-readable-source'>, string> = new Map([
  ['external', 'stored in a separate file'],
  ['ktx2-only', 'KTX2 only, without a fallback image'],
  ['unsupported-format', 'an image format FastShaders cannot read'],
  ['damaged', 'damaged image data'],
  ['too-large', 'larger than 64 MB'],
  ['compressed-view', 'stored in a compressed buffer'],
]);

/**
 * A reader refusal as a sentence in `lang`. `sizeBytes` is the file's size,
 * for the too-large case, which reads exactly as a too-large model drop does.
 * Everything else is ONE `fillTemplate` pass, so a file name spelling
 * `{reason}` is inserted verbatim and never scanned for placeholders.
 */
export function gltfBuildRefusalMessage(
  r: GltfReadRefusal,
  fileName: string,
  sizeBytes: number,
  lang: Language,
): string {
  if (r.reason === 'too-large') return meshRefusalMessage(modelTooLargeRefusal(sizeBytes), lang);
  const reasonKey = GLTF_READ_REASON_KEYS.get(r.reason) ?? GLTF_READ_REASON_KEYS.get('unreadable')!;
  return fillTemplate(t(GLTF_BUILD_REFUSED_KEY, lang), {
    name: '\u201c' + fileName + '\u201d',
    reason: t(reasonKey, lang),
  });
}

/** The skip fragment for one texture, in `lang` (an unknown key reads as the
 *  unsupported-format text). */
export function gltfImageSkipReason(k: GltfImageSkip, lang: Language): string {
  const key = k === 'no-readable-source' ? 'unsupported-format' : k;
  return t(GLTF_IMAGE_SKIP_KEYS.get(key) ?? GLTF_IMAGE_SKIP_KEYS.get('unsupported-format')!, lang);
}
