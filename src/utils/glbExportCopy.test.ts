/**
 * The single-GLB export's words (utils/glbExportCopy.ts), rendered in both
 * languages the way limitNoticeCopy.test.ts renders LimitModal's: every key
 * has a Latvian entry that differs from the English, nothing is left
 * unfilled, a file name cannot capture a later placeholder, sizes print in
 * MiB with the Latvian decimal comma, and every refusal reason has a
 * sentence (a `satisfies` table fails `tsc` on a reason this file forgets).
 */
import { describe, it, expect } from 'vitest';
import lv from '@/i18n/lv.json';
import type { Language } from '@/i18n';
import {
  GLB_EXPORT_KEYS,
  glbExportRefusalText,
  glbExportReportLines,
  glbExportReportNoteLines,
  glbTooLargeCopy,
  glbUnavailableText,
} from './glbExportCopy';
import { importNoteLineText } from './importNote';
import type { GlbExportUnavailable } from './glbExportAvailability';
import { planSingleGlbPreflight } from './exportPreflight';
import type { SingleGlbRefusalReason } from '@/engine/exportSingleGlb';
import type { GlbRepackSize } from './glbRepack';

const UI = (lv as { ui: Record<string, string> }).ui;
const LANGS: Language[] = ['en', 'lv'];
const UNFILLED = /\{[A-Za-z][A-Za-z0-9_]*\}/;
/** A finished sentence followed by a dash-led clause: the fragment shape. */
const DASH_FRAGMENT = /\.\s+[—–-]/;

const REASONS = {
  study: false,
  'no-model': true,
  'not-gltf': true,
  'external-data': true,
  'module-error': true,
  unreadable: true,
  'bad-input': true,
  'too-complex': true,
  'unsupported-buffer-extension': true,
  'module-too-large': true,
  'project-too-large': true,
  'model-mismatch': true,
  'too-many-assets': true,
  'asset-too-large': true,
} as const satisfies Record<SingleGlbRefusalReason, boolean>;

const size = (o: Partial<GlbRepackSize>): GlbRepackSize => ({
  totalBytes: 0,
  jsonBytes: 0,
  baseBinBytes: 0,
  textureImageBytes: 0,
  fallbackBytes: 0,
  assetOnlyImageBytes: 0,
  moduleBytes: 0,
  projectBytes: 0,
  textureCount: 0,
  fallbackCount: 0,
  fallbackMissing: 0,
  ktx2Bytes: 0,
  ktx2Count: 0,
  webpRequired: false,
  ...o,
});

describe('every key', () => {
  it('has a Latvian entry that is not the English', () => {
    for (const key of Object.values(GLB_EXPORT_KEYS)) {
      expect(UI[key], key).toBeTruthy();
      expect(UI[key], key).not.toBe(key);
      // The same placeholders on both sides.
      const ph = (s: string) => (s.match(/\{[A-Za-z]+\}/g) ?? []).sort();
      expect(ph(UI[key]), key).toEqual(ph(key));
    }
  });
});

describe('glbExportRefusalText', () => {
  it('every shown reason renders non-empty and fully filled in both languages; study and aborted are null', () => {
    for (const lang of LANGS) {
      for (const [reason, shown] of Object.entries(REASONS) as [SingleGlbRefusalReason, boolean][]) {
        for (const detail of ['', 'total', 'asset:img-00000000']) {
          const text = glbExportRefusalText(reason, lang, { name: 'statue.glb', detail });
          if (!shown) {
            expect(text).toBeNull();
            continue;
          }
          expect(text, `${lang} ${reason}`).toBeTruthy();
          expect(text!, `${lang} ${reason}`).not.toMatch(UNFILLED);
        }
      }
      expect(glbExportRefusalText('aborted', lang)).toBeNull();
    }
  });

  it('a name is quoted, neutralised and capped, and cannot capture a later placeholder', () => {
    const text = glbExportRefusalText('asset-too-large', 'en', { name: '{limit}\u202E.png', detail: 'asset:k-00000000' })!;
    expect(text).toBe('Image “{limit}\uFFFD.png” is larger than 16 MB, the most one image inside a .glb may take.');
    const long = glbExportRefusalText('not-gltf', 'en', { name: 'x'.repeat(200) })!;
    expect(long).toContain(`“${'x'.repeat(64)}\u2026”`);
    expect(glbExportRefusalText('asset-too-large', 'en', { detail: 'asset:k-00000000' })).toBe(
      'One of the shader’s images is larger than 16 MB, the most one image inside a .glb may take.',
    );
    expect(glbExportRefusalText('asset-too-large', 'lv', { detail: 'total' })).toContain('64 MB');
    expect(glbExportRefusalText('too-many-assets', 'en')).toBe(
      'The shader uses more than 64 images; one .glb can carry at most 64.',
    );
  });
});

describe('glbTooLargeCopy', () => {
  const MiB = 1024 * 1024;
  const sizes = {
    fallback: size({ totalBytes: 96 * MiB + MiB / 20, textureImageBytes: 30 * MiB, fallbackBytes: 20 * MiB, fallbackCount: 3 }),
    required: size({ totalBytes: 76 * MiB }),
  };

  it('title, both sentences, and the WebP-only pair — LV with the decimal comma', () => {
    const tl = planSingleGlbPreflight(sizes, 96 * MiB)!;
    const en = glbTooLargeCopy(tl, 'en');
    expect(en.title).toBe('This .glb is too large to open again');
    expect(en.message).toBe(
      'The .glb would be 96.1 MB. FastShaders opens .glb files up to 96 MB, so the editor could not load it back. Other 3D viewers and A-Frame pages would still open it. '
        + 'Each texture is stored twice, as WebP and as a PNG or JPEG copy for viewers without WebP: 50 MB in all.',
    );
    expect(en.webpOnlyLabel).toBe('Export WebP only (76 MB)');
    expect(en.webpOnlyHint).toBeTruthy();
    const lvCopy = glbTooLargeCopy(tl, 'lv');
    expect(lvCopy.message).toContain('96,1 MB');
    for (const s of [lvCopy.title, lvCopy.message, lvCopy.webpOnlyLabel!, lvCopy.webpOnlyHint!]) {
      expect(s).not.toMatch(UNFILLED);
    }
  });

  it('no fallbacks: no texture sentence and no WebP-only button', () => {
    const tl = planSingleGlbPreflight(
      { fallback: size({ totalBytes: 100 * MiB, textureImageBytes: 40 * MiB }), required: size({ totalBytes: 100 * MiB }) },
      96 * MiB,
    )!;
    const c = glbTooLargeCopy(tl, 'en');
    expect(c.message).not.toContain('stored twice');
    expect(c.webpOnlyLabel).toBeNull();
    expect(c.webpOnlyHint).toBeNull();
  });

  // The KTX2 clause used to be appended as " — including {size} MB of KTX2
  // copies." onto a message whose previous clause already ended in a full stop:
  // a lowercase fragment with no antecedent, in both languages.
  it('the KTX2 breakdown is its own sentence, joined by a space, in both languages', () => {
    const tl = planSingleGlbPreflight(
      {
        fallback: size({ totalBytes: 100 * MiB, textureImageBytes: 40 * MiB, ktx2Bytes: 28.7 * MiB, ktx2Count: 4 }),
        required: size({ totalBytes: 100 * MiB }),
      },
      96 * MiB,
    )!;
    expect(tl.ktx2Bytes).toBeGreaterThan(0);
    expect(glbTooLargeCopy(tl, 'en').message).toContain('would still open it. Of that, 28.7 MB are the KTX2 copies.');
    expect(glbTooLargeCopy(tl, 'lv').message).toContain('atvērtu. No tā 28,7 MB ir KTX2 kopijas.');
    for (const lang of LANGS) {
      const m = glbTooLargeCopy(tl, lang).message;
      // A full stop followed by a dash IS the fragment; an em dash mid-sentence
      // is not (the Latvian texture sentence carries one).
      expect(m, lang).not.toMatch(DASH_FRAGMENT);
      expect(m, lang).not.toMatch(UNFILLED);
    }
  });

  it('with fallbacks it follows the texture sentence, still as a sentence', () => {
    const tl = planSingleGlbPreflight(
      {
        fallback: size({
          totalBytes: 100 * MiB,
          textureImageBytes: 30 * MiB,
          fallbackBytes: 20 * MiB,
          fallbackCount: 3,
          ktx2Bytes: 10 * MiB,
        }),
        required: size({ totalBytes: 80 * MiB }),
      },
      96 * MiB,
    )!;
    expect(glbTooLargeCopy(tl, 'en').message).toContain('50 MB in all. Of that, 10 MB are the KTX2 copies.');
    expect(glbTooLargeCopy(tl, 'lv').message).toContain('kopā 50 MB. No tā 10 MB ir KTX2 kopijas.');
    for (const lang of LANGS) expect(glbTooLargeCopy(tl, lang).message, lang).not.toMatch(DASH_FRAGMENT);
  });
});

describe('glbExportReportLines', () => {
  it('each line only when it applies, count-neutral, filled in both languages', () => {
    expect(glbExportReportLines(size({}), [], [], 'en')).toEqual([]);
    for (const lang of LANGS) {
      const lines = glbExportReportLines(
        size({ fallbackMissing: 2 }),
        [{ material: 0, slot: 'normal', reason: 'rewired' }],
        [{ note: 'uv-wired' }, { note: 'uv-approximated' }],
        lang,
      );
      expect(lines).toHaveLength(3);
      for (const l of lines) expect(l).not.toMatch(UNFILLED);
      expect(lines[0]).toContain('2');
      expect(lines[1]).toContain('1');
    }
    expect(glbExportReportLines(size({}), [], [{ note: 'uv-wired' }], 'en')).toEqual([]);
  });
});

describe('glbUnavailableText', () => {
  // A `satisfies` table, so a new reason fails `tsc` here rather than
  // rendering as nothing under the disabled radio.
  const REASONS = {
    'no-model': false,
    obj: true,
    'external-data': true,
    unreadable: true,
  } as const satisfies Record<GlbExportUnavailable, boolean>;

  it('every reason renders filled in both languages, and a name is quoted', () => {
    for (const lang of LANGS) {
      for (const [reason, named] of Object.entries(REASONS) as [GlbExportUnavailable, boolean][]) {
        const text = glbUnavailableText({ ok: false, reason, name: 'statue.glb' }, lang)!;
        expect(text, `${lang} ${reason}`).toBeTruthy();
        expect(text, `${lang} ${reason}`).not.toMatch(UNFILLED);
        expect(text.includes('“statue.glb”'), `${lang} ${reason}`).toBe(named);
      }
    }
    expect(glbUnavailableText({ ok: true }, 'en')).toBeNull();
  });

  it('a missing name falls back to the extension rather than an empty quote', () => {
    expect(glbUnavailableText({ ok: false, reason: 'obj' }, 'en')).toContain('.obj is an .obj file');
    expect(glbUnavailableText({ ok: false, reason: 'unreadable' }, 'en')).toContain('.glb could not be read');
  });
});

describe('the report as import-note lines', () => {
  it('the structured lines render exactly what the sentences say', () => {
    const size = { fallbackMissing: 2 };
    const problems = [{ material: 0, slot: 'normal' as const, reason: 'rewired' as const }];
    const notes = [{ note: 'uv-approximated' as const }];
    const lines = glbExportReportNoteLines(size, problems, notes);
    expect(lines.map((l) => l.kind)).toEqual([
      'glb-export-fallback-missing',
      'glb-export-slots-empty',
      'glb-export-approximated',
    ]);
    for (const lang of LANGS) {
      expect(lines.map((l) => importNoteLineText(l, lang))).toEqual(
        glbExportReportLines(size, problems, notes, lang),
      );
    }
    // Every `glb-` line gives the note the report's 30 s.
    for (const l of lines) expect(l.kind.startsWith('glb-')).toBe(true);
  });
});
