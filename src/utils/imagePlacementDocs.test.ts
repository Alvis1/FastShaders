import { describe, it, expect } from 'vitest';
import { projectDocs } from '@/projectDocs';
import { readImagePlacement } from './imagePlacement';
import { turnSignOf } from './imageUvMapping';

/**
 * The Texture (Image) node's placement, as the DOCUMENTATION states it: ONE set
 * of controls (Tile, Offset, one Rotation, the Flips) over one chain, where the
 * node used to carry a second Offset, Scale and Rotation and a "UV orientation"
 * switch in a "glTF mapping" fold-out (2026-10-08). The behaviour has its own
 * suites (imagePlacement, imageRotation, imagePlacementSettings, glbExportPlan,
 * resetNodeValues); this one pins the CLAIM — through `projectDocs()`, so it
 * holds wherever in CLAUDE.md or docs/dev the paragraph lives, and a retracted
 * sentence may not come back in ANY of those files.
 */
const DOCS = projectDocs();

describe('the docs state ONE placement', () => {
  it('names the chain, the turn’s sign, the one reader and where the legacy transform folds', () => {
    for (const claim of [
      'mirror → tile → offset → turn about (½,½)',
      'ψ = θ·(exactly one Flip ticked ? −1 : 1)',
      '`readImagePlacement`',
      '`turnSignOf`',
      '`sanitizeImageNodes(nodes, edges)`',
      '`orientation` is a fact about the BYTES',
      'it sets `Texture.flipY` and nothing else',
      'Older transform',
      '`PRESERVED_KEYS.imageNode` is the payload and provenance keys plus `orientation`, `uvSet` and `normalGreen`',
      // No baked mirror (2026-10-08): a picture is sampled as stored, and the
      // generated spherical UVs run as three's own sphere's do.
      'A picture is sampled as stored: each ticked Flip box mirrors its axis, in either orientation, and NOTHING else mirrors.',
      'must never return — fix a shape\'s UVs, never the picture',
      'A baked mirror must not come back',
      'Generated spherical UVs are three\'s own SphereGeometry parameterization',
      'glTF(fx, fy, K, ox, oy, θ) ≡ app(fx, ¬fy, K, ox, 1 − ky − oy, θ)',
      // The sign is three.js's and glTF's; which way it reads is the SHAPE's
      // (engine/imageRotation.test.ts measures both senses in three UV frames).
      'The sign is three.js\'s and glTF\'s',
      'the sense is θ·sign(det uv→screen)·sign(tileX·tileY)',
      'COUNTER-clockwise on the Sphere, Plane, Cube, Teapot and Bunny',
      'imports as Rotation φ, the file\'s own number',
      // Negative scales become Flips (utils/imageUvMapping.ts `storedPlacement`).
      'never WRITE a negative Tile',
      '`storedPlacement`',
      'K·(d·u + e) + o ≡ (−K)·(−d·u + 1 − e) + (o + K)',
      'A Tile the user TYPES negative is allowed',
      'A Tile the user types negative on exactly one axis mirrors once more and reverses the turn',
    ]) {
      expect(DOCS, claim).toContain(claim);
    }
  });

  it('the documented sign and mirror are the ones the code uses, in all 8 orientation × flip states', () => {
    const theta = 0.5;
    for (const gltf of [false, true]) {
      for (const flipX of [0, 1]) {
        for (const flipY of [0, 1]) {
          const p = readImagePlacement({ ...(gltf ? { orientation: 'gltf' } : {}), flipX, flipY, rotation: theta });
          // ψ = θ·(exactly one Flip ticked ? −1 : 1), as written above.
          const documented = theta * ((flipX === 1) !== (flipY === 1) ? -1 : 1);
          expect(p.psi, JSON.stringify({ gltf, flipX, flipY })).toBe(documented);
          expect(turnSignOf(flipX === 1, flipY === 1)).toBe(documented / theta);
          // Each ticked box mirrors its axis, and nothing else does.
          expect([p.mirrorX, p.mirrorY], JSON.stringify({ gltf, flipX, flipY })).toEqual([flipX === 1, flipY === 1]);
        }
      }
    }
  });
});

describe('the docs no longer describe the retired fold-out', () => {
  it('nor its eight keys, its two writers, its Reset rule or its rows', () => {
    for (const retracted of [
      'The glTF mapping is four settings over eight keys',
      'over eight `values` keys',
      'a Reset keeps all eight',
      'the eight glTF mapping keys',
      '`withUvMapping` / `gltfTextureValues` are the ONLY writers',
      'its ImageMappingSettings (the collapsed',
      "the orientation row's title says so",
      'NodeSettingsMenu has a "UV / Texture" section',
    ]) {
      expect(DOCS, retracted).not.toContain(retracted);
    }
  });

  it('nor a turn that reads counter-clockwise on every shape, nor one reader for every surface', () => {
    for (const retracted of [
      'COUNTER-clockwise about its own centre in all 8 orientation × flip states',
      'keep a positive θ counter-clockwise in all 8 orientation × flip states',
      'the turn reads counter-clockwise on the sphere',
      'read only through `readImagePlacement`',
      'the ONE parameter row the settings menus draw',
    ]) {
      expect(DOCS, retracted).not.toContain(retracted);
    }
  });

  it('nor the sign before 2026-10-08: clockwise on three’s primitives, a model’s φ stored negated', () => {
    for (const retracted of [
      'ψ = θ·(glTF ? −1 : 1)',
      '−θ·sign(det uv→screen)',
      'ψ·det = −θ',
      'Rotation θ = −φ',
      'Rotation −30°',
      // A negative scale imports and folds as a Flip now, never a negative Tile.
      'an import writes one from a negative KHR scale',
    ]) {
      expect(DOCS, retracted).not.toContain(retracted);
    }
    // A positive turn reading CLOCKWISE on a built-in shape may not come back
    // in any wording or case — the Bunny included since 2026-10-08, when its
    // generated UVs took three's sphere handedness (it read clockwise before).
    expect(DOCS).not.toMatch(/(?<!counter-)clockwise on the (Sphere|Plane|Cube|Utah Teapot|Teapot)/i);
    expect(DOCS).not.toMatch(/(?<!counter-)clockwise on (the )?(Stanford )?(Bunny|Bunny's)/i);
  });

  it('nor the baked 1-u: a picture mirrored by default, the reason given for it, or what followed from it', () => {
    for (const retracted of [
      'ψ = θ·(glTF ? 1 : −1)',
      'NB the raw sample renders mirrored left-right in the preview',
      'codegen bakes the `1-u` correction into the DEFAULT',
      '`mirrorX = flipX < 0.5`',
      'the UNCHECKED default is what carries the 1-u correction',
      'the 1-u default already reads mirrored',
      'which is also why the app\'s 1-u default already reads mirrored there',
      'and drops the baked 1-u correction',
      'app(¬fx, ¬fy, K, ox, 1 − ky − oy, θ)',
      'renders turned 180° while the card stays upright',
      'an Image node mirrors u by default',
      'clockwise on the Stanford Bunny\'s spherical UVs',
    ]) {
      expect(DOCS, retracted).not.toContain(retracted);
    }
  });
});
