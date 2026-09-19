/**
 * What a refused or partly-skipped zip SAYS (N2, N3b) — and that every import
 * surface routes its failures through the one mapping that says it.
 *
 * The words are pinned exactly in both languages; the surfaces are pinned from
 * SOURCE, because the vitest env is `node` and none of the five renders here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '@/i18n';
import { zipLimitCopy, zipModelSkippedLine } from './zipImportNotices';
import { importNoteLineText, importNoteHasConvertLine } from './importNote';
import { MAX_TOTAL_UNCOMPRESSED, MAX_ENTRIES, MAX_NAME_LENGTH } from './zipReader';
import { modelTooLargeRefusal, MESH_BAD_GLB_KEY, type MeshRefusal } from './previewMesh';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const total = { kind: 'total-size' as const, limit: MAX_TOTAL_UNCOMPRESSED, value: 100 * 2 ** 20 };
/** 70.2 MiB as an INTEGER byte count — a fractional one is fragile under round-up. */
const SIZE_70_2 = Math.round(70.2 * 2 ** 20);

describe('zipLimitCopy', () => {
  it('total-size, in English', () => {
    const c = zipLimitCopy(total, 'big.zip', 'en');
    expect(c.title).toBe('File too large to open');
    expect(c.message).toBe(
      '“big.zip” unpacks to more than 96 MB, the most FastShaders opens from one file. Nothing was changed.',
    );
    expect(c.suggestions).toHaveLength(2);
    expect(c.suggestions[0]).toMatch(/\(models up to 64 MB\)\.$/);
    expect(c.suggestions[1]).toContain('right-click EXPORT');
  });

  it('total-size, in Latvian', () => {
    const c = zipLimitCopy(total, 'big.zip', 'lv');
    expect(c.title).toBe('Fails ir pārāk liels, lai to atvērtu');
    expect(c.message).toBe(
      '“big.zip” izpakots pārsniedz 96 MB — lielāko apjomu, ko FastShaders atver no viena faila. Nekas netika mainīts.',
    );
    expect(c.suggestions[0]).toMatch(/\(modeļi līdz 64 MB\)\.$/);
    expect(c.suggestions[1]).toContain('“Eksportēt”');
  });

  it('entry-count names the limit and offers only the unzip route', () => {
    const z = { kind: 'entry-count' as const, limit: MAX_ENTRIES, value: 900 };
    expect(zipLimitCopy(z, 'many.zip', 'en').message).toBe(
      '“many.zip” holds more than 512 files, the most FastShaders opens from one archive. Nothing was changed.',
    );
    expect(zipLimitCopy(z, 'many.zip', 'lv').message).toBe(
      '“many.zip” satur vairāk nekā 512 failus — vairāk, nekā FastShaders atver no viena arhīva. Nekas netika mainīts.',
    );
    expect(zipLimitCopy(z, 'many.zip', 'en').suggestions).toHaveLength(1);
    expect(zipLimitCopy(z, 'many.zip', 'en').title).toBe('File too large to open');
  });

  it('name and method are "cannot open", not "too large"', () => {
    const name = zipLimitCopy({ kind: 'name', limit: MAX_NAME_LENGTH, value: 600 }, 'a.zip', 'en');
    expect(name.title).toBe('Cannot open this archive');
    expect(name.message).toContain('longer than 512 bytes');
    const method = zipLimitCopy({ kind: 'method', limit: 8, value: 14 }, 'a.zip', 'en');
    expect(method.title).toBe('Cannot open this archive');
    expect(method.suggestions).toEqual([
      'Re-create the archive with the zip tool built into your system, without a password.',
    ]);
    expect(zipLimitCopy({ kind: 'method', limit: 8, value: 14 }, 'a.zip', 'lv').title).toBe('Šo arhīvu nevar atvērt');
  });

  it('falls back to "This file" when the notice carries no name', () => {
    expect(zipLimitCopy(total, undefined, 'en').message).toMatch(/^This file unpacks/);
    expect(zipLimitCopy(total, undefined, 'lv').message).toMatch(/^Šis fails izpakots/);
  });

  it('renders every kind in both languages with no placeholder left over', () => {
    for (const kind of ['total-size', 'entry-count', 'name', 'method'] as const) {
      for (const lang of ['en', 'lv'] as const) {
        const c = zipLimitCopy({ kind, limit: 512, value: 999 }, 'x.zip', lang);
        for (const s of [c.title, c.message, ...c.suggestions]) {
          expect(s).not.toMatch(/[{}]/);
        }
      }
    }
  });

  it('fills a user-supplied file name literally (no `$&` expansion)', () => {
    expect(zipLimitCopy(total, '$&.zip', 'en').message).toMatch(/^“\$&\.zip” unpacks/);
  });
});

describe('zipModelSkippedLine', () => {
  const tooLarge = modelTooLargeRefusal(SIZE_70_2);

  it('says the shader loaded and why its model was skipped, in both languages', () => {
    const line = { shaderLoaded: true, fileName: 'export.zip', refusal: tooLarge };
    expect(zipModelSkippedLine(line, 'en')).toBe(
      'The shader loaded, but its 3D model was skipped: Model too large (70.2 MB — max 64 MB). ' +
        'Reduce its polygon count or texture sizes and export it again from your 3D software.',
    );
    expect(zipModelSkippedLine(line, 'lv')).toBe(
      'Ēnotājs ielādēts, bet tā 3D modelis tika izlaists: Modelis ir pārāk liels (70,2 MB — maks. 64 MB). ' +
        'Samaziniet tā poligonu skaitu vai tekstūru izmērus un eksportējiet to vēlreiz no savas 3D programmas.',
    );
  });

  it('names the archive when nothing loaded (a model-only zip)', () => {
    const refusal: MeshRefusal = { reason: 'bad-glb', key: MESH_BAD_GLB_KEY };
    const line = { shaderLoaded: false, fileName: 'model.zip', refusal };
    expect(zipModelSkippedLine(line, 'en')).toBe(
      'The 3D model in “model.zip” was skipped: Not a valid .glb file (missing glTF header).',
    );
    expect(zipModelSkippedLine(line, 'lv')).toBe(
      '3D modelis failā “model.zip” tika izlaists: Nederīgs .glb fails (trūkst glTF galvenes).',
    );
    expect(zipModelSkippedLine({ ...line, fileName: '$&.zip' }, 'en')).toContain('“$&.zip”');
  });

  it('is what the import note renders for its zip line, which has no "?"', () => {
    const line = { kind: 'zip-model-skipped' as const, shaderLoaded: true, fileName: 'e.zip', refusal: tooLarge };
    expect(importNoteLineText(line, 'lv')).toBe(zipModelSkippedLine(line, 'lv'));
    expect(importNoteHasConvertLine({ id: 'n', lines: [line] })).toBe(false);
  });
});

describe('every string this package added is translated', () => {
  const KEYS = [
    'File too large to open',
    '{name} unpacks to more than {limit} MB, the most FastShaders opens from one file. Nothing was changed.',
    '{name} holds more than {max} files, the most FastShaders opens from one archive. Nothing was changed.',
    'Unzip it, load the .js inside, then drop the 3D model onto the 3D preview (models up to {model} MB).',
    'If you made it and still have the shader open, re-export it without the 3D model: right-click EXPORT.',
    'This file',
    'Cannot open this archive',
    '{name} contains a file name longer than {max} bytes, which FastShaders cannot read. Nothing was changed.',
    '{name} uses a compression method FastShaders cannot read. Nothing was changed.',
    'Re-create the archive with the zip tool built into your system, without a password.',
    'The shader loaded, but its 3D model was skipped: {reason}',
    'The 3D model in {name} was skipped: {reason}',
    'Drop a benchmark complexity.json on the cost bar (top-right) or the code panel to reprice nodes.',
    '{name} does not contain a shader script (.js / .mjs / .tsl).',
    'Could not import {name}: {reason}',
    'Loaded {name}. {n} other dropped file(s) were ignored — drop a project on its own.',
    'Could not import {name} — the file appears corrupted.',
    '{name} is not a shader script (.js / .mjs / .tsl), a FastShaders .zip, a 3D model (.obj / .glb / .gltf), or a benchmark complexity .json.',
    'Could not load {name}:\n{error}',
    'Could not read {name}.',
    "Could not load {name}:\nSVG images can't be imported — export it as PNG or WebP first.",
    'Could not load {name} as an image.',
    'Could not transpose {name}:\n{error}',
  ];

  it.each(KEYS)('%s', (key) => {
    const lv = t(key, 'lv');
    expect(lv).not.toBe(key);
    // Every placeholder the English carries survives into the Latvian.
    for (const ph of key.match(/\{\w+\}/g) ?? []) expect(lv).toContain(ph);
  });
});

describe('every import surface says why a zip was refused', () => {
  const NODE_EDITOR = read('components/NodeEditor/NodeEditor.tsx');
  const CODE_EDITOR = read('components/CodeEditor/CodeEditor.tsx');
  const PREVIEW = read('components/Preview/ShaderPreview.tsx');
  const WORK_FOLDER = read('components/Layout/WorkFolder.tsx');
  const STORE = read('store/useAppStore.ts');

  it('routes its catch through reportZipImportError first', () => {
    for (const [name, src] of [
      ['NodeEditor', NODE_EDITOR],
      ['CodeEditor', CODE_EDITOR],
      ['ShaderPreview', PREVIEW],
      ['WorkFolder', WORK_FOLDER],
    ] as const) {
      expect(src, name).toContain('reportZipImportError(');
    }
    expect(read('components/Modals/limitNoticeCopy.ts')).toContain("case 'zip-limit'");
  });

  it('no longer carries the old untranslated alerts', () => {
    for (const src of [NODE_EDITOR, CODE_EDITOR]) {
      expect(src).not.toContain("doesn't contain a");
      expect(src).not.toContain('the file appears corrupted.`');
      expect(src).not.toContain('(top-left)');
    }
    // Every drop/import alert goes through t() — no bare English literal.
    for (const [name, src] of [['NodeEditor', NODE_EDITOR], ['CodeEditor', CODE_EDITOR], ['store', STORE]] as const) {
      expect(src, name).not.toMatch(/window\.alert\(\s*['"`]/);
    }
  });

  it('the code panel hands a 3D model to the preview instead of refusing it', () => {
    const at = CODE_EDITOR.indexOf('const importScriptFile = useCallback(');
    const body = CODE_EDITOR.slice(at, CODE_EDITOR.indexOf('}, [language]);', at));
    const route = body.indexOf('requestPreviewModelLoad(file)');
    expect(route).toBeGreaterThan(-1);
    expect(body.indexOf('detectMeshKind(file.name) !== null')).toBeLessThan(route);
    // Before the .json and text branches, so a .glb is never read as a script.
    expect(route).toBeLessThan(body.indexOf('/\\.json$/i.test(file.name)'));
    // The drop filter lets models through to it.
    expect(CODE_EDITOR).toContain('detectMeshKind(file.name) === null && !/\\.(js|mjs|tsl|zip|json)$/i.test(file.name)');
  });
});

/**
 * A file name is chosen by whoever made the file, and braces are legal in it.
 * These fills used to run `{name}` first through successive first-occurrence
 * `.replace()` calls, so a name spelling a LATER placeholder captured its value
 * and the real placeholder printed literally ("“96.zip” unpacks to more than
 * {limit} MB" — seen in the browser, in both languages).
 */
describe('a file name spelling a placeholder stays text', () => {
  it('total-size: {limit}.zip', () => {
    expect(zipLimitCopy(total, '{limit}.zip', 'en').message).toBe(
      '“{limit}.zip” unpacks to more than 96 MB, the most FastShaders opens from one file. Nothing was changed.',
    );
    expect(zipLimitCopy(total, '{limit}.zip', 'lv').message).toBe(
      '“{limit}.zip” izpakots pārsniedz 96 MB — lielāko apjomu, ko FastShaders atver no viena faila. Nekas netika mainīts.',
    );
  });

  it('entry-count and name: {max}.zip', () => {
    const entries = { kind: 'entry-count' as const, limit: MAX_ENTRIES, value: 900 };
    expect(zipLimitCopy(entries, '{max}.zip', 'en').message).toBe(
      '“{max}.zip” holds more than 512 files, the most FastShaders opens from one archive. Nothing was changed.',
    );
    const names = { kind: 'name' as const, limit: MAX_NAME_LENGTH, value: 600 };
    expect(zipLimitCopy(names, '{max}.zip', 'en').message).toMatch(/^“\{max\}\.zip” contains a file name longer than 512 bytes/);
  });

  it('a model-only zip: {reason}.zip', () => {
    const line = { shaderLoaded: false, fileName: '{reason}.zip', refusal: modelTooLargeRefusal(SIZE_70_2) };
    expect(zipModelSkippedLine(line, 'en')).toBe(
      'The 3D model in “{reason}.zip” was skipped: Model too large (70.2 MB — max 64 MB). ' +
        'Reduce its polygon count or texture sizes and export it again from your 3D software.',
    );
  });
});
