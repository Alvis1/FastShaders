/**
 * The translated model notices (N3 too-large, N13 compressed + KTX2 fallback,
 * N7 cache-full). Every key is the English text AND its lv.json `ui` key, so
 * these pin that each one really has a Latvian entry carrying the same
 * placeholders — a key without one falls back to English silently.
 */
import { describe, it, expect } from 'vitest';
import lv from '@/i18n/lv.json';
import {
  meshRefusalMessage,
  MESH_KTX2_FALLBACK_KEY,
  MESH_CACHE_FULL_KEY,
  MESH_DECODER_LOAD_KEY,
  MESH_DECODER_EMPTY_KEY,
  MESH_DECODER_TOO_LARGE_KEY,
  GLTF_BUILD_REFUSED_KEY,
  GLTF_IMAGE_SKIP_KEYS,
  GLTF_READ_REASON_KEYS,
  gltfBuildRefusalMessage,
  gltfImageSkipReason,
  type GltfImageSkip,
} from './previewMeshMessage';
import { GLTF_IMAGE_MAX_BYTES, type GltfReadRefusalReason } from './gltfReader';
import {
  modelTooLargeRefusal,
  MESH_TOO_LARGE_KEY,
  MESH_COMPRESSED_KEY,
  MESH_EMPTY_KEY,
} from './previewMesh';

const UI = lv.ui as Record<string, string>;
const MiB = 1048576;

function placeholders(s: string): string[] {
  return (s.match(/\{[a-z]+\}/g) ?? []).sort();
}

describe('meshRefusalMessage', () => {
  it('fills the N3 sentence in Latvian with a decimal comma', () => {
    expect(meshRefusalMessage(modelTooLargeRefusal(80.5 * MiB), 'lv')).toBe(
      'Modelis ir pārāk liels (80,5 MB — maks. 64 MB). Samaziniet tā poligonu skaitu vai tekstūru izmērus un eksportējiet to vēlreiz no savas 3D programmas.',
    );
  });

  it('fills the N3 sentence in English', () => {
    expect(meshRefusalMessage(modelTooLargeRefusal(80.5 * MiB), 'en')).toContain('(80.5 MB — max 64 MB)');
  });

  it('puts the compression name in BOTH {ext} slots of the N13 sentence', () => {
    const msg = meshRefusalMessage(
      { reason: 'compressed', key: MESH_COMPRESSED_KEY, name: 'robot.glb', ext: 'Draco' },
      'lv',
    );
    expect(msg.match(/Draco/g)).toHaveLength(2);
    expect(msg.startsWith('“robot.glb” izmanto Draco saspiešanu')).toBe(true);
  });

  it('translates a key-only refusal', () => {
    expect(meshRefusalMessage({ reason: 'empty', key: MESH_EMPTY_KEY }, 'lv')).toBe('Modeļa fails ir tukšs.');
  });
});

describe('model notice keys in lv.json', () => {
  it.each([
    MESH_TOO_LARGE_KEY,
    MESH_COMPRESSED_KEY,
    MESH_KTX2_FALLBACK_KEY,
    MESH_CACHE_FULL_KEY,
    MESH_DECODER_LOAD_KEY,
    MESH_DECODER_EMPTY_KEY,
    MESH_DECODER_TOO_LARGE_KEY,
  ])(
    'has a Latvian entry with the same placeholders: %s',
    (key) => {
      expect(typeof UI[key]).toBe('string');
      expect(UI[key].length).toBeGreaterThan(0);
      expect(placeholders(UI[key])).toEqual(placeholders(key));
    },
  );

  it('dropped the dead short key the old interpolated notice used', () => {
    expect(Object.prototype.hasOwnProperty.call(UI, 'Model too large')).toBe(false);
  });
});

describe('glTF build refusals and texture skips (the model reader, Phase 5)', () => {
  const KEYS = [GLTF_BUILD_REFUSED_KEY, ...GLTF_READ_REASON_KEYS.values(), ...GLTF_IMAGE_SKIP_KEYS.values()];

  it.each(KEYS)('has a Latvian entry that differs from the English, same placeholders: %s', (key) => {
    expect(typeof UI[key]).toBe('string');
    expect(UI[key]).not.toBe(key);
    expect(placeholders(UI[key])).toEqual(placeholders(key));
  });

  it('covers every refusal reason but too-large, and every skip', () => {
    const reasons: Exclude<GltfReadRefusalReason, 'too-large'>[] = ['unreadable', 'too-complex', 'external-data', 'invalid-model'];
    expect([...GLTF_READ_REASON_KEYS.keys()].sort()).toEqual([...reasons].sort());
    const skips: GltfImageSkip[] = ['external', 'ktx2-only', 'unsupported-format', 'damaged', 'too-large', 'compressed-view'];
    expect([...GLTF_IMAGE_SKIP_KEYS.keys()].sort()).toEqual([...skips].sort());
  });

  it('fills a file name spelling {reason} without letting it capture the slot (EN and LV)', () => {
    const r = { reason: 'external-data' as const, detail: 'buffer:0' };
    expect(gltfBuildRefusalMessage(r, '{reason}.glb', 0, 'en')).toBe(
      "Can't build a shader from the materials of “{reason}.glb”. Part of its data is stored in separate files; export it as a single .glb.",
    );
    expect(gltfBuildRefusalMessage(r, '{reason}.glb', 0, 'lv')).toBe(
      'Nevar izveidot ēnotāju no faila “{reason}.glb” materiāliem. Daļa tā datu glabājas atsevišķos failos; eksportējiet to kā vienu .glb failu.',
    );
  });

  it('routes too-large to the too-large model sentence, with the size filled', () => {
    const size = 100.2 * MiB;
    const r = { reason: 'too-large' as const, detail: 'size' };
    expect(gltfBuildRefusalMessage(r, 'scan.glb', size, 'lv')).toBe(meshRefusalMessage(modelTooLargeRefusal(size), 'lv'));
    expect(gltfBuildRefusalMessage(r, 'scan.glb', size, 'en')).toContain('(100.2 MB — max 64 MB)');
  });

  it('reads no-readable-source as the unsupported-format text', () => {
    expect(gltfImageSkipReason('no-readable-source', 'en')).toBe('an image format FastShaders cannot read');
    expect(gltfImageSkipReason('no-readable-source', 'lv')).toBe(gltfImageSkipReason('unsupported-format', 'lv'));
    expect(gltfImageSkipReason('ktx2-only', 'lv')).toBe('tikai KTX2, bez rezerves attēla');
  });

  it("the '64' in 'larger than 64 MB' is GLTF_IMAGE_MAX_BYTES", () => {
    const text = GLTF_IMAGE_SKIP_KEYS.get('too-large')!;
    expect(Number(/(\d+) MB/.exec(text)![1])).toBe(GLTF_IMAGE_MAX_BYTES / 2 ** 20);
    expect(UI[text]).toContain(`${GLTF_IMAGE_MAX_BYTES / 2 ** 20} MB`);
  });
});
