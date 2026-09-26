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
  MESH_SPLAT_HEADSET_KEY,
  MESH_SPLAT_SH_DROPPED_KEY,
  GLTF_BUILD_REFUSED_KEY,
  GLTF_IMAGE_SKIP_KEYS,
  GLTF_READ_REASON_KEYS,
  gltfBuildRefusalMessage,
  gltfImageSkipReason,
  splatHeadsetMessage,
  splatShDroppedMessage,
  type GltfImageSkip,
} from './previewMeshMessage';
import {
  MESH_BAD_KSPLAT_KEY,
  MESH_BAD_PLY_KEY,
  MESH_BAD_SPLAT_KEY,
  MESH_BAD_SPZ_KEY,
  MESH_DROP_HINT_KEY,
  MESH_GLTF_SPLAT_KEY,
  MESH_PLY_COMPRESSED_KEY,
  MESH_PLY_NOT_SPLAT_KEY,
  MESH_PLY_SH_KEY,
  MESH_SPLAT_COUNT_KEY,
  MESH_SPLAT_EVAL_KEY,
  MESH_SPZ_TOO_LARGE_KEY,
  MESH_SPZ_VERSION_KEY,
  MESH_UNSUPPORTED_KEY,
  sniffSplat,
  splatCountRefusal,
  type MeshRefusal,
} from './previewMesh';
import { SPLAT_HEADSET_ADVISORY_COUNT, SPZ_MAX_DECODED_BYTES } from './splatLimits';
import { GLTF_IMAGE_MAX_BYTES, type GltfReadRefusalReason } from './gltfReader';
import {
  modelTooLargeRefusal,
  preReadModelGate,
  GLB_READ_MAX_BYTES,
  MESH_MAX_BYTES,
  MESH_TOO_LARGE_KEY,
  MESH_COMPRESSED_KEY,
  MESH_EMPTY_KEY,
} from './previewMesh';
// previewMesh.ts re-exports the gltfCompression leaf, but not this key (yet).
import { MESH_TOO_LARGE_LIMIT_KEY } from './gltfCompression';

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

  it('names the cap that was APPLIED, not always the 64 MiB model gate', () => {
    // The build-from-materials path reads a `.glb` up to GLB_READ_MAX_BYTES
    // (96 MiB on the web — vitest's profile — and 256 in the desktop room).
    // Reporting that through the model-gate sentence named a ceiling 1.5x, on
    // desktop 4x, BELOW the one actually enforced.
    const overRead = preReadModelGate('glb', GLB_READ_MAX_BYTES + 1, true)!;
    expect(meshRefusalMessage(overRead, 'en')).toContain('(96.1 MB — max 96 MB)');
    expect(meshRefusalMessage(overRead, 'lv')).toContain('(96,1 MB — maks. 96 MB)');
    expect(overRead.limitBytes).toBe(GLB_READ_MAX_BYTES);
    // Every other drop is still the 64 MiB gate, word for word.
    for (const r of [preReadModelGate('obj', MESH_MAX_BYTES + 1, true)!, preReadModelGate('glb', MESH_MAX_BYTES + 1, false)!]) {
      expect(r.limitBytes).toBeUndefined();
      expect(meshRefusalMessage(r, 'en')).toContain('(64.1 MB — max 64 MB)');
    }
  });

});

describe('model notice keys in lv.json', () => {
  it.each([
    MESH_TOO_LARGE_KEY,
    MESH_TOO_LARGE_LIMIT_KEY,
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

describe('Gaussian-splat notice keys in lv.json', () => {
  it.each([
    MESH_UNSUPPORTED_KEY,
    MESH_DROP_HINT_KEY,
    MESH_BAD_SPLAT_KEY,
    MESH_SPLAT_COUNT_KEY,
    MESH_BAD_SPZ_KEY,
    MESH_BAD_PLY_KEY,
    MESH_BAD_KSPLAT_KEY,
    MESH_PLY_NOT_SPLAT_KEY,
    MESH_PLY_SH_KEY,
    MESH_PLY_COMPRESSED_KEY,
    MESH_SPZ_VERSION_KEY,
    MESH_SPZ_TOO_LARGE_KEY,
    MESH_GLTF_SPLAT_KEY,
    MESH_SPLAT_EVAL_KEY,
    MESH_SPLAT_HEADSET_KEY,
    MESH_SPLAT_SH_DROPPED_KEY,
  ])('has a Latvian entry that differs from the English, same placeholders: %s', (key) => {
    expect(typeof UI[key]).toBe('string');
    expect(UI[key]).not.toBe(key);
    expect(placeholders(UI[key])).toEqual(placeholders(key));
  });

  it('renders every sniff refusal in both languages with no placeholder left over', () => {
    const v4 = new Uint8Array(16);
    new DataView(v4.buffer).setUint32(0, 0x5053474e, true);
    new DataView(v4.buffer).setUint32(4, 4, true);
    const gz = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    new DataView(gz.buffer).setUint32(gz.length - 4, SPZ_MAX_DECODED_BYTES + 1, true);
    const refusalOf = (bytes: Uint8Array): MeshRefusal => {
      const r = sniffSplat('spz', bytes);
      if (!('refusal' in r)) throw new Error('expected a refusal');
      return r.refusal;
    };
    const refusals = [splatCountRefusal(1_500_000), refusalOf(v4), refusalOf(gz)];
    for (const r of refusals) {
      for (const lang of ['en', 'lv'] as const) {
        const msg = meshRefusalMessage(r, lang);
        expect(msg, `${r.key} (${lang})`).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
    expect(meshRefusalMessage(refusals[1], 'en')).toContain('version 4');
    // The size the trailer claims rounds UP, the cap to NEAREST — one byte over never reads "96 — max 96".
    expect(meshRefusalMessage(refusals[2], 'en')).toContain('unpacks to 96.1 MB — max 96 MB.');
    expect(meshRefusalMessage(refusals[2], 'lv')).toContain('96,1 MB — maks. 96 MB.');
  });
});

describe('the splat info lines', () => {
  it('the headset advisory speaks only ABOVE the advisory count, with both numbers grouped', () => {
    expect(splatHeadsetMessage({ count: SPLAT_HEADSET_ADVISORY_COUNT }, 'en')).toBeNull();
    expect(splatHeadsetMessage({ count: SPLAT_HEADSET_ADVISORY_COUNT + 1 }, 'en')).toBe(
      'This scene has 250,001 splats. Above 250,000, a standalone VR headset may not keep a smooth frame rate.',
    );
    const lvMsg = splatHeadsetMessage({ count: 400_000 }, 'lv')!;
    expect(lvMsg.replace(/\s/g, ' ')).toContain('400 000');
    expect(lvMsg.replace(/\s/g, ' ')).toContain('250 000');
    expect(lvMsg).not.toMatch(/\{[a-z]+\}/i);
  });

  it('the headset advisory says nothing for unknown or forged counts', () => {
    for (const f of [null, undefined, { count: null }, { count: Number.NaN }, { count: 1e300 }, { count: '900000' as unknown as number }]) {
      expect(splatHeadsetMessage(f, 'en')).toBeNull();
    }
  });

  it('the dropped-SH line prints only degree 1, 2 or 3', () => {
    expect(splatShDroppedMessage(1, 'en')).toBe(
      "This scene's view-dependent colour (spherical harmonics, degree 1) is not shown — FastShaders draws each splat's base colour.",
    );
    expect(splatShDroppedMessage(3, 'lv')).toContain('3. pakāpe');
    for (const d of [0, 4, -1, 1.5, '2', null, undefined, Number.NaN]) expect(splatShDroppedMessage(d, 'en')).toBeNull();
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
