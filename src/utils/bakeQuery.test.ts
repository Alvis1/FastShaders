import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import { bakeQueryMatches, bakeSelectionCount, bakeSelectionIds } from './bakeQuery';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('bakeQueryMatches — a short "bake" search, in either language', () => {
  it('answers a start of "bake" or of "iecept", diacritic-blind', () => {
    for (const q of ['bak', 'Bake', 'bake selection', 'baking', '  bake to texture ', 'iece', 'iecept', 'Iecept tekstūrā']) {
      expect(bakeQueryMatches(q), q).toBe(true);
    }
  });
  it('never a node name, a too-short start, or a whole sentence (that is the generator’s)', () => {
    for (const q of ['', 'ba', 'perlin', 'background', 'texture bake', 'iec', 'bake a wooden texture with noise please']) {
      expect(bakeQueryMatches(q), q).toBe(false);
    }
  });
});

describe('the selection a bake reads', () => {
  const sel = (n: AppNode) => ({ ...n, selected: true }) as AppNode;
  it('is every selected node but notes and sinks; a group counts (it stands for its nodes)', () => {
    const group = { id: 'g', type: 'group', position: { x: 0, y: 0 }, selected: true, data: { registryType: 'group', label: 'G' } } as unknown as AppNode;
    const note = { id: 'n', type: 'note', position: { x: 0, y: 0 }, selected: true, data: { text: '' } } as unknown as AppNode;
    const nodes = [sel(makeNode('a', 'perlin')), makeNode('b', 'uv'), sel(makeNode('o', 'output')), group, note];
    expect(bakeSelectionIds(nodes)).toEqual(['a', 'g']);
    expect(bakeSelectionCount(nodes)).toBe(2);
  });
});

describe('both search boxes offer it', () => {
  it('the Space menu: a Selection-section row for any selection, and the same row for a "bake" search', () => {
    const src = read('components/NodeEditor/menus/AddNodeMenu.tsx');
    expect(src).toContain('{canBake && renderBakeRow()}');
    expect(src).toContain('bakeQueryMatches(query)');
    expect(src).toContain("t('Bake Selection to Texture…', language)");
  });
  it('the asset bar: a button beside the box, and Enter', () => {
    const src = read('components/NodeEditor/ContentBrowser.tsx');
    expect(src).toContain('bakeQueryMatches(settledSearch)');
    expect(src).toContain('openBakeFromSearch();');
  });
});
