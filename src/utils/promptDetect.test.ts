/**
 * The prompt detector against the app's REAL names: a query that reads as a
 * request is offered to the generator, and nobody typing a node, preset,
 * texture or lesson name ever is (docs/dev/node-generator.md § The search-box
 * entry).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NODE_REGISTRY, searchNodes } from '@/registry/nodeRegistry';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { nodeLabelLV, assetText, t } from '@/i18n';
import { TUTORIALS } from '@/tutorials/tutorialDefs';
import { knownNamesWith, knownNodeNames } from '@/components/NodeEditor/promptKnownNames';
import { noteMatchesQuery } from '@/components/NodeEditor/noteSearch';
import { REQUEST_VERBS, detectPrompt, knownNameWords, partOfKnownName, promptWords, shortPrompt } from './promptDetect';

const ASSET_NAMES = [...getBuiltinPresets().map((p) => p.name), ...getBuiltinTextures().map((x) => x.name)];
const known = knownNamesWith(ASSET_NAMES);
/** What the asset bar would say for nodes and the note (assets match by name, below). */
const hasResults = (q: string) => searchNodes(q, new Set()).length > 0 || noteMatchesQuery(q);
const detect = (q: string, results = hasResults(q)) => detectPrompt(q, { hasResults: results, known });

describe('promptWords', () => {
  it('folds like every search and splits on anything that is not a letter or digit', () => {
    expect(promptWords('Perlin Noise (vec3)')).toEqual(['perlin', 'noise', 'vec3']);
    expect(promptWords('  Krāsa,  ĶĪĻ-šū ')).toEqual(['krasa', 'kil', 'su']);
    expect(promptWords('')).toEqual([]);
  });
});

describe('partOfKnownName', () => {
  const names = knownNameWords(['Perlin Noise (vec3)', 'Color Ramp']);
  it('whole words in order from any word, the last one possibly unfinished', () => {
    expect(partOfKnownName(['perlin', 'noise'], names)).toBe(true);
    expect(partOfKnownName(['noise', 've'], names)).toBe(true);
    expect(partOfKnownName(['color', 'r'], names)).toBe(true);
    expect(partOfKnownName(['perl', 'noise'], names)).toBe(false);
    expect(partOfKnownName(['noise', 'perlin'], names)).toBe(false);
    expect(partOfKnownName(['color', 'ramp', 'glow'], names)).toBe(false);
    expect(partOfKnownName([], names)).toBe(false);
  });
});

describe('detectPrompt', () => {
  it('one word is never a request — the intro types "noise" into this box', () => {
    for (const q of ['noise', 'lava', 'make', 'glow?', '']) expect(detect(q, false), q).toBe(false);
    expect(readFileSync('src/intro/searchTour.ts', 'utf8')).toMatch(/noise/);
  });

  it('T1: four or more words are a request, results or not', () => {
    expect(detect('glowing lava cracks on dark rock', true)).toBe(true);
    expect(detect('blue water with slow waves', false)).toBe(true);
  });

  it('T2: three words are a request only when the search found nothing', () => {
    expect(detect('shiny gold metal', false)).toBe(true);
    expect(detect('shiny gold metal', true)).toBe(false);
  });

  it('T3: two words need no result AND a "?" or a request verb first', () => {
    expect(detect('make lava', false)).toBe(true);
    expect(detect('lava glow?', false)).toBe(true);
    expect(detect('lava glow', false)).toBe(false);
    expect(detect('make lava', true)).toBe(false);
    // Search verbs are not request verbs.
    expect(REQUEST_VERBS.has('add')).toBe(false);
    expect(REQUEST_VERBS.has('show')).toBe(false);
    expect(detect('add noise', false)).toBe(false);
  });

  it('never fires on a known name typed as plain words, in either language, finished or not', () => {
    const names: string[] = [];
    for (const def of NODE_REGISTRY.values()) names.push(def.label, nodeLabelLV(def.type));
    for (const name of ASSET_NAMES) names.push(name, assetText(name, 'lv'));
    for (const d of TUTORIALS) names.push(d.title, t(d.title, 'lv'));
    let multiWord = 0;
    for (const name of names) {
      const words = promptWords(name);
      if (words.length < 2) continue;
      multiWord++;
      // Typed out as plain words — which the substring search often cannot
      // find, so "no result" is the hard case — and at every point on the way.
      for (let n = 2; n <= words.length; n++) {
        const typed = words.slice(0, n).join(' ');
        expect(detect(typed, false), typed).toBe(false);
        expect(detect(typed.slice(0, -1), false), typed.slice(0, -1)).toBe(false);
      }
    }
    expect(multiWord).toBeGreaterThan(60);
  });

  it('a name with more words on top IS a request', () => {
    expect(detect('perlin noise that looks like marble veins', true)).toBe(true);
  });

  it('a pasted wall of text is a request by length, without a name scan', () => {
    expect(detect(Array.from({ length: 400 }, (_, i) => `w${i}`).join(' '), true)).toBe(true);
  });

  it('the Space menu knows node, alias, lesson and note names', () => {
    const menu = knownNodeNames();
    expect(partOfKnownName(promptWords('add note'), menu)).toBe(true);
    expect(partOfKnownName(promptWords('layer weight'), menu)).toBe(true);
  });
});

describe('shortPrompt', () => {
  it('is one line, shortened with an ellipsis', () => {
    expect(shortPrompt('  make\n it   glow ')).toBe('make it glow');
    const long = shortPrompt('a'.repeat(100));
    expect(long).toHaveLength(41);
    expect(long.endsWith('…')).toBe(true);
  });
});
