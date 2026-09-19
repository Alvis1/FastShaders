/**
 * THE single-GLB EXPORT COMPOSER (Phase 7 Step 4; no UI yet — Step 7 wires it
 * through `buildShaderExportChecked`). One `.glb`: the loaded preview model,
 * the textures the shader uses written into the glTF material slots the
 * import mapped, the shader module and the project block
 * (engine/glbShaderContract.ts).
 *
 * THE FLOW CONTRACT for the UI:
 *   1. `prepareSingleGlb({ signal })` reads the store ONCE, synchronously,
 *      before its first await (the model, the module, the plan, the project
 *      block), then encodes the PNG/JPEG fallbacks — DOM work, sequential,
 *      abortable between images — and measures the file in both WebP modes.
 *      The prepared object holds its own inputs, so a graph edit during the
 *      await cannot tear the file; the next export prepares again.
 *   2. `utils/exportPreflight.ts` `planSingleGlbPreflight(prepared.sizes)`
 *      decides whether FastShaders could open the file again.
 *   3. `prepared.build(mode)` is SYNCHRONOUS. The download must follow it in
 *      the same task as the user's click (a dialog button, or a fresh
 *      "Download" click when `navigator.userActivation` lapsed during the
 *      await): Safari drops an anchor download without transient activation.
 *   4. `downloadShader` (engine/exportShader.ts) stays THE only download and
 *      the only telemetry chokepoint — this module logs nothing.
 *
 * Not offered in a study session: the first check refuses with `study`, and
 * the study package keeps `.js`/`.zip`.
 *
 * SECURITY: nothing here runs, parses or fetches the module or any model
 * byte beyond the trusted-side reader; the repacker writes the texts as
 * opaque BIN bytes.
 */
import { useAppStore } from '@/store/useAppStore';
import { isEvalMode } from '@/eval/evalMode';
import { getNodeValues } from '@/types';
import { readGltfModel } from '@/utils/gltfReader';
import {
  measureGlbRepack,
  prepareRepackBase,
  repackGlb,
  type GlbRepackReport,
  type GlbRepackSize,
  type GlbWebpMode,
  type RepackFallback,
  type RepackInput,
  type RepackPayload,
  type RepackSlot,
  type GltfWritableSlot,
  type RepackRefusalReason,
} from '@/utils/glbRepack';
import { encodeGlbFallback } from '@/utils/glbFallbackEncode';
import {
  encodeKtx2Checked,
  ktx2Eligible,
  ktx2RequestFor,
  type Ktx2Encoder,
  type Ktx2Refusal,
  type Ktx2Slot,
} from '@/utils/ktx2Encoder';
import { payloadToRgba, type Ktx2Pixels } from '@/utils/ktx2Pixels';
import { EXPORT_ERROR_PREFIX, buildExportModule, buildProjectState, shaderBaseName } from './exportShader';
import { embedProjectState } from './fastShadersProject';
import { planGlbExport, type GlbExportPlan, type GlbSlotProblem } from './glbExportPlan';
import { imageAssetFor } from './imageAssets';
import { referenceImagesInSet } from './projectImageRefs';

/** Why a single `.glb` could not be prepared. `study` and `aborted` are never shown. */
export type SingleGlbRefusalReason =
  | 'study'
  | 'no-model'
  | 'not-gltf'
  | 'external-data'
  | 'module-error'
  | RepackRefusalReason;

export interface SingleGlbSizes {
  /** WebP with a PNG/JPEG copy (the default). */
  fallback: GlbRepackSize;
  /** WebP only. */
  required: GlbRepackSize;
  /** The default file WITHOUT the KTX2 copies; identical to `fallback` when
   *  there are none (no encoder, or every texture was skipped). */
  noKtx2: GlbRepackSize;
}

/** What `build` writes. 'no-ktx2' is the default file minus the KTX2 copies. */
export type SingleGlbBuildMode = GlbWebpMode | 'no-ktx2';

/** One texture that got no KTX2 copy, for the export report. */
export interface Ktx2Skipped {
  /** The image's name hint, as the plan carries it (may be ''). */
  name: string;
  reason: Ktx2Refusal;
}

/** The KTX2 half of a prepare: the encoder to use, and progress per texture. */
export interface SingleGlbKtx2Options {
  encoder: Ktx2Encoder;
  onProgress?(done: number, total: number): void;
}

export interface SingleGlbPrepared {
  /** `${shaderBaseName(shaderName)}.glb` */
  fileName: string;
  sizes: SingleGlbSizes;
  problems: GlbSlotProblem[];
  notes: GlbExportPlan['notes'];
  /** Textures that asked for a KTX2 copy and did not get one (never fatal). */
  ktx2Skipped: Ktx2Skipped[];
  /** How many textures carry a KTX2 copy. */
  ktx2Written: number;
  /** SYNC: call inside the user's click. Throws only on an internal invariant failure. */
  build(mode: SingleGlbBuildMode): { bytes: Uint8Array<ArrayBuffer>; report: GlbRepackReport };
}

export type SingleGlbPrepareResult =
  | { ok: true; prepared: SingleGlbPrepared }
  | { ok: false; reason: SingleGlbRefusalReason; detail?: string; name?: string }
  | { ok: false; reason: 'aborted' };

export type GlbFallbackEncoder = (p: RepackPayload, width: number, height: number) => Promise<RepackFallback | null>;

let fallbackEncoder: GlbFallbackEncoder = encodeGlbFallback;

/**
 * TEST-ONLY seam: node has no canvas, so a suite injects the fallback bytes.
 * `null` restores the DOM encoder. Nothing under src/ outside a test calls it
 * (exportSingleGlb.test.ts pins that).
 */
export function __setFallbackEncoderForTests(fn: GlbFallbackEncoder | null): void {
  fallbackEncoder = fn ?? encodeGlbFallback;
}

export type Ktx2PixelReader = (dataUrl: string, width: number, height: number) => Promise<Ktx2Pixels | null>;

let pixelReader: Ktx2PixelReader = payloadToRgba;

/**
 * TEST-ONLY seam, the `__setFallbackEncoderForTests` precedent: node has no
 * canvas, so a suite injects the pixels. `null` restores the DOM reader.
 */
export function __setKtx2PixelReaderForTests(fn: Ktx2PixelReader | null): void {
  pixelReader = fn ?? payloadToRgba;
}

/** Which colour handling a written glTF slot asks of the encoder. */
const KTX2_SLOT_OF: Readonly<Record<GltfWritableSlot, Ktx2Slot>> = {
  baseColor: 'baseColor',
  emissive: 'emissive',
  normal: 'normal',
  metallicRoughness: 'data',
};

/** `asset.generator`, from the build's own version (whitelisted by the repacker). */
function generatorName(): string | undefined {
  const v = typeof __APP_VERSION__ !== 'undefined' ? String(__APP_VERSION__) : '';
  return /^[0-9A-Za-z.+-]{1,64}$/.test(v) ? `FastShaders ${v}` : undefined;
}

/** The display name of the node owning asset `key` (for `asset-too-large`). */
function nameForAssetKey(plan: GlbExportPlan, detail: string): string | undefined {
  if (!detail.startsWith('asset:')) return undefined;
  const key = detail.slice('asset:'.length);
  return plan.moduleAssets.find((a) => a.key === key)?.name || undefined;
}

/**
 * Prepare a single `.glb` of the current graph and loaded model. See the
 * module header for the flow; every failure is a RESULT.
 */
export async function prepareSingleGlb(
  opts: { signal?: AbortSignal; ktx2?: SingleGlbKtx2Options | null } = {},
): Promise<SingleGlbPrepareResult> {
  if (isEvalMode()) return { ok: false, reason: 'study' };
  if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };

  // Everything the file is built from, read ONCE, before the first await.
  const state = useAppStore.getState();
  const mesh = state.previewMesh;
  if (!mesh) return { ok: false, reason: 'no-model' };
  if (mesh.kind !== 'glb' && mesh.kind !== 'gltf') return { ok: false, reason: 'not-gltf', name: mesh.name };
  const fileName = `${shaderBaseName(state.shaderName)}.glb`;

  const moduleText = buildExportModule({ inlineImages: false, glbFile: fileName });
  if (moduleText.startsWith(EXPORT_ERROR_PREFIX)) return { ok: false, reason: 'module-error' };

  const read = readGltfModel(mesh.bytes, mesh.kind);
  if (!read.ok) {
    const r = read.refusal.reason;
    if (r === 'external-data') return { ok: false, reason: 'external-data', name: mesh.name };
    return { ok: false, reason: r === 'too-complex' ? 'too-complex' : 'unreadable', detail: read.refusal.detail };
  }

  const planned = planGlbExport(state.nodes, state.edges, moduleText, read.model.signature);
  if (!planned.ok) return { ok: false, reason: 'model-mismatch' };
  const plan = planned.plan;

  const base = prepareRepackBase(read.model, plan.indexMaterials);
  if (!base.ok) return { ok: false, reason: base.refusal.reason, detail: base.refusal.detail };

  // The project block, ref-only for every payload the file carries (the
  // `assets` targets): no build older than the single-GLB import opens one.
  const written = new Set(plan.moduleAssets.map((a) => a.src));
  const project = referenceImagesInSet(buildProjectState(), written, (n) => imageAssetFor(n.id, getNodeValues(n))?.src ?? null);
  const projectText = embedProjectState('', project).trim();

  // The fallbacks: each distinct WebP a slot uses, in slot order, one at a time.
  const fallbacks = new Map<string, RepackFallback | null>();
  for (const s of plan.slots) {
    const p = plan.payloads.get(s.src);
    if (!p || p.mime !== 'image/webp' || fallbacks.has(s.src)) continue;
    if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
    const dims = plan.payloadSizes.get(s.src);
    let fb: RepackFallback | null = null;
    try {
      fb = dims ? await fallbackEncoder(p, dims.width, dims.height) : null;
    } catch {
      fb = null;
    }
    fallbacks.set(s.src, fb);
  }
  if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };

  const generator = generatorName();
  const input: Omit<RepackInput, 'webpMode'> = {
    base: base.model,
    indexMaterials: plan.indexMaterials,
    slots: plan.slots,
    payloads: plan.payloads,
    fallbacks,
    moduleText,
    moduleAssets: plan.moduleAssets,
    projectText,
    ...(generator ? { generator } : {}),
  };
  const measure = (extra: Partial<RepackInput> & { webpMode: GlbWebpMode }) =>
    measureGlbRepack({ ...input, ...extra });
  const refuseMeasure = (refusal: { reason: RepackRefusalReason; detail: string }): SingleGlbPrepareResult => ({
    ok: false,
    reason: refusal.reason,
    detail: refusal.detail,
    name: nameForAssetKey(plan, refusal.detail),
  });

  // The file WITHOUT KTX2 copies is measured first whatever happens: it is the
  // default when no encoder is registered, the fall-back size when every
  // texture is skipped, and the 'no-ktx2' build mode's own size.
  const plain = measure({ webpMode: 'fallback' });
  if (!plain.ok) return refuseMeasure(plain.refusal);

  // The KTX2 copies (Phase 8). Keyed by the texture index the measure above
  // assigned, so a copy can only ever land on a texture this export writes.
  // SERIAL — one decode and one encode at a time, the drop-time rule — and
  // every failure is collected, never fatal: an export without a KTX2 copy is
  // exactly today's file.
  const ktx2Sources = new Map<number, Uint8Array>();
  const ktx2Skipped: Ktx2Skipped[] = [];
  if (opts.ktx2) {
    const perTexture = new Map<number, RepackSlot>();
    for (const w of plain.written) {
      if (perTexture.has(w.texture)) continue;
      const s = plan.slots.find((c) => c.material === w.material && c.slot === w.slot);
      if (s) perTexture.set(w.texture, s);
    }
    const pixelsFor = new Map<string, Ktx2Pixels | null>();
    const total = perTexture.size;
    let done = 0;
    for (const t of [...perTexture.keys()].sort((a, b) => a - b)) {
      if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
      const s = perTexture.get(t) as RepackSlot;
      // The SIZE gate runs BEFORE the decode, never after. `encodeKtx2Checked`
      // refuses an over-4096 texture, but only once the whole bitmap is RGBA8
      // in memory — an 8192² payload is ~0.75 GB, retained in `pixelsFor` for
      // the rest of the loop, and `values.width`/`height` reach 8192 with no
      // restore path validating them. The node's stored size is the same one
      // `encodeGlbFallback` measures against, so it is asked here; the reader
      // takes it too and refuses a bitmap that is not that size, so a payload
      // free to lie about its dimensions is refused before `getImageData`.
      const dims = plan.payloadSizes.get(s.src);
      let sizeRefusal: Ktx2Refusal | null = 'encode-failed';
      if (dims) {
        const e = ktx2Eligible(dims.width, dims.height);
        sizeRefusal = e.ok ? null : e.reason;
      }
      if (!dims || sizeRefusal !== null) {
        ktx2Skipped.push({ name: s.name, reason: sizeRefusal ?? 'encode-failed' });
      } else {
        if (!pixelsFor.has(s.src)) {
          let px: Ktx2Pixels | null = null;
          try {
            px = await pixelReader(s.src, dims.width, dims.height);
          } catch {
            px = null;
          }
          pixelsFor.set(s.src, px);
        }
        const px = pixelsFor.get(s.src) ?? null;
        if (!px) {
          ktx2Skipped.push({ name: s.name, reason: 'encode-failed' });
        } else {
          // The sampler the repacker writes IS the mip decision (a data map is
          // unmipmapped, a colour image trilinear), so it is read from there
          // rather than re-derived from the node's settings.
          const mipmapped = s.sampler.minFilter === 9984 || s.sampler.minFilter === 9987;
          const req = ktx2RequestFor(KTX2_SLOT_OF[s.slot], px, { mipmapped });
          const r = await encodeKtx2Checked(opts.ktx2.encoder, req, opts.signal);
          if (r.ok) ktx2Sources.set(t, r.bytes);
          else if (r.reason === 'aborted') return { ok: false, reason: 'aborted' };
          else ktx2Skipped.push({ name: s.name, reason: r.reason });
        }
      }
      done++;
      opts.ktx2.onProgress?.(done, total);
    }
    if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
  }

  const withKtx2 = ktx2Sources.size > 0 ? { ktx2Sources } : {};
  const fallback = ktx2Sources.size > 0 ? measure({ ...withKtx2, webpMode: 'fallback' }) : plain;
  if (!fallback.ok) return refuseMeasure(fallback.refusal);
  const required = measure({ ...withKtx2, webpMode: 'required' });
  if (!required.ok) return refuseMeasure(required.refusal);

  return {
    ok: true,
    prepared: {
      fileName,
      sizes: { fallback: fallback.size, required: required.size, noKtx2: plain.size },
      problems: plan.problems,
      notes: plan.notes,
      ktx2Skipped,
      ktx2Written: ktx2Sources.size,
      build(mode) {
        const r = repackGlb({
          ...input,
          ...(mode === 'no-ktx2' ? {} : withKtx2),
          webpMode: mode === 'no-ktx2' ? 'fallback' : mode,
        });
        if (!r.ok) throw new Error(`exportSingleGlb: a measured repack refused (${r.refusal.reason}: ${r.refusal.detail})`);
        return { bytes: r.bytes, report: r.report };
      },
    },
  };
}
