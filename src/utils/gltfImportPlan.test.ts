/**
 * The GLB import's pure decisions (Phase 5 Step 8): which materials are
 * built, the slot classes, the green flip, the colour conversion, the closed
 * feature vocabulary, the encode requests and THE estimator the dialog
 * shares. Every input here came out of a dropped file, so the junk sweeps are
 * the point.
 */
import { describe, it, expect } from 'vitest';
import {
  GLTF_FEATURE_IDS,
  builtSlotRefs,
  dominantSlot,
  emissiveIsUnused,
  encodeRequests,
  estimateTextureChars,
  imageSourceLossless,
  isGltfFeatureId,
  linearToSrgbHex,
  normalGreenFlipFor,
  orderFeatures,
  planBuiltMaterials,
  plannedTextureDims,
  slotEncodeClass,
  unsupportedFeaturesOf,
  type GltfFeatureId,
} from './gltfImportPlan';
import type { GltfSamplerFeature } from './imageUvMapping';
import { MAX_INDEX_MATERIALS } from '@/engine/materialPartsContract';
import { MAX_IMAGE_ENCODED_CHARS, MAX_SOURCE_PIXELS } from './imageNode';
import { UNTRUSTED_TEXTURE_SIDE } from './textureMemory';
import { glbSlotPolicy } from './glbImportLimits';
import { aiGlb, blenderGlb, manyMaterialsGlb, readOk, scanGlb } from '@/engine/gltfImportFixtures';
import { webpHeaderBytes } from '@/test-utils';
import type { GltfMaterial } from './gltfReader';

/* ── the vocabulary ──────────────────────────────────────────────────────── */

describe('the feature vocabulary', () => {
  it('is closed, and every sampler feature and the texCoord report are members', () => {
    const sampler: GltfSamplerFeature[] = ['wrapMirrored', 'wrapMixed'];
    for (const s of sampler) expect(isGltfFeatureId(s)).toBe(true);
    const tc: GltfFeatureId = 'texCoord';
    expect(isGltfFeatureId(tc)).toBe(true);
    expect(isGltfFeatureId('KHR_materials_clearcoat')).toBe(false);
    expect(isGltfFeatureId('__proto__')).toBe(false);
    expect(isGltfFeatureId('constructor')).toBe(false);
  });

  it('orderFeatures dedupes into the fixed order and ignores junk', () => {
    expect(orderFeatures(['sheen', 'occlusion', 'sheen', 5, null, 'nope', 'clearcoat'])).toEqual([
      'occlusion',
      'clearcoat',
      'sheen',
    ]);
    expect(orderFeatures(new Set(['unlit', 'ior']))).toEqual(['ior', 'unlit']);
    expect(orderFeatures('occlusion')).toEqual([]);
    expect(orderFeatures(null)).toEqual([]);
    expect(orderFeatures(GLTF_FEATURE_IDS)).toEqual([...GLTF_FEATURE_IDS]);
  });
});

/* ── colour ──────────────────────────────────────────────────────────────── */

describe('linearToSrgbHex', () => {
  it('encodes the sRGB transfer curve to 8 bits, lowercase', () => {
    expect(linearToSrgbHex([1, 1, 1])).toBe('#ffffff');
    expect(linearToSrgbHex([0.5, 0.5, 0.5])).toBe('#bcbcbc');
    expect(linearToSrgbHex([0, 0, 0])).toBe('#000000');
    expect(linearToSrgbHex([0.2, 0.6, 0.1])).toBe('#7ccb59');
  });

  it('clamps and treats junk components as 0', () => {
    expect(linearToSrgbHex([2, -1, 0.5])).toBe('#ff00bc');
    expect(linearToSrgbHex(['1', NaN, Infinity] as unknown as number[])).toBe('#000000');
    expect(linearToSrgbHex([])).toBe('#000000');
    expect(linearToSrgbHex(null as unknown as number[])).toBe('#000000');
  });
});

/* ── materials ───────────────────────────────────────────────────────────── */

function mat(over: Partial<GltfMaterial> = {}): GltfMaterial {
  return {
    index: 0,
    name: 'M',
    displayName: 'M',
    baseColorFactor: [1, 1, 1, 1],
    metallicFactor: 1,
    roughnessFactor: 1,
    emissiveFactor: [0, 0, 0],
    emissiveStrength: 1,
    alphaMode: 'OPAQUE',
    alphaCutoff: 0.5,
    doubleSided: false,
    unlit: false,
    slots: [],
    extensions: [],
    unsupportedTextures: [],
    usage: { primitives: 1, withTangents: 0, withVertexColors: 0, withoutNormals: 0, uvSets: [0] },
    ...over,
  };
}

describe('planBuiltMaterials', () => {
  it('builds the requested BUILDABLE materials, ascending, each once', () => {
    const m = readOk(scanGlb());
    expect(planBuiltMaterials(m, [2, 0, 0, 1, 'x', -1, 7, 1.5])).toEqual({ sectioned: [0, 1, 2], keptAuthored: 0 });
  });

  it('ignores a material no primitive uses (the AI fixture\'s "unused")', () => {
    const m = readOk(aiGlb());
    expect(planBuiltMaterials(m, [0, 1])).toEqual({ sectioned: [0], keptAuthored: 0 });
  });

  it('caps at MAX_INDEX_MATERIALS and counts the rest as kept authored', () => {
    const n = MAX_INDEX_MATERIALS + 4;
    const m = readOk(manyMaterialsGlb(n));
    const all = Array.from({ length: n }, (_, i) => i);
    const plan = planBuiltMaterials(m, all);
    expect(plan.sectioned).toEqual(all.slice(0, MAX_INDEX_MATERIALS));
    expect(plan.keptAuthored).toBe(4);
  });

  it('accepts junk for the request list', () => {
    const m = readOk(scanGlb());
    expect(planBuiltMaterials(m, null as unknown as number[])).toEqual({ sectioned: [], keptAuthored: 0 });
  });
});

describe('unsupportedFeaturesOf', () => {
  it('maps the extension list, unlit, occlusion and a normal scale, in the closed order', () => {
    const m = mat({
      extensions: ['KHR_materials_sheen', 'KHR_materials_clearcoat', 'KHR_materials_emissive_strength', 'EXT_junk'],
      unlit: true,
      slots: [
        { slot: 'occlusion', texture: 0, textureInfo: { index: 0 }, strength: 1 },
        { slot: 'normal', texture: 1, textureInfo: { index: 1 }, scale: 0.5 },
      ],
    });
    expect(unsupportedFeaturesOf(m)).toEqual(['occlusion', 'normalScale', 'clearcoat', 'sheen', 'unlit']);
  });

  it('a normal map at scale 1 and a material with nothing special report nothing', () => {
    expect(unsupportedFeaturesOf(mat({ slots: [{ slot: 'normal', texture: 0, textureInfo: { index: 0 }, scale: 1 }] }))).toEqual([]);
    expect(unsupportedFeaturesOf(mat())).toEqual([]);
  });

  it('emissive strength is imported, never reported', () => {
    expect(unsupportedFeaturesOf(mat({ extensions: ['KHR_materials_emissive_strength'] }))).toEqual([]);
  });
});

describe('normalGreenFlipFor', () => {
  it('flips when tangent-less primitives are the majority (a tie included), and reports a mix', () => {
    expect(normalGreenFlipFor(mat({ usage: { primitives: 3, withTangents: 0, withVertexColors: 0, withoutNormals: 0, uvSets: [] } }))).toEqual({ flip: true, mixed: false });
    expect(normalGreenFlipFor(mat({ usage: { primitives: 3, withTangents: 3, withVertexColors: 0, withoutNormals: 0, uvSets: [] } }))).toEqual({ flip: false, mixed: false });
    expect(normalGreenFlipFor(mat({ usage: { primitives: 2, withTangents: 1, withVertexColors: 0, withoutNormals: 0, uvSets: [] } }))).toEqual({ flip: true, mixed: true });
    expect(normalGreenFlipFor(mat({ usage: { primitives: 3, withTangents: 2, withVertexColors: 0, withoutNormals: 0, uvSets: [] } }))).toEqual({ flip: false, mixed: true });
  });

  it('an unused material (no primitives) never flips', () => {
    expect(normalGreenFlipFor(mat({ usage: { primitives: 0, withTangents: 0, withVertexColors: 0, withoutNormals: 0, uvSets: [] } }))).toEqual({ flip: false, mixed: false });
  });
});

describe('emissiveIsUnused / builtSlotRefs', () => {
  it('a black factor or a zero strength makes the emissive slot dead weight', () => {
    expect(emissiveIsUnused(mat())).toBe(true);
    expect(emissiveIsUnused(mat({ emissiveFactor: [0.0001, 0, 0] }))).toBe(true);
    expect(emissiveIsUnused(mat({ emissiveFactor: [0.001, 0, 0] }))).toBe(false);
    expect(emissiveIsUnused(mat({ emissiveFactor: [1, 1, 1], emissiveStrength: 0 }))).toBe(true);
    expect(emissiveIsUnused(mat({ emissiveFactor: [1, 1, 1], emissiveStrength: NaN }))).toBe(true);
    expect(emissiveIsUnused(mat({ emissiveFactor: [0.5, 0.5, 0.5] }))).toBe(false);
  });

  it('builds every slot but occlusion, and emissive only when it can shine', () => {
    const slots: GltfMaterial['slots'] = [
      { slot: 'baseColor', texture: 0, textureInfo: { index: 0 } },
      { slot: 'metallicRoughness', texture: 1, textureInfo: { index: 1 } },
      { slot: 'normal', texture: 2, textureInfo: { index: 2 } },
      { slot: 'occlusion', texture: 1, textureInfo: { index: 1 } },
      { slot: 'emissive', texture: 3, textureInfo: { index: 3 } },
    ];
    expect(builtSlotRefs(mat({ slots })).map((s) => s.slot)).toEqual(['baseColor', 'metallicRoughness', 'normal']);
    expect(builtSlotRefs(mat({ slots, emissiveFactor: [1, 1, 1] })).map((s) => s.slot)).toEqual([
      'baseColor',
      'metallicRoughness',
      'normal',
      'emissive',
    ]);
  });
});

/* ── slot classes ────────────────────────────────────────────────────────── */

describe('slot classes', () => {
  it('colour is never lossless; a lossless data source is lossless-only; a lossy one is lossy', () => {
    expect(slotEncodeClass('baseColor', true)).toEqual({ maxDim: 1024, colour: true, preferLossless: false, losslessOnly: false });
    expect(slotEncodeClass('emissive', true)).toEqual({ maxDim: 1024, colour: true, preferLossless: false, losslessOnly: false });
    expect(slotEncodeClass('normal', true)).toEqual({ maxDim: 512, colour: false, preferLossless: true, losslessOnly: true });
    expect(slotEncodeClass('normal', false)).toEqual({ maxDim: 512, colour: false, preferLossless: false, losslessOnly: false });
    expect(slotEncodeClass('metallicRoughness', true)).toEqual({ maxDim: 512, colour: false, preferLossless: true, losslessOnly: true });
    expect(slotEncodeClass('occlusion', true)).toBeNull();
    expect(slotEncodeClass('constructor', true)).toBeNull();
  });

  it('a normal beats an ORM beats a colour when one image serves several slots', () => {
    expect(dominantSlot('baseColor', 'normal')).toBe('normal');
    expect(dominantSlot('normal', 'metallicRoughness')).toBe('normal');
    expect(dominantSlot('emissive', 'metallicRoughness')).toBe('metallicRoughness');
    expect(dominantSlot('baseColor', 'emissive')).toBe('baseColor');
  });

  it('a PNG and a VP8L WebP are lossless sources; a JPEG and a VP8 WebP are not', () => {
    expect(imageSourceLossless({ format: 'png', bytes: null })).toBe(true);
    expect(imageSourceLossless({ format: 'jpeg', bytes: null })).toBe(false);
    expect(imageSourceLossless({ format: 'webp', bytes: webpHeaderBytes('VP8L', 4, 4) })).toBe(true);
    expect(imageSourceLossless({ format: 'webp', bytes: webpHeaderBytes('VP8 ', 4, 4) })).toBe(false);
    expect(imageSourceLossless({ format: 'webp', bytes: null })).toBe(false);
  });
});

/* ── requests ────────────────────────────────────────────────────────────── */

describe('encodeRequests', () => {
  it('each image once, in first-use order, stored for its most demanding slot', () => {
    const m = readOk(blenderGlb());
    const { requests, unextractable } = encodeRequests(m, [0, 1, 2]);
    // Material 0: base colour (image 0), ORM (image 1, also occlusion — never
    // a request of its own), normal (image 2); material 1 re-uses image 1.
    expect(requests).toEqual([
      { image: 0, slot: 'baseColor' },
      { image: 1, slot: 'metallicRoughness' },
      { image: 2, slot: 'normal' },
    ]);
    expect(unextractable).toEqual([]);
  });

  it('a dark emissive texture is never requested', () => {
    const m = readOk(aiGlb());
    const { requests } = encodeRequests(m, [0]);
    expect(requests.map((r) => r.image)).toEqual([0, 1, 2]);
  });

  it('ignores indices outside the model', () => {
    const m = readOk(scanGlb());
    expect(encodeRequests(m, [9, -1, NaN]).requests).toEqual([]);
  });
});

/* ── THE estimator ───────────────────────────────────────────────────────── */

describe('plannedTextureDims', () => {
  it('fits the header size to the tightest of slot, import size and device', () => {
    expect(plannedTextureDims({ slot: 'baseColor', width: 4096, height: 2048, sourceLossless: false }, null, 2048)).toEqual({ width: 1024, height: 512 });
    expect(plannedTextureDims({ slot: 'normal', width: 4096, height: 2048, sourceLossless: true }, null, 2048)).toEqual({ width: 512, height: 256 });
    expect(plannedTextureDims({ slot: 'baseColor', width: 4096, height: 2048, sourceLossless: false }, 256, 2048)).toEqual({ width: 256, height: 128 });
    expect(plannedTextureDims({ slot: 'baseColor', width: 300, height: 200, sourceLossless: false }, null, 2048)).toEqual({ width: 300, height: 200 });
  });

  it('an unreadable size is the untrusted side; a huge source is scaled past the 64 MP guard first', () => {
    expect(plannedTextureDims({ slot: 'baseColor', width: null, height: 0, sourceLossless: false }, null, 4096)).toEqual({
      width: 1024,
      height: 1024,
    });
    const d = plannedTextureDims({ slot: 'baseColor', width: 16384, height: 16384, sourceLossless: false }, null, 16384)!;
    expect(d.width).toBe(1024);
    const raw = plannedTextureDims({ slot: 'baseColor', width: 16384, height: 16384, sourceLossless: false }, null, 16384);
    expect(raw).not.toBeNull();
    expect(UNTRUSTED_TEXTURE_SIDE).toBe(2048);
    expect(16384 * 16384).toBeGreaterThan(MAX_SOURCE_PIXELS);
  });

  it('a junk device cap reads as the untrusted side; an unbuilt slot is null', () => {
    expect(plannedTextureDims({ slot: 'baseColor', width: 4096, height: 4096, sourceLossless: false }, null, NaN)).toEqual({ width: 1024, height: 1024 });
    expect(plannedTextureDims({ slot: 'occlusion', width: 64, height: 64, sourceLossless: true }, null, 2048)).toBeNull();
  });
});

describe('estimateTextureChars', () => {
  it('follows the slot table: lossless data costs more than lossy, colour is always lossy', () => {
    const png = { slot: 'normal', width: 512, height: 512, sourceLossless: true } as const;
    const jpg = { slot: 'normal', width: 512, height: 512, sourceLossless: false } as const;
    const col = { slot: 'baseColor', width: 1024, height: 1024, sourceLossless: true } as const;
    expect(estimateTextureChars(png, null, 2048)).toBeGreaterThan(estimateTextureChars(jpg, null, 2048));
    const policy = glbSlotPolicy('baseColor')!;
    expect(estimateTextureChars(col, null, 2048)).toBe(Math.ceil((1024 * 1024 * policy.lossyBpp) / 6) + 32);
  });

  it('never exceeds the per-image budget (it halves as the encoder would) and is 0 for an unbuilt slot', () => {
    const big = { slot: 'normal', width: 8192, height: 8192, sourceLossless: true } as const;
    expect(estimateTextureChars(big, null, 8192)).toBeLessThanOrEqual(MAX_IMAGE_ENCODED_CHARS);
    expect(estimateTextureChars({ slot: 'occlusion', width: 64, height: 64, sourceLossless: true }, null, 2048)).toBe(0);
  });

  it('SCAN-shaped materials land near the doc\'s band at 1024 (0.45M–0.9M chars per material — the merged table is the HIGHER bpp of the two drafts), AI in 0.2M–0.45M', () => {
    const scan =
      estimateTextureChars({ slot: 'baseColor', width: 4096, height: 4096, sourceLossless: false }, 1024, 2048) +
      estimateTextureChars({ slot: 'normal', width: 4096, height: 4096, sourceLossless: true }, 1024, 2048) +
      estimateTextureChars({ slot: 'metallicRoughness', width: 4096, height: 4096, sourceLossless: true }, 1024, 2048);
    expect(scan).toBeGreaterThan(450_000);
    expect(scan).toBeLessThan(900_000);
    const ai =
      estimateTextureChars({ slot: 'baseColor', width: 2048, height: 2048, sourceLossless: false }, 1024, 2048) +
      estimateTextureChars({ slot: 'normal', width: 1024, height: 1024, sourceLossless: false }, 1024, 2048) +
      estimateTextureChars({ slot: 'metallicRoughness', width: 1024, height: 1024, sourceLossless: false }, 1024, 2048);
    expect(ai).toBeGreaterThan(200_000);
    expect(ai).toBeLessThan(450_000);
  });
});
