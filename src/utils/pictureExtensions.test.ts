/**
 * ONE picture-extension list (utils/pictureExtensions.ts) for the drop filter
 * (`isImageFile`) and the glTF image-name strip (`gltfImageFileName`): a drop
 * stores the file's own name, so every extension the filter takes by name must
 * be one the strip removes, or "Mesh with Materials" over a single-GLB export
 * names the picture 'photo.jfif.png' (2026-10-09: the strip knew six of the
 * filter's thirteen). The export side — a name only a MIME type vouched for —
 * is engine/glbExportPlan.test.ts's round trip.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PICTURE_EXTENSIONS, trailingExtensionRe } from './pictureExtensions';
import { isImageFile } from './imageImport';
import { gltfImageFileName } from './gltfReader';
import { PNG_COLOR, glbOf, readOk } from '@/engine/gltfImportFixtures';

const file = (name: string, type = '') => ({ name, type }) as File;
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** One triangle, and one PNG image per name (the reader sniffs PNG for all). */
const modelNaming = (names: readonly string[]) =>
  readOk(
    glbOf(
      {
        images: names.map((name) => ({ bufferView: 1, mimeType: 'image/png', name })),
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      [PNG_COLOR],
    ),
  );

describe('the drop filter reads the list', () => {
  it('takes every listed extension, in any case, and SVG (refused visibly later) — by name alone', () => {
    for (const ext of PICTURE_EXTENSIONS) {
      expect(isImageFile(file(`photo.${ext}`)), ext).toBe(true);
      expect(isImageFile(file(`PHOTO.${ext.toUpperCase()}`)), ext).toBe(true);
    }
    expect(isImageFile(file('logo.svg'))).toBe(true);
    for (const name of ['texture.ktx2', 'notes.txt', 'photo.png.txt', 'png', 'photo.final']) {
      expect(isImageFile(file(name)), name).toBe(false);
    }
  });

  it('a MIME type is the other door, and it names no extension', () => {
    expect(isImageFile(file('cat.heic', 'image/heic'))).toBe(true);
    expect(isImageFile(file('cat.heic'))).toBe(false);
  });
});

describe('the glTF name strip reads the SAME list', () => {
  it('every extension the filter takes comes back ONCE, as the sniffed one — never doubled', () => {
    const names = [
      ...PICTURE_EXTENSIONS.map((e) => `photo.${e}`),
      ...PICTURE_EXTENSIONS.map((e) => `SCAN.${e.toUpperCase()}`),
    ];
    const m = modelNaming(names);
    names.forEach((name, i) => {
      expect(gltfImageFileName(m, i, 'm.glb'), name).toBe(`${name.slice(0, name.lastIndexOf('.'))}.png`);
    });
  });

  it('plus a KTX2 container name, which no file brings in; never SVG, which never reaches a model', () => {
    const names = ['tex.ktx2', 'logo.svg', 'a.png.png', 'photo.final'];
    const m = modelNaming(names);
    expect(names.map((_, i) => gltfImageFileName(m, i, 'm.glb'))).toEqual(['tex.png', 'logo.svg.png', 'a.png.png', 'photo.final.png']);
  });

  it('both modules read the list rather than spelling one — the drift that let the two disagree', () => {
    const importer = read('./imageImport.ts');
    const reader = read('./gltfReader.ts');
    expect(importer).toContain("trailingExtensionRe([...PICTURE_EXTENSIONS, 'svg'])");
    expect(reader).toContain("trailingExtensionRe([...PICTURE_EXTENSIONS, 'ktx2'])");
    // No second extension alternation left in either.
    for (const src of [importer, reader]) expect(src).not.toMatch(/png\|jpe\?g|jpe\?g\|/);
  });
});

describe('trailingExtensionRe', () => {
  it('matches ONE trailing extension from its list, any case — never a general extension', () => {
    const re = trailingExtensionRe(['png', 'jpg']);
    expect('a.png.png'.replace(re, '')).toBe('a.png');
    expect('SHOT.JPG'.replace(re, '')).toBe('SHOT');
    expect(re.test('photo.final')).toBe(false);
    expect(re.test('photo.pngx')).toBe(false);
    expect(re.test('png')).toBe(false);
  });

  it('escapes what it is given', () => {
    expect(trailingExtensionRe(['c++']).test('a.c++')).toBe(true);
    expect(trailingExtensionRe(['c++']).test('a.cc')).toBe(false);
    expect(trailingExtensionRe(['p.g']).test('a.png')).toBe(false);
  });

  it('the list is frozen, lower case and free of the two names each reader adds itself', () => {
    expect(Object.isFrozen(PICTURE_EXTENSIONS)).toBe(true);
    for (const ext of PICTURE_EXTENSIONS) expect(ext).toMatch(/^[a-z0-9]+$/);
    expect(PICTURE_EXTENSIONS).not.toContain('svg');
    expect(PICTURE_EXTENSIONS).not.toContain('ktx2');
  });
});
