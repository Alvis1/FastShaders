/**
 * The Import buttons open every kind of file FastShaders reads (owner,
 * 2026-11-26), through ONE router on the canvas — the path a drop of each file
 * takes. Node-only, so the wiring is pinned in the sources.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import lv from '@/i18n/lv.json';
import { IMPORT_BUTTON_TITLE, IMPORT_FILE_ACCEPT, importFileKind, importFilesOf } from './fileImport';
import { MESH_EXTENSIONS } from './previewMesh';
import { PICTURE_EXTENSIONS } from './pictureExtensions';
import { emitGpl, emitPaletteJson, looksLikePaletteFile } from './palettes';

const src = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf8');
const file = (name: string, type = '') => new File(['x'], name, { type });
const ui = (lv as { ui: Record<string, string> }).ui;

describe('what a file IS', () => {
  it.each([
    ['shader.js', 'shader'],
    ['shader.mjs', 'shader'],
    ['shader.tsl', 'shader'],
    ['Export.ZIP', 'shader'],
    ...MESH_EXTENSIONS.map((e) => [`model.${e}`, 'model']),
    ...PICTURE_EXTENSIONS.map((e) => [`photo.${e.toUpperCase()}`, 'picture']),
    ['data.csv', 'csv'],
    ['colours.gpl', 'palette'],
    ['profile.json', 'json'],
    ['notes.txt', 'other'],
    ['no-extension', 'other'],
  ])('%s → %s', (name, kind) => {
    expect(importFileKind(file(name))).toBe(kind);
  });

  it('the drop\'s precedence: a .csv first, a model before a picture', () => {
    // A MIME-typed oddity must not pass for anything else.
    expect(importFileKind(file('table.txt', 'text/csv'))).toBe('csv');
    expect(importFileKind(file('scan.ply', 'image/png'))).toBe('model');
    expect(importFileKind(file('photo', 'image/heic'))).toBe('picture');
    expect(importFileKind(file('pack.bin', 'application/zip'))).toBe('shader');
  });

  it('the picker offers every extension it reads', () => {
    const accept = IMPORT_FILE_ACCEPT.split(',');
    for (const e of ['js', 'mjs', 'tsl', 'zip', 'csv', 'gpl', 'json', ...MESH_EXTENSIONS, ...PICTURE_EXTENSIONS]) {
      expect(accept, e).toContain(`.${e}`);
    }
    expect(accept).toContain('image/*');
  });

  it('a request carries real Files only', () => {
    const real = file('a.png');
    const ev = new CustomEvent('x', { detail: { files: [real, 'b.png', { name: 'c.png' }, null] } });
    expect(importFilesOf(ev)).toEqual([real]);
    expect(importFilesOf(new CustomEvent('x', { detail: { files: 'a.png' } }))).toEqual([]);
    expect(importFilesOf(new CustomEvent('x'))).toEqual([]);
  });
});

describe('a .json is a device profile or a palette, by its content', () => {
  it('recognises the palette files the app writes, and nothing else', () => {
    const palette = { id: 'p1', name: 'Sea', colors: ['#003366', '#66ccff'] };
    expect(looksLikePaletteFile(emitPaletteJson([palette]))).toBe(true);
    expect(looksLikePaletteFile(emitGpl(palette))).toBe(true);
    expect(looksLikePaletteFile('{"costs": {"add": 1}}')).toBe(false);
    expect(looksLikePaletteFile('[{"format": "fastshaders-palette"}]')).toBe(false);
    expect(looksLikePaletteFile('not json')).toBe(false);
    expect(looksLikePaletteFile('')).toBe(false);
  });
});

describe('both Import buttons', () => {
  const canvas = src('components/NodeEditor/NodeEditor.tsx');
  const code = src('components/CodeEditor/CodeEditor.tsx');

  it('pick several files of any kind, under one tooltip', () => {
    for (const [name, text] of [['NodeEditor', canvas], ['CodeEditor', code]] as const) {
      expect(text, name).toMatch(/type="file"\s+multiple\s+accept=\{IMPORT_FILE_ACCEPT\}/);
      expect(text, name).toContain('title={t(IMPORT_BUTTON_TITLE, language)}');
    }
    expect(ui[IMPORT_BUTTON_TITLE]).toBeTruthy();
    expect(ui[IMPORT_BUTTON_TITLE]).not.toBe(IMPORT_BUTTON_TITLE);
  });

  it('go through the canvas\'s one router, which a drop uses too', () => {
    expect(code).toContain('requestFileImport(files);');
    expect(canvas).toContain('window.addEventListener(IMPORT_FILES_EVENT, onImport);');
    expect(canvas).toContain("importFiles(picked, x, y, 'pick');");
    expect(canvas).toContain("importFiles(Array.from(files), event.clientX, event.clientY, 'drop');");
  });

  it('a picked shader opens at once; a dropped one asks Open or Add', () => {
    const body = canvas.slice(canvas.indexOf('const importFiles = useCallback('), canvas.indexOf('const importPickedFiles = useCallback('));
    expect(body).toMatch(/if \(how === 'pick'\) \{[\s\S]*?openDroppedShader\(proj\)/);
    expect(body).toContain("requestShaderImport(proj, 'dom', (outcome) => {");
    // A pick says which files it cannot open; a drop ignores what it does not read.
    expect(body).toContain("else if (how === 'drop') continue;");
    expect(body).toContain("t('FastShaders cannot open {names} here.', lang)");
  });

  it('the embed has no 3D view and no Palettes dialog: a picked model or palette is one it cannot open', () => {
    const body = canvas.slice(canvas.indexOf('const importFiles = useCallback('), canvas.indexOf('const importPickedFiles = useCallback('));
    expect(body).toContain("else if (kind === 'model') (how === 'pick' && embedded ? others : models).push(f);");
    expect(body).toContain("else if (kind === 'palette') (embedded ? others : palettes).push(f);");
    expect(body).toContain('if (!embedded && looksLikePaletteFile(text)) {');
  });

  it('a palette reaches the Palettes dialog, which reads it as its own "Open file" does', () => {
    const toolbar = src('components/Layout/Toolbar.tsx');
    expect(toolbar).toContain('window.addEventListener(PALETTE_FILE_EVENT, onFile);');
    expect(toolbar).toMatch(/<PalettesModal[\s\S]*?importFiles=\{paletteFiles\}[\s\S]*?onImportFilesTaken=\{takePaletteFiles\}/);
    const dialog = src('components/Modals/PalettesModal.tsx');
    expect(dialog).toMatch(/onImportFilesTaken\?\.\(\);\s*void \(async \(\) => \{\s*for \(const f of files\) await handleFile\(f\);/);
  });

  it('a device profile goes through the one importer the code panel\'s drop uses', () => {
    expect(code).toContain('if (!importCostJsonText(text, file.name, language)) {');
    expect(canvas).toContain('if (importCostJsonText(text, j.name, lang)) return;');
  });

  it('every new sentence has its Latvian', () => {
    for (const key of [
      'FastShaders cannot open {names} here.',
      'Loaded {name}. {n} other file(s) were ignored — open a shader on its own.',
      '{name} is neither a device profile nor a FastShaders palette.',
    ]) {
      expect(ui[key], key).toBeTruthy();
      expect(ui[key], key).not.toBe(key);
      for (const ph of key.match(/\{\w+\}/g) ?? []) expect(ui[key], key).toContain(ph);
    }
  });
});
