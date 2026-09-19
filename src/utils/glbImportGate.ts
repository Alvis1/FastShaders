/**
 * The GLB import dialog's DECISIONS (GLB Phase 5 Step 9), pure and
 * node-tested: whether a dropped model is offered as a shader at all, the
 * N11 material gate, the N9 texture-budget estimate and its "Import at" rung,
 * the N12 memory figure, and whether "Model only" is even possible.
 *
 * Its input is `GlbImportFacts`, DERIVED from the trusted-side reader's
 * report by `glbImportFactsOf` (integration plan §2a): the buildable
 * materials (`buildableMaterialIndices`, THE set N11 counts) and one texture
 * fact per Texture NODE the builder would make — the same fan-out key
 * (`gltfTextureNodeKey`) over the same built slots (`builtSlotRefs`), so what
 * the dialog counts is what the builder builds. Occlusion-only and dead
 * emissive textures are never facts; a texture with no extractable image is
 * not one either.
 *
 * N9 is an ESTIMATE from header-read dimensions and the shared slot table
 * (`estimateTextureChars` in gltfImportPlan.ts, the ONE estimator), never an
 * encode. The build REPLACES the project, so the whole image budget counts as
 * free. The builder enforces the real budget and reports what it did, and
 * `applyProjectToStore`'s soft-cap sanitizer is the backstop.
 *
 * GLB Phase 7 widens it with RESTORE: a FastShaders single-GLB export that
 * carries its shader is offered "Restore the stored shader" (the reader's
 * `restoreFactOf`) even when nothing could be built, and a stored shader the
 * reader refused rides the plan as `embeddedRefusal`, so the hook can say so
 * whether or not the dialog opens.
 *
 * No `t()` and no store import: the words are in glbImportCopy.ts, the
 * context (`GlbDialogContext`) is read by the hook.
 */
import { GLB_IMPORT_MATERIAL_LIMIT, IMPORT_AT_LADDER, glbSlotPolicy, type GlbSlot } from './glbImportLimits';
import { MAX_TOTAL_IMAGE_CHARS } from './imageNode';
import { textureMemory } from './textureMemory';
import { MESH_MAX_BYTES, modelTooLargeRefusal, sanitizeMeshFileName, type MeshRefusal } from './previewMesh';
import { MAX_INDEX_MATERIALS } from '@/engine/materialPartsContract';
import { gltfTextureNodeKey } from '@/engine/gltfSectionBuilder';
import { buildableMaterialIndices, slotColorSpace, type GltfModelReport } from './gltfReader';
import type { FsExtrasRead, FsExtrasRefusal } from './glbShaderExtras';
import {
  builtSlotRefs,
  dominantSlot,
  estimateTextureChars,
  imageSourceLossless,
  normalGreenFlipFor,
  plannedTextureDims,
} from './gltfImportPlan';

/** One Texture NODE the build would make (the builder's fan-out key). */
export interface GlbTextureFact {
  readonly key: string;
  /** The slot it is stored for (the most demanding one it serves). */
  readonly slot: GlbSlot;
  /** Header-parsed, or null when unreadable. */
  readonly width: number | null;
  readonly height: number | null;
  /** PNG or VP8L WebP. */
  readonly sourceLossless: boolean;
  /** The glTF materials that use it. */
  readonly materials: readonly number[];
}

export interface GlbImportFacts {
  readonly kind: 'glb' | 'gltf';
  /** `sanitizeMeshFileName`. */
  readonly fileName: string;
  readonly fileBytes: number;
  /** Materials used by at least one default-scene triangle primitive. */
  readonly materialIndices: readonly number[];
  /** EXTRACTABLE textures only. */
  readonly textures: readonly GlbTextureFact[];
  /** Always null: the facts adapter never reads the extras (the plan carries
   *  the restore fact, from the reader in utils/glbShaderExtras.ts). */
  readonly embeddedShader: null;
}

/** What the dialog needs to know about a stored shader it may RESTORE. */
export interface GlbRestoreFact {
  readonly hasProject: boolean;
  readonly hasModule: boolean;
  /** The module's digest no longer matches (an accidental-edit detector). */
  readonly moduleEdited: boolean;
  /** `assets` entries the reader refused, clamped. */
  readonly assetsRefused: number;
}

/** What `planGlbImportDialog` is told about the file's stored shader. */
export interface GlbEmbeddedInput {
  readonly fact: GlbRestoreFact | null;
  readonly refusal: FsExtrasRefusal | null;
  /** The dropped file's length — the Model-only refusal when there are no facts. */
  readonly fileBytes?: number;
}

export const MAX_FACT_ASSETS_REFUSED = 1024;

/** The restore fact of a reader result: 'ok' → the fact, anything else → null. */
export function restoreFactOf(read: FsExtrasRead): GlbRestoreFact | null {
  if (!read || read.state !== 'ok') return null;
  const sh = read.shader;
  const refused = Number.isSafeInteger(sh.assetsRefused) && sh.assetsRefused > 0 ? sh.assetsRefused : 0;
  return {
    hasProject: sh.projectText !== null,
    hasModule: sh.moduleText !== null,
    moduleEdited: sh.moduleEdited === true,
    assetsRefused: Math.min(refused, MAX_FACT_ASSETS_REFUSED),
  };
}

export type GlbMaterialGate =
  | { readonly state: 'ok'; readonly build: number }
  | { readonly state: 'blocked'; readonly n: number; readonly limit: number }
  | {
      readonly state: 'confirm';
      readonly n: number;
      readonly limit: number;
      readonly build: number;
      readonly keptAuthored: number;
      readonly max: number;
    };

export type GlbBudget =
  | { readonly fits: true; readonly estChars: number; readonly remainingChars: number }
  | {
      readonly fits: false;
      readonly estChars: number;
      readonly remainingChars: number;
      /** How many textures `estChars` covers: those of the BUILT materials
       *  only, which past the section ceiling is fewer than `plan.textures`. */
      readonly textures: number;
      /** The largest ladder rung whose estimate fits, or null when none does. */
      readonly importAt: number | null;
      /** The estimate at `importAt`, or at the ladder's floor when none fits. */
      readonly estAtImport: number;
      readonly floorRes: number;
    };

export interface GlbDialogContext {
  readonly allowManyMaterials: boolean;
  readonly ignoreImageLimits: boolean;
  readonly deviceMaxDim: number;
}

export interface GlbDialogPlan {
  readonly offer: boolean;
  readonly materials: number;
  readonly textures: number;
  readonly gate: GlbMaterialGate | null;
  readonly budget: GlbBudget | null;
  /** The materials handed to the builder: every buildable one unless the
   *  gate is blocked. The builder itself caps at MAX_INDEX_MATERIALS
   *  (`planBuiltMaterials`, the ONE cap) and reports the rest as kept
   *  authored — the same count the confirm gate shows. */
  readonly buildMaterialIndices: readonly number[];
  /** The "Import at" cap the build takes, or null for the slot sizes. */
  readonly maxDim: number | null;
  readonly memory: { readonly bytes: number; readonly count: number } | null;
  readonly primary: 'build' | 'import-at' | null;
  /** "Model only" is refused (the file is over the model cap) when set. */
  readonly modelOnlyRefusal: MeshRefusal | null;
  /** Set when "Restore the stored shader" is offered. */
  readonly embeddedShader: GlbRestoreFact | null;
  /** The file claims a stored shader the reader refused (the whole restore). */
  readonly embeddedRefusal: FsExtrasRefusal | null;
}

export const MAX_FACT_MATERIALS = 1024;
export const MAX_FACT_TEXTURES = 256;

const NOT_OFFERED: GlbDialogPlan = Object.freeze({
  offer: false,
  materials: 0,
  textures: 0,
  gate: null,
  budget: null,
  buildMaterialIndices: Object.freeze([]) as readonly number[],
  maxDim: null,
  memory: null,
  primary: null,
  modelOnlyRefusal: null,
  embeddedShader: null,
  embeddedRefusal: null,
});

const NO_EMBEDDED: GlbEmbeddedInput = Object.freeze({ fact: null, refusal: null });

const REFUSALS: ReadonlySet<unknown> = new Set(['damaged', 'too-large', 'unsupported-version', 'inconsistent']);

/* ── the adapter ─────────────────────────────────────────────────────────── */

/**
 * The dialog's facts for a model the reader accepted. Texture facts are one
 * per Texture node the builder would make over the BUILDABLE materials'
 * built slots; a material's slot that reaches no extractable image yields
 * none (the builder then leaves that slot factor-only and reports the skip).
 */
export function glbImportFactsOf(report: GltfModelReport, rawName: string, fileBytes: number): GlbImportFacts {
  const kind = report.kind;
  const materialIndices = buildableMaterialIndices(report);
  const byKey = new Map<string, { slot: GlbSlot; image: number; materials: Set<number> }>();
  for (const mi of materialIndices) {
    const mat = report.materials[mi];
    if (!mat || mat.index !== mi) continue;
    const { flip } = normalGreenFlipFor(mat);
    for (const ref of builtSlotRefs(mat)) {
      const key = gltfTextureNodeKey(report, ref, slotColorSpace(ref.slot), ref.slot === 'normal' && flip);
      if (key === null) continue;
      const tex = report.textures[ref.texture];
      if (!tex || tex.extract.status !== 'ok') continue;
      const prev = byKey.get(key);
      if (prev) {
        prev.materials.add(mi);
        prev.slot = dominantSlot(prev.slot, ref.slot);
      } else {
        byKey.set(key, { slot: ref.slot, image: tex.extract.image, materials: new Set([mi]) });
      }
    }
  }
  const textures: GlbTextureFact[] = [];
  for (const [key, e] of byKey) {
    const img = report.images[e.image];
    textures.push({
      key,
      slot: e.slot,
      width: img?.width ?? null,
      height: img?.height ?? null,
      sourceLossless: img ? imageSourceLossless(img) : false,
      materials: [...e.materials].sort((a, b) => a - b),
    });
  }
  return {
    kind,
    fileName: sanitizeMeshFileName(rawName, kind),
    fileBytes: Number.isFinite(fileBytes) && fileBytes >= 0 ? Math.floor(fileBytes) : 0,
    materialIndices,
    textures,
    embeddedShader: null,
  };
}

/* ── the plan ────────────────────────────────────────────────────────────── */

const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Every decision the dialog shows, from the facts, the session's context and
 * what the file's stored shader looks like (`embedded`). O(n) over the facts,
 * never throws, every number a finite integer. The dialog is OFFERED when a
 * build is possible (facts non-null, a buildable material, an extractable
 * texture) or a stored shader can be restored; a null `facts` — the reader
 * refused the model — can still restore. Not offered, the plan still carries
 * `embeddedRefusal`, so the caller can announce it.
 */
export function planGlbImportDialog(
  facts: GlbImportFacts | null,
  ctx: GlbDialogContext,
  embedded: GlbEmbeddedInput = NO_EMBEDDED,
): GlbDialogPlan {
  const fact = embedded && embedded.fact ? embedded.fact : null;
  const refusal = embedded && REFUSALS.has(embedded.refusal) ? (embedded.refusal as FsExtrasRefusal) : null;
  const mats = facts
    ? [...new Set((Array.isArray(facts.materialIndices) ? facts.materialIndices : []).filter(isIndex))]
        .sort((a, b) => a - b)
        .slice(0, MAX_FACT_MATERIALS)
    : [];
  const tex = facts
    ? (Array.isArray(facts.textures) ? facts.textures : [])
        .slice(0, MAX_FACT_TEXTURES)
        .filter((t) => !!t && glbSlotPolicy(t.slot) !== null && Array.isArray(t.materials))
    : [];
  const offerBuild = facts !== null && mats.length > 0 && tex.length > 0;
  if (!offerBuild && !fact) return refusal ? { ...NOT_OFFERED, embeddedRefusal: refusal } : NOT_OFFERED;
  if (!offerBuild) {
    const rawBytes = facts ? facts.fileBytes : embedded.fileBytes;
    const fileBytes = typeof rawBytes === 'number' && Number.isFinite(rawBytes) && rawBytes >= 0 ? rawBytes : 0;
    return {
      ...NOT_OFFERED,
      offer: true,
      materials: mats.length,
      textures: tex.length,
      modelOnlyRefusal: fileBytes > MESH_MAX_BYTES ? modelTooLargeRefusal(fileBytes) : null,
      embeddedShader: fact,
      embeddedRefusal: refusal,
    };
  }
  // From here the build is offered: `facts` is non-null.
  const f = facts as GlbImportFacts;

  const n = mats.length;
  const limit = GLB_IMPORT_MATERIAL_LIMIT;
  const max = MAX_INDEX_MATERIALS;
  let gate: GlbMaterialGate;
  if (n <= limit) gate = { state: 'ok', build: n };
  else if (!ctx.allowManyMaterials) gate = { state: 'blocked', n, limit };
  else {
    const build = Math.min(n, max);
    gate = { state: 'confirm', n, limit, build, keptAuthored: n - build, max };
  }
  const build = gate.state === 'blocked' ? 0 : gate.build;
  const buildMaterialIndices = gate.state === 'blocked' ? [] : mats;
  // The estimate and the memory figure cover only what will be BUILT.
  const builtSet = new Set(mats.slice(0, build));
  const used = tex.filter((t) => t.materials.some((i: unknown) => typeof i === 'number' && builtSet.has(i)));
  const dev = Number.isInteger(ctx.deviceMaxDim) && ctx.deviceMaxDim >= 1 ? ctx.deviceMaxDim : 2048;

  let budget: GlbBudget | null = null;
  let maxDim: number | null = null;
  let memory: GlbDialogPlan['memory'] = null;
  let primary: GlbDialogPlan['primary'] = null;
  if (gate.state !== 'blocked') {
    const estimateAt = (res: number | null) => used.reduce((sum, t) => sum + estimateTextureChars(t, res, dev), 0);
    const full = estimateAt(null);
    const remaining = MAX_TOTAL_IMAGE_CHARS;
    if (ctx.ignoreImageLimits) {
      primary = 'build';
    } else if (full <= remaining) {
      budget = { fits: true, estChars: full, remainingChars: remaining };
      primary = 'build';
    } else {
      let largest = 0;
      for (const t of used) {
        const d = plannedTextureDims(t, null, dev);
        if (d) largest = Math.max(largest, d.width, d.height);
      }
      let importAt: number | null = null;
      for (const res of IMPORT_AT_LADDER) {
        if (res >= largest) continue;
        if (estimateAt(res) <= remaining) {
          importAt = res;
          break;
        }
      }
      const floorRes = IMPORT_AT_LADDER[IMPORT_AT_LADDER.length - 1];
      budget = {
        fits: false,
        estChars: full,
        remainingChars: remaining,
        textures: used.length,
        importAt,
        estAtImport: estimateAt(importAt ?? floorRes),
        floorRes,
      };
      primary = importAt !== null ? 'import-at' : null;
      maxDim = importAt;
    }
    const mem = textureMemory(
      used.map((t) => {
        const d = plannedTextureDims(t, maxDim, dev);
        return {
          key: t.key,
          width: d?.width ?? 1,
          height: d?.height ?? 1,
          mipmapped: glbSlotPolicy(t.slot)?.colour === true,
          environment: false,
        };
      }),
    );
    memory = { bytes: mem.bytes, count: mem.count };
  }

  return {
    offer: true,
    materials: n,
    textures: tex.length,
    gate,
    budget,
    buildMaterialIndices,
    maxDim,
    memory,
    primary,
    modelOnlyRefusal: f.fileBytes > MESH_MAX_BYTES ? modelTooLargeRefusal(f.fileBytes) : null,
    embeddedShader: fact,
    embeddedRefusal: refusal,
  };
}
