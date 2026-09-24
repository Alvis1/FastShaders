/**
 * Every picture still inside the loaded 3D model, offered to the Image node's
 * texture picker (2026-09-19). The 'model' source kind
 * `textureSources.ts` had declared since day one.
 *
 * What matters here, and why each of them is a way the feature goes wrong
 * quietly:
 *  1. only pictures the reader could actually READ are offered — a cell that
 *    fails on click is worse than a cell that is not there;
 *  2. one entry per IMAGE, not per texture: two textures differing only in
 *    sampler share one picture, and two identical cells read as two pictures;
 *  3. the SLOT travels with the entry, because it decides the encode class —
 *    a normal map re-encoded through a colour slot's lossy settings is the
 *    bug you only see on the mesh;
 *  4. occlusion never picks the occlusion class (the encoder refuses it
 *    outright: `glbSlotPolicy` answers null), so such a picture falls back to
 *    colour rather than becoming unpickable;
 *  5. the subscription key is cheap and changes when the model does.
 */
import { describe, it, expect } from 'vitest';
import { modelTextureSources, modelTextureKey } from './modelTextureSources';
import { readOk, aiGlb, blenderGlb, allSlotsGlb, glbOf, PNG_COLOR, PNG_NORMAL } from '@/engine/gltfImportFixtures';
import { glbSlotPolicy } from './glbImportLimits';

describe('what the model offers', () => {
  it('lists every readable image of a PBR model, in file order', () => {
    const m = readOk(aiGlb());
    const src = modelTextureSources(m, 'robot.glb');
    expect(src.map((s) => s.image)).toEqual([0, 1, 2, 3]);
    for (const s of src) {
      expect(s.kind).toBe('model');
      expect(s.fileName.length).toBeGreaterThan(0);
      expect(s.byteLength).toBeGreaterThan(0);
    }
  });

  it('carries the slot each picture serves — the encode class depends on it', () => {
    // aiGlb: image 0 baseColor, 1 metallicRoughness, 2 normal, 3 emissive.
    const src = modelTextureSources(readOk(aiGlb()), 'robot.glb');
    expect(src.map((s) => s.slot)).toEqual(['baseColor', 'metallicRoughness', 'normal', 'emissive']);
    // Every slot it can report is one the encoder actually has a policy for.
    for (const s of src) expect(glbSlotPolicy(s.slot), s.slot).not.toBeNull();
  });

  it('reports the MOST demanding slot when one picture serves several', () => {
    // One image used as both baseColor and normal: normal outranks colour
    // (SLOT_RANK), so it is encoded losslessly rather than as a lossy photo.
    const bytes = glbOf(
      {
        images: [{ bufferView: 1, mimeType: 'image/png' }],
        textures: [{ source: 0 }],
        materials: [
          { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
          { normalTexture: { index: 0 } },
        ],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 0 }, material: 0 }] },
          { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 0 }, material: 1 }] },
        ],
        nodes: [{ mesh: 0 }, { mesh: 1 }],
        scenes: [{ nodes: [0, 1] }],
        scene: 0,
      },
      [PNG_NORMAL],
    );
    const src = modelTextureSources(readOk(bytes), 'm.glb');
    expect(src).toHaveLength(1);
    expect(src[0].slot).toBe('normal');
  });

  it('never reports `occlusion` — the encoder has no policy for it', () => {
    // An occlusion-only picture is still offered; it is encoded as colour,
    // which is the only class that can hold an arbitrary picture. Reporting
    // the real slot would make `glbSlotPolicy` refuse the encode and the cell
    // would fail on click.
    const bytes = glbOf(
      {
        images: [{ bufferView: 1, mimeType: 'image/png' }],
        textures: [{ source: 0 }],
        materials: [{ occlusionTexture: { index: 0 } }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 0 }, material: 0 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      [PNG_COLOR],
    );
    const src = modelTextureSources(readOk(bytes), 'ao.glb');
    expect(src).toHaveLength(1);
    expect(src[0].slot).toBe('baseColor');
    expect(glbSlotPolicy(src[0].slot)).not.toBeNull();
  });

  it('offers a picture no material references — as colour', () => {
    const bytes = glbOf(
      {
        images: [{ bufferView: 1, mimeType: 'image/png' }],
        textures: [{ source: 0 }],
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      [PNG_COLOR],
    );
    const src = modelTextureSources(readOk(bytes), 'orphan.glb');
    expect(src.map((s) => s.slot)).toEqual(['baseColor']);
  });

  it('one entry per IMAGE, however many textures point at it', () => {
    const bytes = glbOf(
      {
        images: [{ bufferView: 1, mimeType: 'image/png' }],
        samplers: [{ wrapS: 33071 }, { wrapS: 10497 }],
        // Two textures, one picture, differing only in sampler.
        textures: [{ source: 0, sampler: 0 }, { source: 0, sampler: 1 }],
        materials: [
          { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
          { pbrMetallicRoughness: { baseColorTexture: { index: 1 } } },
        ],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 0 }, material: 0 }] },
          { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 0 }, material: 1 }] },
        ],
        nodes: [{ mesh: 0 }, { mesh: 1 }],
        scenes: [{ nodes: [0, 1] }],
        scene: 0,
      },
      [PNG_COLOR],
    );
    expect(modelTextureSources(readOk(bytes), 'twice.glb')).toHaveLength(1);
  });

  it('a model with no textures offers nothing, and does not throw', () => {
    expect(modelTextureSources(readOk(blenderGlb()), 'b.glb').length).toBeGreaterThanOrEqual(0);
    const bare = glbOf(
      {
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      [],
    );
    expect(modelTextureSources(readOk(bare), 'bare.glb')).toEqual([]);
  });

  it('carries the header dimensions when the reader read them, 0 otherwise', () => {
    for (const s of modelTextureSources(readOk(allSlotsGlb()), 'all.glb')) {
      expect(Number.isInteger(s.width)).toBe(true);
      expect(Number.isInteger(s.height)).toBe(true);
      expect(s.width).toBeGreaterThanOrEqual(0);
      expect(s.height).toBeGreaterThanOrEqual(0);
    }
  });

  it('is DESCRIPTION only — no pixels leave this module', () => {
    for (const s of modelTextureSources(readOk(aiGlb()), 'robot.glb')) {
      const v = s as unknown as Record<string, unknown>;
      expect(v.bytes).toBeUndefined();
      expect(v.dataUrl).toBeUndefined();
      // Everything it does carry is a string or a number.
      for (const [k, val] of Object.entries(v)) {
        expect(['string', 'number'], k).toContain(typeof val);
      }
    }
  });
});

describe('modelTextureKey', () => {
  const mesh = (id: number, bytes: number[]) => ({ id, name: 'm.glb', bytes: new Uint8Array(bytes) });

  it('is empty for no model, so the picker parses nothing', () => {
    expect(modelTextureKey(null)).toBe('');
    expect(modelTextureKey(undefined)).toBe('');
    expect(modelTextureKey(mesh(1, []))).toBe('');
    expect(modelTextureKey({ bytes: new Uint8Array([1]) })).toBe('');
  });

  it('moves with the LOAD, not the bytes — a re-drop of the same file is new', () => {
    const a = modelTextureKey(mesh(1, [1, 2, 3]));
    expect(a).not.toBe('');
    expect(modelTextureKey(mesh(2, [1, 2, 3]))).not.toBe(a);
  });

  it('is stable for the same model — the parse must not re-run per notify', () => {
    expect(modelTextureKey(mesh(7, [1, 2, 3]))).toBe(modelTextureKey(mesh(7, [9, 9, 9])));
  });
});
