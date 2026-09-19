/**
 * The GLB import dialog's decisions (Phase 5 Step 9): the facts derived from
 * the reader's report, the N11 gate, the N9 estimate and its Import-at rung,
 * N12, and Model only's availability. Every fact came out of a dropped file,
 * so junk sweeps are the point.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_FACT_MATERIALS,
  MAX_FACT_TEXTURES,
  glbImportFactsOf,
  planGlbImportDialog,
  type GlbDialogContext,
  type GlbImportFacts,
  type GlbTextureFact,
} from './glbImportGate';
import { GLB_IMPORT_MATERIAL_LIMIT, IMPORT_AT_LADDER } from './glbImportLimits';
import { MAX_INDEX_MATERIALS } from '@/engine/materialPartsContract';
import { MAX_TOTAL_IMAGE_CHARS } from './imageNode';
import { MESH_MAX_BYTES } from './previewMesh';
import { estimateTextureChars } from './gltfImportPlan';
import { aiGlb, blenderGlb, manyMaterialsGlb, readOk, scanGlb } from '@/engine/gltfImportFixtures';

const CTX: GlbDialogContext = { allowManyMaterials: false, ignoreImageLimits: false, deviceMaxDim: 2048 };

function tex(over: Partial<GlbTextureFact> = {}): GlbTextureFact {
  return { key: 'k', slot: 'baseColor', width: 1024, height: 1024, sourceLossless: false, materials: [0], ...over };
}

function facts(over: Partial<GlbImportFacts> = {}): GlbImportFacts {
  return {
    kind: 'glb',
    fileName: 'm.glb',
    fileBytes: 1000,
    materialIndices: [0],
    textures: [tex()],
    embeddedShader: null,
    ...over,
  };
}

describe('glbImportFactsOf: the facts are what the builder would build', () => {
  it('BLENDER: three buildable materials, three Texture nodes, the ORM shared by two', () => {
    const f = glbImportFactsOf(readOk(blenderGlb()), 'My Model.glb', 4321);
    expect(f).toMatchObject({ kind: 'glb', fileName: 'My-Model.glb', fileBytes: 4321, materialIndices: [0, 1, 2], embeddedShader: null });
    expect(f.textures).toHaveLength(3);
    const orm = f.textures.find((t) => t.slot === 'metallicRoughness')!;
    expect(orm.materials).toEqual([0, 1]);
    expect(orm.sourceLossless).toBe(true);
    expect(orm).toMatchObject({ width: 4, height: 2 });
    const normal = f.textures.find((t) => t.slot === 'normal')!;
    expect(normal.key).toContain('normalGreen=flip');
    // Occlusion shares the ORM image and never adds a fact of its own.
    expect(f.textures.filter((t) => t.slot === ('occlusion' as never))).toHaveLength(0);
  });

  it('AI: the unused material and the dead emissive texture are not facts; the JPEG is lossy', () => {
    const f = glbImportFactsOf(readOk(aiGlb()), 'ai.glb', 10);
    expect(f.materialIndices).toEqual([0]);
    expect(f.textures.map((t) => t.slot).sort()).toEqual(['baseColor', 'metallicRoughness', 'normal']);
    expect(f.textures.find((t) => t.slot === 'baseColor')).toMatchObject({ width: 1920, height: 1080, sourceLossless: false });
  });

  it('junk byte counts read as 0', () => {
    expect(glbImportFactsOf(readOk(scanGlb()), 's.glb', NaN).fileBytes).toBe(0);
    expect(glbImportFactsOf(readOk(scanGlb()), 's.glb', -5).fileBytes).toBe(0);
  });
});

describe('planGlbImportDialog: whether to offer', () => {
  it('null facts, no material or no texture is NOT offered', () => {
    expect(planGlbImportDialog(null, CTX).offer).toBe(false);
    expect(planGlbImportDialog(facts({ materialIndices: [] }), CTX).offer).toBe(false);
    expect(planGlbImportDialog(facts({ textures: [] }), CTX).offer).toBe(false);
    const p = planGlbImportDialog(null, CTX);
    expect(p).toMatchObject({ materials: 0, textures: 0, gate: null, budget: null, primary: null, modelOnlyRefusal: null, embeddedShader: null });
  });

  it('junk in the facts is filtered, never thrown on', () => {
    const p = planGlbImportDialog(
      facts({
        materialIndices: [2, 'x', -1, 1.5, 2, 0] as unknown as number[],
        textures: [tex(), null as unknown as GlbTextureFact, tex({ slot: 'occlusion' as never }), tex({ materials: 'no' as unknown as number[] })],
      }),
      CTX,
    );
    expect(p.offer).toBe(true);
    expect(p.materials).toBe(2);
    expect(p.textures).toBe(1);
    expect(p.buildMaterialIndices).toEqual([0, 2]);
  });

  it('caps the fact lists', () => {
    const mats = Array.from({ length: MAX_FACT_MATERIALS + 50 }, (_, i) => i);
    const p = planGlbImportDialog(facts({ materialIndices: mats, textures: Array.from({ length: MAX_FACT_TEXTURES + 5 }, () => tex()) }), { ...CTX, allowManyMaterials: true });
    expect(p.materials).toBe(MAX_FACT_MATERIALS);
    expect(p.textures).toBe(MAX_FACT_TEXTURES);
  });
});

describe('N11: the material gate', () => {
  const mats = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('at or under the limit: ok, everything built', () => {
    const p = planGlbImportDialog(facts({ materialIndices: mats(GLB_IMPORT_MATERIAL_LIMIT) }), CTX);
    expect(p.gate).toEqual({ state: 'ok', build: GLB_IMPORT_MATERIAL_LIMIT });
    expect(p.buildMaterialIndices).toEqual(mats(GLB_IMPORT_MATERIAL_LIMIT));
    expect(p.primary).toBe('build');
  });

  it('over the limit with the setting off: blocked, nothing built, no budget, no memory, no primary', () => {
    const p = planGlbImportDialog(facts({ materialIndices: mats(12) }), CTX);
    expect(p.gate).toEqual({ state: 'blocked', n: 12, limit: GLB_IMPORT_MATERIAL_LIMIT });
    expect(p.buildMaterialIndices).toEqual([]);
    expect(p.budget).toBeNull();
    expect(p.memory).toBeNull();
    expect(p.primary).toBeNull();
    expect(p.maxDim).toBeNull();
  });

  it('over the limit with the setting on: confirm; past the editor ceiling the rest keep their authored materials', () => {
    const on = { ...CTX, allowManyMaterials: true };
    const p12 = planGlbImportDialog(facts({ materialIndices: mats(12) }), on);
    expect(p12.gate).toEqual({ state: 'confirm', n: 12, limit: GLB_IMPORT_MATERIAL_LIMIT, build: 12, keptAuthored: 0, max: MAX_INDEX_MATERIALS });
    const p20 = planGlbImportDialog(facts({ materialIndices: mats(20) }), on);
    expect(p20.gate).toEqual({ state: 'confirm', n: 20, limit: GLB_IMPORT_MATERIAL_LIMIT, build: MAX_INDEX_MATERIALS, keptAuthored: 20 - MAX_INDEX_MATERIALS, max: MAX_INDEX_MATERIALS });
    // Every buildable material is handed on; the builder caps and counts.
    expect(p20.buildMaterialIndices).toEqual(mats(20));
  });

  it('the fixtures: 3 (SCAN) is ok; MAX_INDEX_MATERIALS + 4 needs the setting', () => {
    expect(planGlbImportDialog(glbImportFactsOf(readOk(scanGlb()), 's.glb', 1), CTX).gate).toEqual({ state: 'ok', build: 3 });
    const many = glbImportFactsOf(readOk(manyMaterialsGlb(MAX_INDEX_MATERIALS + 4)), 'm.glb', 1);
    expect(planGlbImportDialog(many, CTX).gate?.state).toBe('blocked');
    expect(planGlbImportDialog(many, { ...CTX, allowManyMaterials: true }).gate?.state).toBe('confirm');
  });
});

describe('N9: the budget', () => {
  it('small textures fit: budget fits, primary build, maxDim null', () => {
    const p = planGlbImportDialog(facts({ textures: [tex({ width: 256, height: 256 })] }), CTX);
    expect(p.budget).toEqual({ fits: true, estChars: estimateTextureChars(tex({ width: 256, height: 256 }), null, 2048), remainingChars: MAX_TOTAL_IMAGE_CHARS });
    expect(p.primary).toBe('build');
    expect(p.maxDim).toBeNull();
  });

  it('too many 4K colour textures: the largest fitting rung becomes the primary and the cap', () => {
    const many = Array.from({ length: 16 }, (_, i) => tex({ key: `k${i}`, width: 4096, height: 4096 }));
    const p = planGlbImportDialog(facts({ textures: many }), CTX);
    expect(p.budget?.fits).toBe(false);
    if (!p.budget || p.budget.fits) return;
    expect(p.budget.estChars).toBeGreaterThan(MAX_TOTAL_IMAGE_CHARS);
    expect(p.budget.importAt).not.toBeNull();
    expect(IMPORT_AT_LADDER).toContain(p.budget.importAt);
    expect(p.budget.importAt).toBeLessThan(1024);
    expect(p.budget.estAtImport).toBeLessThanOrEqual(MAX_TOTAL_IMAGE_CHARS);
    expect(p.primary).toBe('import-at');
    expect(p.maxDim).toBe(p.budget.importAt);
    // The rung is the LARGEST that fits: the next one up must not.
    const idx = IMPORT_AT_LADDER.indexOf(p.budget.importAt as 1024);
    if (idx > 0) {
      const up = IMPORT_AT_LADDER[idx - 1];
      const est = many.reduce((s, t) => s + estimateTextureChars(t, up, 2048), 0);
      expect(est).toBeGreaterThan(MAX_TOTAL_IMAGE_CHARS);
    }
  });

  it('nothing fits even at the floor: no primary, the floor estimate carried for the sentence', () => {
    // 256 lossless normal maps: at the 128 px floor each is still ~20K chars.
    const many = Array.from({ length: 256 }, (_, i) => tex({ key: `k${i}`, slot: 'normal', sourceLossless: true, width: 4096, height: 4096 }));
    const p = planGlbImportDialog(facts({ textures: many, materialIndices: [0] }), CTX);
    expect(p.budget).toMatchObject({ fits: false, importAt: null, floorRes: IMPORT_AT_LADDER[IMPORT_AT_LADDER.length - 1] });
    expect(p.primary).toBeNull();
    expect(p.maxDim).toBeNull();
  });

  it('a rung is never offered at or above the largest planned side', () => {
    // 600 px sources: only 512 and below could shrink them.
    const many = Array.from({ length: 60 }, (_, i) => tex({ key: `k${i}`, width: 600, height: 600 }));
    const p = planGlbImportDialog(facts({ textures: many }), CTX);
    if (p.budget && !p.budget.fits && p.budget.importAt !== null) expect(p.budget.importAt).toBeLessThan(600);
  });

  it('only textures of BUILT materials count', () => {
    const p = planGlbImportDialog(
      facts({
        materialIndices: [0, 1],
        textures: [tex({ key: 'a', materials: [0], width: 256, height: 256 }), tex({ key: 'b', materials: [5], width: 8192, height: 8192 })],
      }),
      CTX,
    );
    expect(p.budget?.fits).toBe(true);
    expect(p.memory?.count).toBe(1);
  });

  it('Ignore limits skips the budget and keeps the slot sizes', () => {
    const many = Array.from({ length: 16 }, (_, i) => tex({ key: `k${i}`, width: 4096, height: 4096 }));
    const p = planGlbImportDialog(facts({ textures: many }), { ...CTX, ignoreImageLimits: true });
    expect(p.budget).toBeNull();
    expect(p.primary).toBe('build');
    expect(p.maxDim).toBeNull();
  });
});

describe('N12 and Model only', () => {
  it('memory counts unique keys at the planned size, colour mipmapped', () => {
    const p = planGlbImportDialog(
      facts({ textures: [tex({ key: 'a', width: 1024, height: 1024 }), tex({ key: 'a', width: 1024, height: 1024 }), tex({ key: 'n', slot: 'normal', width: 1024, height: 1024, sourceLossless: true })] }),
      CTX,
    );
    expect(p.memory?.count).toBe(2);
    // colour 1024² mipmapped (~5.6 MB) + normal at the 512 slot, no mips (1 MB)
    expect(p.memory!.bytes).toBeGreaterThan(1024 * 1024 * 4);
    expect(p.memory!.bytes).toBeLessThan(1024 * 1024 * 4 * 2);
  });

  it('Model only is refused for a file over the model cap, allowed at it', () => {
    expect(planGlbImportDialog(facts({ fileBytes: MESH_MAX_BYTES }), CTX).modelOnlyRefusal).toBeNull();
    const p = planGlbImportDialog(facts({ fileBytes: MESH_MAX_BYTES + 1 }), CTX);
    expect(p.modelOnlyRefusal).toMatchObject({ reason: 'too-large' });
  });
});
