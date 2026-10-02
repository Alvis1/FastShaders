import { describe, it, expect } from 'vitest';
import { getBuiltinPresets } from './builtinPresets';
import { getBuiltinTextures } from './builtinTextures';
import { BUILTIN_PALETTES } from './builtinPalettes';
import { assetText, paletteText, t } from '@/i18n';
import lv from '@/i18n/lv.json';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The built-in library in Latvian: every preset's name, description and
 * explainer note, every texture's name and description (and its note, for a
 * texture that pins one), and every built-in palette and swatch name. All
 * keyed by the ENGLISH text (see `assetText`), so rewording a preset in
 * builtinPresets.ts without moving its Latvian fails HERE — the app itself
 * would just quietly show that one string in English.
 */

interface NoteData {
  heading?: string;
  text?: string;
}

const presets = getBuiltinPresets();
const noteOf = (asset: { nodes: (typeof presets)[number]['nodes'] }) => asset.nodes.find((n) => n.type === 'note');
/** A note is optional on a texture (every preset has one), so the texture
 *  checks below run over the ones that carry it. */
const notedTextures = () => getBuiltinTextures().filter((x) => noteOf(x));

const expectLatvian = (en: string, lvText: string) => {
  expect(lvText, `no Latvian for “${en}”`).not.toBe(en);
  expect(lvText.trim()).toBe(lvText);
  expect(lvText.length).toBeGreaterThan(0);
};

describe('built-in presets and textures carry Latvian text', () => {
  it.each(presets.map((p) => [p.id, p] as const))('preset %s: name, description and note', (_id, p) => {
    expectLatvian(p.name, assetText(p.name, 'lv'));
    expectLatvian(p.description, assetText(p.description, 'lv'));
    const note = noteOf(p)?.data as NoteData | undefined;
    expect(note?.heading, 'every preset pins an explainer note').toBeTruthy();
    expectLatvian(note!.heading!, assetText(note!.heading!, 'lv'));
    expectLatvian(note!.text!, assetText(note!.text!, 'lv'));
  });

  it.each(getBuiltinTextures().map((x) => [x.id, x] as const))('texture %s: name and description', (_id, x) => {
    expectLatvian(x.name, assetText(x.name, 'lv'));
    expectLatvian(x.description, assetText(x.description, 'lv'));
  });

  it('a texture that pins a note has it in Latvian too', () => {
    // The same NoteNode draws it, through the same overlay — so an untranslated
    // texture note would be the one English caption on a Latvian canvas.
    const noted = notedTextures();
    expect(noted.map((x) => x.id)).toContain('led-display');
    for (const x of noted) {
      const note = noteOf(x)!.data as NoteData;
      expect(note.heading, `${x.id}: a note needs a heading`).toBeTruthy();
      expect(note.text, `${x.id}: a note needs a body`).toBeTruthy();
      expectLatvian(note.heading!, assetText(note.heading!, 'lv'));
      expectLatvian(note.text!, assetText(note.text!, 'lv'));
    }
  });

  it('the Latvian note still fits its box without scrolling', () => {
    // codeGroupBuilder sizes the note for a 200-char English caption at ~6.1 px
    // per 11px character over 5 lines, at the note's own width. Latvian runs
    // longer than English, so hold the translation to the same budget — a note
    // that scrolls is no longer a caption read at a glance.
    for (const p of [...presets, ...notedTextures()]) {
      const note = noteOf(p)!;
      const lvText = assetText((note.data as NoteData).text!, 'lv');
      const perLine = Math.floor(((note.width ?? 260) - 16) / 6.1);
      expect(lvText.length, `${p.id}: ${lvText.length} chars at ${perLine}/line`).toBeLessThanOrEqual(perLine * 5);
    }
  });

  it('lv.json holds no orphaned asset key', () => {
    // The other direction: a reworded English string leaves its old key behind,
    // which nothing asks for any more.
    const live = new Set<string>();
    for (const p of presets) {
      live.add(p.name);
      live.add(p.description);
      const note = noteOf(p)?.data as NoteData | undefined;
      if (note?.heading) live.add(note.heading);
      if (note?.text) live.add(note.text);
    }
    for (const x of getBuiltinTextures()) {
      live.add(x.name);
      live.add(x.description);
      const note = noteOf(x)?.data as NoteData | undefined;
      if (note?.heading) live.add(note.heading);
      if (note?.text) live.add(note.text);
    }
    expect(Object.keys(lv.assets).filter((k) => !live.has(k))).toEqual([]);
  });
});

describe('built-in palettes carry Latvian names', () => {
  it('every built-in palette and swatch name', () => {
    const live = new Set<string>();
    for (const p of BUILTIN_PALETTES) {
      live.add(p.name);
      expectLatvian(p.name, paletteText(p.name, 'lv'));
      for (const name of p.names ?? []) {
        live.add(name);
        // The emissive names' "x N" is the HDR multiplier — a number, not prose,
        // and it must survive translation verbatim.
        const lvName = paletteText(name, 'lv');
        expect(lvName, `no Latvian for swatch “${name}”`).not.toBe(name);
        const mult = / x\d+$/.exec(name)?.[0];
        if (mult) expect(lvName.endsWith(mult), `${name} → ${lvName}`).toBe(true);
      }
    }
    expect(Object.keys(lv.palettes).filter((k) => !live.has(k))).toEqual([]);
  });
});

describe('the display overlay leaves data alone', () => {
  it('English mode and non-built-in text pass through unchanged', () => {
    const p = presets[0];
    expect(assetText(p.name, 'en')).toBe(p.name);
    expect(paletteText('Gold', 'en')).toBe('Gold');
    // User text that is a UI key elsewhere is NOT a built-in asset string.
    expect(assetText('Save', 'lv')).toBe('Save');
    expect(assetText('', 'lv')).toBe('');
    // Own-property lookups only: a note reading "constructor" is just text.
    expect(assetText('constructor', 'lv')).toBe('constructor');
    expect(paletteText('toString', 'lv')).toBe('toString');
    const poisoned = { toString: 1 } as unknown as string;
    expect(() => assetText(poisoned, 'lv')).not.toThrow();
    expect(() => paletteText(poisoned, 'lv')).not.toThrow();
  });

  it('a dropped preset keeps its ENGLISH note and label as node data', () => {
    // The overlay is display-only, so the group label and the note stay the
    // English strings — which is what makes them keys the overlay can match.
    for (const p of presets) {
      const group = p.nodes.find((n) => n.type === 'group')!;
      expect((group.data as { label?: string }).label).toBe(p.name);
    }
  });

  it('the canvas note, group header and asset tiles read through the overlay', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const note = read('../components/NodeEditor/nodes/NoteNode.tsx');
    expect(note).toContain('assetText(data.heading, language)');
    expect(note).toContain('assetText(data.text, language)');
    expect(read('../components/NodeEditor/nodes/GroupNode.tsx')).toContain('assetText(data.label, language)');
    // File data: a non-string heading/text/label must read as absent, never
    // reach the lookup or React as an object.
    expect(note).toContain("typeof data.heading === 'string'");
    expect(note).toContain("typeof data.text === 'string'");
    expect(read('../components/NodeEditor/nodes/GroupNode.tsx')).toContain("typeof data.label === 'string'");
    expect(read('../components/NodeEditor/PresetCard.tsx')).toContain('assetText(preset.name, language)');
    expect(read('../components/NodeEditor/PresetCard.tsx')).toContain('assetText(preset.description, language)');
    expect(read('../components/NodeEditor/TextureCard.tsx')).toContain('assetText(texture.name, language)');
    expect(read('../components/NodeEditor/TextureCard.tsx')).toContain('assetText(texture.description, language)');
  });
});

describe('import messages built outside the i18n layer are lv.json keys', () => {
  it('every CSV refusal key and palette-file note', async () => {
    const { parseCsv, transposeCsv } = await import('@/utils/csvParser');
    const { parsePaletteFile } = await import('@/utils/palettes');
    const refusals = [
      parseCsv(''),
      parseCsv('a,b\nx,y'),
      parseCsv(`${Array.from({ length: 20 }, (_, i) => i).join(',')}\n`),
      parseCsv('1,2\n3'),
      parseCsv('1,2\n3,oops'),
      transposeCsv({ columnNames: ['a'], columns: [[]], rowCount: 0 }),
      transposeCsv({ columnNames: ['a'], columns: [Array.from({ length: 40 }, () => 1)], rowCount: 40 }),
    ];
    for (const r of refusals) {
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(t(r.errorKey, 'lv'), r.errorKey).not.toBe(r.errorKey);
    }
    for (const text of ['', 'GIMP Palette\n', 'not json', '[]', '{"format":"nope"}']) {
      for (const note of parsePaletteFile(text).notes) expect(t(note, 'lv'), note).not.toBe(note);
    }
  });
});
