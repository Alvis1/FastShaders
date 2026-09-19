import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ALLOW_MANY_MATERIALS_KEY,
  GLB_IMPORT_MATERIAL_LIMIT,
  IMPORT_AT_LADDER,
  allowManyMaterialsFrom,
  glbSlotPolicy,
  type GlbSlot,
} from './glbImportLimits';
import type { GltfSlot } from './gltfReader';
import { MAX_INDEX_MATERIALS } from '../engine/materialPartsContract';
import { MAX_IMAGE_DIM } from './imageNode';

const SRC = readFileSync(new URL('./glbImportLimits.ts', import.meta.url), 'utf8');

// The slots this table covers are exactly the reader's minus occlusion. A
// mismatch in either direction fails `tsc`, not only this suite.
type Built = Exclude<GltfSlot, 'occlusion'>;
type SameSet = [Built] extends [GlbSlot] ? ([GlbSlot] extends [Built] ? true : false) : false;
const SAME_SET: SameSet = true;
const BUILT: Record<GlbSlot, true> = { baseColor: true, emissive: true, normal: true, metallicRoughness: true };

const isPot = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

describe('glbImportLimits: a leaf', () => {
  it('imports nothing, not even a type — the store reads it at module scope', () => {
    expect(SRC).not.toMatch(/^\s*import\s/m);
    expect(SRC).not.toMatch(/\brequire\(/);
    expect(SRC).not.toMatch(/\bimport\(/);
  });

  it('defines neither the pre-read cap nor the untrusted texture side (one copy each, elsewhere)', () => {
    expect(SRC).not.toMatch(/export const (GLB_INSPECT_MAX_BYTES|GLB_READ_MAX_BYTES|UNKNOWN_TEXTURE_SIDE|UNTRUSTED_TEXTURE_SIDE)\b/);
  });
});

describe('glbImportLimits: the constants', () => {
  it('the setting key and the material limit', () => {
    expect(ALLOW_MANY_MATERIALS_KEY).toBe('fs:allowManyMaterials');
    expect(GLB_IMPORT_MATERIAL_LIMIT).toBe(10);
  });

  it('the material limit sits under the editor\'s index-section cap', () => {
    expect(GLB_IMPORT_MATERIAL_LIMIT).toBeLessThanOrEqual(MAX_INDEX_MATERIALS);
  });

  it('the Import-at ladder descends through powers of two and starts at the largest slot cap', () => {
    expect([...IMPORT_AT_LADDER]).toEqual([1024, 512, 256, 128]);
    for (let i = 1; i < IMPORT_AT_LADDER.length; i++) expect(IMPORT_AT_LADDER[i]).toBeLessThan(IMPORT_AT_LADDER[i - 1]);
    expect(IMPORT_AT_LADDER.every(isPot)).toBe(true);
    const largest = Math.max(...(Object.keys(BUILT) as GlbSlot[]).map((s) => glbSlotPolicy(s)!.maxDim));
    expect(IMPORT_AT_LADDER[0]).toBe(largest);
  });
});

describe('glbSlotPolicy: THE slot table', () => {
  it('covers exactly the slots the builder builds', () => {
    expect(SAME_SET).toBe(true);
    for (const slot of Object.keys(BUILT)) expect(glbSlotPolicy(slot), slot).not.toBeNull();
    expect(glbSlotPolicy('occlusion')).toBeNull();
  });

  it('holds the conservative (higher) bits per pixel of the two drafts', () => {
    expect(glbSlotPolicy('baseColor')).toEqual({ maxDim: 1024, colour: true, losslessBpp: 1.5, lossyBpp: 1.5 });
    expect(glbSlotPolicy('emissive')).toEqual({ maxDim: 1024, colour: true, losslessBpp: 1.5, lossyBpp: 1.5 });
    expect(glbSlotPolicy('normal')).toEqual({ maxDim: 512, colour: false, losslessBpp: 7.5, lossyBpp: 1.8 });
    expect(glbSlotPolicy('metallicRoughness')).toEqual({ maxDim: 512, colour: false, losslessBpp: 6, lossyBpp: 1.8 });
  });

  it('a colour slot is never priced lossless; a data slot costs more lossless than lossy', () => {
    for (const slot of Object.keys(BUILT)) {
      const p = glbSlotPolicy(slot)!;
      if (p.colour) expect(p.losslessBpp, slot).toBe(p.lossyBpp);
      else expect(p.losslessBpp, slot).toBeGreaterThan(p.lossyBpp);
    }
  });

  it('every slot cap is a power of two no larger than the drop\'s own default cap', () => {
    for (const slot of Object.keys(BUILT)) {
      const { maxDim } = glbSlotPolicy(slot)!;
      expect(isPot(maxDim), slot).toBe(true);
      expect(maxDim, slot).toBeLessThanOrEqual(MAX_IMAGE_DIM);
    }
  });

  it('answers frozen, shared objects that a caller cannot edit', () => {
    const p = glbSlotPolicy('normal')!;
    expect(Object.isFrozen(p)).toBe(true);
    expect(glbSlotPolicy('normal')).toBe(p);
    expect(glbSlotPolicy('baseColor')).toBe(glbSlotPolicy('emissive'));
  });

  it('is null for anything else, the prototype names included', () => {
    for (const junk of [
      undefined, null, 0, 1, true, {}, [], '', 'BaseColor', ' baseColor', 'baseColor ', 'metallic',
      '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf',
    ]) {
      expect(glbSlotPolicy(junk), String(junk)).toBeNull();
    }
  });
});

describe('allowManyMaterialsFrom', () => {
  it('is on only for the exact string "1"', () => {
    expect(allowManyMaterialsFrom('1')).toBe(true);
    for (const raw of ['0', '', ' 1', '1 ', 'true', 'yes', '１', '01', 1, true, null, undefined, {}]) {
      expect(allowManyMaterialsFrom(raw), JSON.stringify(raw)).toBe(false);
    }
  });
});
