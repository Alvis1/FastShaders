/**
 * The GLB import report (Phase 5 Step 8): how one build's report becomes the
 * lines of ONE canvas import note, and how those lines render in EN and LV.
 * The names in a report came out of a dropped file, so the sanitiser is
 * swept with controls, bidi marks and placeholder spellings.
 */
import { describe, it, expect } from 'vitest';
import {
  GLB_REPORT_NAME_MAX,
  GLB_REPORT_TEXTURE_LINES,
  downscaleReasonOf,
  glbImportReportLines,
  sanitizeReportName,
  skipReasonOf,
  type GlbImportReport,
} from './glbImportReport';
import {
  GLB_REPORT_NOTE_MS,
  IMPORT_NOTE_MS,
  importNoteHasConvertLine,
  importNoteLifetimeMs,
  importNoteLineText,
  type ImportNote,
} from './importNote';

function report(over: Partial<GlbImportReport> = {}): GlbImportReport {
  return {
    materials: 2,
    textures: 3,
    shared: 1,
    keptAuthored: 0,
    sectionMax: 16,
    decodeDownscaled: { count: 0, maxSide: 0 },
    notImported: [],
    outcomes: [],
    ...over,
  };
}

describe('glbImportReportLines: order and caps', () => {
  it('summary first, then over-max, N10, not-imported, then per-texture', () => {
    const lines = glbImportReportLines(
      report({
        keptAuthored: 3,
        decodeDownscaled: { count: 1, maxSide: 4096 },
        notImported: ['sheen', 'occlusion'],
        outcomes: [
          { name: 'a.png', outcome: 'kept' },
          { name: 'b.png', outcome: 'skipped', reason: 'decode' },
          { name: 'c.png', outcome: 'downscaled', width: 512, height: 256, reason: 'slot' },
          { name: 'd.png', outcome: 'skipped', reason: 'external' },
        ],
      }),
    );
    expect(lines.map((l) => l.kind)).toEqual([
      'glb-import',
      'glb-kept-authored',
      'glb-decode-downscaled',
      'glb-not-imported',
      'glb-texture-skipped',
      'glb-texture-downscaled',
      'glb-texture-skipped',
    ]);
    expect(lines[1]).toEqual({ kind: 'glb-kept-authored', max: 16, rest: 3 });
    expect(lines[2]).toEqual({ kind: 'glb-decode-downscaled', count: 1, maxSide: 4096 });
    expect(lines[3]).toEqual({ kind: 'glb-not-imported', items: ['occlusion', 'sheen'] });
  });

  it('omits kept outcomes and the optional lines when there is nothing to say', () => {
    const lines = glbImportReportLines(report({ outcomes: [{ name: 'a.png', outcome: 'kept' }] }));
    expect(lines).toEqual([{ kind: 'glb-import', materials: 2, textures: 3, shared: 1 }]);
  });

  it('lists at most GLB_REPORT_TEXTURE_LINES per-texture lines, then a count of the rest', () => {
    const outcomes = Array.from({ length: GLB_REPORT_TEXTURE_LINES + 3 }, (_, i) => ({
      name: `t${i}.png`,
      outcome: 'skipped' as const,
      reason: 'decode' as const,
    }));
    const lines = glbImportReportLines(report({ outcomes }));
    expect(lines.filter((l) => l.kind === 'glb-texture-skipped')).toHaveLength(GLB_REPORT_TEXTURE_LINES);
    expect(lines[lines.length - 1]).toEqual({ kind: 'glb-texture-more', count: 3 });
  });

  it('clamps counts and dimensions, and reads junk outcomes as nothing', () => {
    const lines = glbImportReportLines(
      report({
        materials: NaN,
        textures: -4,
        shared: Infinity,
        keptAuthored: 2.7,
        sectionMax: '16' as unknown as number,
        decodeDownscaled: { count: 2, maxSide: 99999 },
        notImported: ['nope' as unknown as 'sheen', 'ior'],
        outcomes: [null as unknown as { name: string; outcome: 'kept' }, { name: 'x', outcome: 'weird' as 'kept' }, { name: 5 as unknown as string, outcome: 'downscaled', width: 0, height: -3, reason: 'junk' as 'slot' }, { name: 'y', outcome: 'skipped', reason: 'no-readable-source' as 'external' }, { name: 'z', outcome: 'lossy' as 'kept' }],
      }),
    );
    expect(lines[0]).toEqual({ kind: 'glb-import', materials: 0, textures: 0, shared: 0 });
    expect(lines[1]).toEqual({ kind: 'glb-kept-authored', max: 0, rest: 2 });
    expect(lines[2]).toEqual({ kind: 'glb-decode-downscaled', count: 2, maxSide: 16384 });
    expect(lines[3]).toEqual({ kind: 'glb-not-imported', items: ['ior'] });
    expect(lines[4]).toEqual({ kind: 'glb-texture-downscaled', name: '?', width: 1, height: 1, reason: 'slot' });
    expect(lines[5]).toEqual({ kind: 'glb-texture-skipped', name: 'y', reason: 'unsupported-format' });
    // 'lossy' is no outcome any build produces (every lossless request is
    // lossless-ONLY, so the encoder can never drop it): it reads as junk.
    expect(lines).toHaveLength(6);
    expect(lines.some((l) => (l.kind as string) === 'glb-texture-lossy')).toBe(false);
  });

  it('a non-array outcomes list is an empty one', () => {
    expect(glbImportReportLines(report({ outcomes: 'x' as unknown as [] }))).toHaveLength(1);
  });
});

describe('sanitizeReportName', () => {
  it('strips controls and bidi marks, collapses whitespace, caps and ellipsises', () => {
    expect(sanitizeReportName('a\u0000b‮c⁦d‏e')).toBe('a b c d e');
    expect(sanitizeReportName('  two   words\n\n')).toBe('two words');
    const long = 'x'.repeat(GLB_REPORT_NAME_MAX + 10);
    expect(sanitizeReportName(long)).toBe('x'.repeat(GLB_REPORT_NAME_MAX) + '…');
    expect(sanitizeReportName('\u0001\u0002')).toBe('?');
    expect(sanitizeReportName('')).toBe('?');
  });

  it('counts code points, so an emoji is not split', () => {
    const s = '😀'.repeat(GLB_REPORT_NAME_MAX + 1);
    expect(sanitizeReportName(s)).toBe('😀'.repeat(GLB_REPORT_NAME_MAX) + '…');
  });

  it('never coerces: anything but a string is "?"', () => {
    expect(sanitizeReportName({ toString: () => { throw new Error('no'); } })).toBe('?');
    expect(sanitizeReportName(5)).toBe('?');
    expect(sanitizeReportName(null)).toBe('?');
  });
});

describe('reason readers', () => {
  it('map closed ids and fall back safely', () => {
    expect(downscaleReasonOf('import-res')).toBe('import-res');
    expect(downscaleReasonOf('device')).toBe('device');
    expect(downscaleReasonOf('x')).toBe('slot');
    expect(skipReasonOf('ktx2-only')).toBe('ktx2-only');
    expect(skipReasonOf('decode')).toBe('decode');
    expect(skipReasonOf('budget')).toBe('budget');
    expect(skipReasonOf('image-cap')).toBe('image-cap');
    expect(downscaleReasonOf('image-cap')).toBe('image-cap');
    expect(skipReasonOf('no-readable-source')).toBe('unsupported-format');
    expect(skipReasonOf('constructor')).toBe('unsupported-format');
  });
});

describe('rendering through importNoteLineText', () => {
  it('EN and LV, exact strings', () => {
    const lines = glbImportReportLines(
      report({
        keptAuthored: 4,
        decodeDownscaled: { count: 1, maxSide: 8192 },
        notImported: ['occlusion', 'clearcoat'],
        outcomes: [
          { name: 'wood.png', outcome: 'downscaled', width: 512, height: 512, reason: 'slot' },
          { name: 'rock.png', outcome: 'downscaled', width: 256, height: 256, reason: 'image-cap' },
          { name: 'moss.png', outcome: 'skipped', reason: 'image-cap' },
          { name: 'sky.png', outcome: 'skipped', reason: 'external' },
          { name: 'z.png', outcome: 'skipped', reason: 'budget' },
        ],
      }),
    );
    expect(lines.map((l) => importNoteLineText(l, 'en'))).toEqual([
      'Imported materials: 2, textures: 3 (shared by several materials: 1).',
      'The editor holds at most 16 material sections; the remaining 4 keep the materials authored in the model.',
      '1 texture(s) were larger than 64 MP (e.g. 8192×8192) and were downscaled while decoding to 8192 px.',
      'Not imported: ambient occlusion, clearcoat — FastShaders has no channel for them.',
      'wood.png: downscaled to 512×512 (the size used for this kind of map)',
      'rock.png: downscaled to 256×256 (the per-image size limit)',
      'moss.png: skipped (over the per-image size limit)',
      'sky.png: skipped (stored in a separate file)',
      "z.png: skipped (over the project's image budget)",
    ]);
    expect(lines.map((l) => importNoteLineText(l, 'lv'))).toEqual([
      'Importēti materiāli: 2, tekstūras: 3 (kopīgas vairākiem materiāliem: 1).',
      'Redaktorā ietilpst ne vairāk kā 16 materiālu sadaļas; pārējie materiāli (4) tiek rādīti tādi, kādi tie ir modelī.',
      'Tekstūras, kas bija lielākas par 64 MP (piem., 8192×8192) un dekodēšanas laikā tika samazinātas līdz 8192 px: 1.',
      'Netika importēts: apkārtējās gaismas aizsegums, virslaka — FastShaders nav tiem atbilstoša kanāla.',
      'wood.png: samazināta līdz 512×512 (šāda veida kartēm izmantotais izmērs)',
      'rock.png: samazināta līdz 256×256 (viena attēla izmēra ierobežojums)',
      'moss.png: izlaista (pārsniedz viena attēla izmēra ierobežojumu)',
      'sky.png: izlaista (glabājas atsevišķā failā)',
      'z.png: izlaista (pārsniedz projekta attēlu budžetu)',
    ]);
  });

  it('the shared === 0 variant', () => {
    const [line] = glbImportReportLines(report({ shared: 0 }));
    expect(importNoteLineText(line, 'en')).toBe('Imported materials: 2, textures: 3.');
    expect(importNoteLineText(line, 'lv')).toBe('Importēti materiāli: 2, tekstūras: 3.');
  });

  it('a name spelling a placeholder or a $& pattern prints literally', () => {
    const lines = glbImportReportLines(
      report({
        outcomes: [
          { name: '{reason}.png', outcome: 'skipped', reason: 'damaged' },
          { name: '$&.png', outcome: 'downscaled', width: 8, height: 8, reason: 'device' },
          { name: '{w}{h}{name}', outcome: 'skipped', reason: 'decode' },
        ],
      }),
    );
    expect(importNoteLineText(lines[1], 'en')).toBe('{reason}.png: skipped (damaged image data)');
    expect(importNoteLineText(lines[2], 'en')).toBe("$&.png: downscaled to 8×8 (the headset's texture size limit)");
    expect(importNoteLineText(lines[3], 'en')).toBe('{w}{h}{name}: skipped (could not be decoded)');
  });
});

describe('the note lifetime', () => {
  const note = (lines: ImportNote['lines']): ImportNote => ({ id: 'n', lines });

  it('is 30 s with any glb- line and 12 s otherwise', () => {
    expect(importNoteLifetimeMs(note(glbImportReportLines(report())))).toBe(GLB_REPORT_NOTE_MS);
    expect(importNoteLifetimeMs(note([{ kind: 'no-webp', storedAs: 'JPEG' }]))).toBe(IMPORT_NOTE_MS);
    expect(importNoteLifetimeMs(note([]))).toBe(IMPORT_NOTE_MS);
    expect(importNoteLifetimeMs({ id: 'n', lines: null as unknown as [] })).toBe(IMPORT_NOTE_MS);
    expect(GLB_REPORT_NOTE_MS).toBe(30000);
    expect(IMPORT_NOTE_MS).toBe(12000);
  });

  it('a GLB report never shows the conversion "?"', () => {
    expect(importNoteHasConvertLine(note(glbImportReportLines(report())))).toBe(false);
  });
});
