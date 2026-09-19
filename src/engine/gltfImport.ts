/**
 * THE GLB IMPORT COMPOSER (GLB Phase 5 Step 8; integration plan §2f):
 * `buildGlbImport` turns the trusted-side reader's report of a dropped model
 * into a FastShaders project, a texture-stripped preview mesh and a report —
 * the whole "Build a shader from this model's materials" answer, minus the
 * dialog (Step 9) that asks it and the commit (`commitGlbImport`,
 * engine/projectImport.ts) that lands it.
 *
 * The sequence, in this order and no other:
 *   1. `planBuiltMaterials` — which requested materials are built (the
 *      buildable set, capped at MAX_INDEX_MATERIALS; the rest keep the
 *      materials the model was authored with);
 *   2. `encodeRequests` + `encodeGltfImages` — every image a built slot
 *      reaches, once, SERIALLY, through the dropped-image pipeline;
 *   3. `buildGltfSectionGraph` — the Output node, its index sections and
 *      their feeders (pure);
 *   4. `planTextureStrip` + `stripGltfTextures` — the preview copy of the
 *      model minus the textures the sections now carry, so the 3D view does
 *      not upload every picture twice (a null plan — nothing to strip, or the
 *      writer's walk budget exceeded — keeps the dropped bytes as they are);
 *   5. `createPreviewMesh` over that copy — which MUST succeed (the 64 MiB
 *      gate applies to the stripped model, and a 'kept'-mode copy may still
 *      be over it) before anything else is assembled;
 *   6. the project (the model's stem as its name; `preview.geometry` is
 *      forced to 'custom' at commit) and the ONE report (`GlbImportReport`).
 *
 * It NEVER writes the store — the caller commits, or drops everything on
 * cancel — and it never throws for a bad model: every failure is a result.
 * The report it takes is TRANSIENT (views into the dropped file); nothing of
 * it survives here except encoded `data:` URLs, names the reader sanitised
 * and numbers.
 */
import { MAX_INDEX_MATERIALS } from './materialPartsContract';
import { buildGltfSectionGraph } from './gltfSectionBuilder';
import type { FastShadersProject } from './fastShadersProject';
import type { GltfModelReport } from '@/utils/gltfReader';
import { planTextureStrip, stripGltfTextures } from '@/utils/gltfStrip';
import { createPreviewMesh, detectMeshKind, sanitizeMeshFileName, type MeshRefusal, type PreviewMesh } from '@/utils/previewMesh';
import { encodeRequests, planBuiltMaterials } from '@/utils/gltfImportPlan';
import { encodeGltfImages, type EncodeGltfImagesOptions } from '@/utils/gltfTextureEncode';
import { MAX_TOTAL_IMAGE_CHARS } from '@/utils/imageNode';
import type { GlbImportReport, GlbTextureOutcome } from '@/utils/glbImportReport';

export interface BuildGlbImportOptions {
  /** The dropped file's bytes — the preview copy when there is nothing to
   *  strip (the report holds only views, never the whole container). */
  readonly bytes: Uint8Array;
  /** The glTF material indices to build (the dialog's choice). */
  readonly materialIndices: readonly number[];
  /** The "Import at {res} px" choice, or null for the slot sizes. */
  readonly maxDim: number | null;
  readonly deviceMaxDim: number;
  readonly ignoreImageLimits: boolean;
  readonly signal: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
  /** Test seams (see `encodeGltfImages`). */
  readonly encode?: EncodeGltfImagesOptions['encode'];
  readonly stash?: EncodeGltfImagesOptions['stash'];
}

export type BuildGlbImportResult =
  | { ok: true; project: FastShadersProject; mesh: PreviewMesh; report: GlbImportReport }
  | { ok: false; reason: 'aborted' }
  | { ok: false; reason: 'mesh-refused'; refusal: MeshRefusal }
  | { ok: false; reason: 'failed'; message: string };

/** The shader name a model's file name gives: its sanitised stem. */
export function glbImportShaderName(fileName: string, kind: 'glb' | 'gltf'): string {
  return sanitizeMeshFileName(fileName, kind).replace(/\.(glb|gltf)$/, '');
}

/**
 * Build the project for `report` (a model already read by `readGltfModel`).
 * `fileName` is the dropped file's name; the mesh, the shader name and every
 * Image node's display name derive from its sanitised form.
 */
export async function buildGlbImport(
  report: GltfModelReport,
  fileName: string,
  opts: BuildGlbImportOptions,
): Promise<BuildGlbImportResult> {
  const kind = detectMeshKind(fileName);
  if (kind !== 'glb' && kind !== 'gltf') {
    return { ok: false, reason: 'failed', message: 'not a glTF model' };
  }
  if (opts.signal.aborted) return { ok: false, reason: 'aborted' };

  const { sectioned, keptAuthored } = planBuiltMaterials(report, opts.materialIndices);
  const { requests, unextractable } = encodeRequests(report, sectioned);

  const encoded = await encodeGltfImages(report, requests, {
    modelName: fileName,
    maxDim: opts.maxDim,
    deviceMaxDim: opts.deviceMaxDim,
    ignoreLimits: opts.ignoreImageLimits,
    budgetChars: opts.ignoreImageLimits ? Infinity : MAX_TOTAL_IMAGE_CHARS,
    signal: opts.signal,
    onProgress: opts.onProgress,
    ...(opts.encode ? { encode: opts.encode } : {}),
    ...(opts.stash ? { stash: opts.stash } : {}),
  });
  if (encoded.aborted || opts.signal.aborted) return { ok: false, reason: 'aborted' };

  const built = buildGltfSectionGraph(report, { materials: sectioned, encoded: encoded.encoded });
  if (built.signatureTooLarge) {
    return { ok: false, reason: 'failed', message: 'the model signature is too large' };
  }

  // The preview copy: stripped of the built materials' textures when there
  // are any to strip. A refusal here is the ordinary model refusal, with the
  // project untouched.
  let previewBytes: Uint8Array = opts.bytes;
  const plan = planTextureStrip(report, sectioned);
  if (plan) {
    try {
      previewBytes = stripGltfTextures(report, plan).bytes;
    } catch (e) {
      return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
  }
  if (opts.signal.aborted) return { ok: false, reason: 'aborted' };
  const meshResult = createPreviewMesh(fileName, previewBytes);
  if ('error' in meshResult) return { ok: false, reason: 'mesh-refused', refusal: meshResult.refusal };

  const project: FastShadersProject = {
    version: 1,
    shaderName: glbImportShaderName(fileName, kind),
    graph: { nodes: built.nodes, edges: built.edges },
    preview: { geometry: 'custom' },
    ui: {},
  };

  // The report: the encode's outcomes (kept ones included; the note filters
  // them) after the textures no built slot could reach, each texture once.
  const outcomes: GlbTextureOutcome[] = [];
  for (const u of unextractable) {
    // The reader's own display names (an image the reader refused is never a
    // request, so it has no encode outcome to take a name from).
    const img = u.image !== null ? report.images[u.image] : undefined;
    const name = img?.name || report.textures[u.texture]?.name || `texture-${u.texture}`;
    outcomes.push({
      name,
      outcome: 'skipped',
      reason: u.reason,
    });
  }
  for (const o of encoded.outcomes) {
    if (o.status === 'kept') outcomes.push({ name: o.name, outcome: 'kept' });
    else if (o.status === 'downscaled') {
      outcomes.push({ name: o.name, outcome: 'downscaled', width: o.width, height: o.height, reason: o.reason });
    } else outcomes.push({ name: o.name, outcome: 'skipped', reason: o.reason });
  }
  const glbReport: GlbImportReport = {
    materials: built.report.sections,
    textures: built.report.textureNodes,
    shared: built.report.sharedTextureNodes,
    keptAuthored,
    sectionMax: MAX_INDEX_MATERIALS,
    decodeDownscaled: { ...encoded.decodeDownscaled },
    notImported: built.report.notImported,
    outcomes,
  };
  return { ok: true, project, mesh: meshResult.mesh, report: glbReport };
}
