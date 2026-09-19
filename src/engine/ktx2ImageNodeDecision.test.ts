/**
 * Phase 8's Image-node decision, OPTION A (the owner's compatibility-first
 * default): an Image node NEVER samples KTX2.
 *
 * An HTMLImageElement cannot decode a KTX2 container, so a GPU-compressed
 * Image node would need a third resolution/emission mode (a CompressedTexture)
 * that loader 0.6 pages and plain-three pages cannot run. Under Option A the
 * shader's own textures stay WebP/PNG/JPEG — graphToCode, imageTexturePlan,
 * imageTextureSpec, imageAssets and the `.js` export are byte-identical — and
 * KTX2 appears only as EXTRA `KHR_texture_basisu` sources in the single-GLB
 * export, for other glTF viewers.
 *
 * DELETING THIS FILE IS HOW OPTION B STARTS, and it must be deliberate.
 *
 * Cross-reference: `registry/imageGraphByteStability.test.ts` (Phase 2) — and
 * Phase 4's `imageOutOnlyByteStability` once it lands — must keep passing
 * WITHOUT `-u`; a KTX2 emission mode would move exactly those snapshots.
 *
 * The single-GLB half is `skipIf` until Phase 7 Step 1 adds its contract leaf.
 * The repacker's `assets` targets are, by that contract, the exact bytes of
 * each Image node's `imageAssetFor(node).src`, so the payload pins below are
 * what keeps a KTX2 image from ever being one; the behavioural repacker pin
 * (no `assets` value names an `image/ktx2` image) belongs to the Step 5
 * repacker suite, beside the code that writes KTX2 sources at all.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { imageAssetFor } from './imageAssets';
import { validImageDataUrl } from '@/utils/imageNode';
import { KTX2_IDENTIFIER } from '@/utils/ktx2Header';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const source = (rel: string) => readFileSync(here(rel), 'utf8');

/** A KTX2 payload as an Image node would hold it, were the whitelist ever widened. */
const KTX2_BYTES = readFileSync(here('./fixtures/ktx2/2d_uastc.ktx2'));
const KTX2_DATA_URL = `data:image/ktx2;base64,${KTX2_BYTES.toString('base64')}`;

describe('Option A: an Image node never samples KTX2', () => {
  it.each(['./graphToCode.ts', './imageTexturePlan.ts', '../utils/imageTextureSpec.ts', './imageAssets.ts'])(
    '%s has no KTX2 branch',
    (rel) => {
      expect(source(rel)).not.toMatch(/ktx2/i);
    },
  );

  it('an Image-node payload can only be PNG, JPEG or WebP', () => {
    const imageNode = source('../utils/imageNode.ts');
    expect(imageNode).toContain("const IMAGE_MIME_TYPES = ['png', 'jpeg', 'webp'] as const;");
    expect(imageNode).toContain('const IMAGE_DATA_URL_RE = /^data:image\\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;');
    expect([...KTX2_BYTES.subarray(0, 12)]).toEqual([...KTX2_IDENTIFIER]);
    expect(validImageDataUrl(KTX2_DATA_URL)).toBeNull();
  });

  it('so a KTX2 payload never becomes an image asset (the only thing a single-GLB `assets` entry can target)', () => {
    expect(imageAssetFor('imageNode_1', { imageB64: KTX2_DATA_URL })).toBeNull();
  });

  it('the Phase 2 image-graph byte-stability snapshot carries no KTX2', () => {
    expect(source('../registry/__snapshots__/imageGraphByteStability.test.ts.snap')).not.toMatch(/ktx2/i);
  });
});

const CONTRACT = here('./glbShaderContract.ts');

describe.skipIf(!existsSync(CONTRACT))('Option A in the single-GLB format (Phase 7 Step 1)', () => {
  it('FS_ASSET_MIMES is exactly PNG, JPEG and WebP: an image/ktx2 image is never an `assets` target', async () => {
    // Non-literal specifier: the leaf does not exist until Phase 7 Step 1.
    const { FS_ASSET_MIMES } = (await import(/* @vite-ignore */ CONTRACT)) as { FS_ASSET_MIMES: readonly string[] };
    expect([...FS_ASSET_MIMES]).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });
});
