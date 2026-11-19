/**
 * The worked examples a prompt carries: built-in presets and textures, chosen
 * by how many words they share with the request (English and Latvian display
 * text), written in the gate's CANONICAL form — the exact shape the model is
 * asked to produce, and guaranteed to pass the gate itself.
 *
 * Deterministic on purpose (no embeddings, no randomness): the same request
 * always gets the same examples, so a probe run and the app agree.
 */
import { assetText } from '@/i18n';
import type { Catalogue } from './catalogue';
import { gateProgram } from './gate';

export interface Example {
  id: string;
  /** What the example makes — the "Request:" line above its program. */
  request: string;
  /** Canonical program text. */
  code: string;
  /** Words it is known by: name (weighted), description, Latvian text, identifiers. */
  words: Map<string, number>;
  cost: number;
}

/** Used when no example shares a word with the request (the spike's trio). */
export const DEFAULT_EXAMPLE_IDS = ['uv-scroll', 'noise-mask', 'iridescence'];

const STOPWORDS = new Set([
  'the', 'and', 'with', 'from', 'that', 'this', 'into', 'over', 'like', 'look', 'make', 'some', 'very',
  'shader', 'surface', 'color', 'colour', 'colors', 'colours',
  'kas', 'pie', 'par', 'uz', 'no', 'vai', 'arī', 'kā', 'ar', 'krāsa', 'krāsā', 'krāsas', 'virsma',
]);

/** Lower-case words of three letters or more, Latvian letters included. */
export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-zāčēģīķļņšūž]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

function addWords(into: Map<string, number>, text: string, weight: number): void {
  for (const w of wordsOf(text)) into.set(w, Math.max(into.get(w) ?? 0, weight));
}

/** Words of a camelCase identifier: `edgeGlow` → edge, glow. */
const identWords = (code: string): string =>
  [...code.matchAll(/\bconst (\w+)/g)].map((m) => m[1].replace(/([a-z])([A-Z])/g, '$1 $2')).join(' ');

interface CorpusAsset { id: string; name: string; description: string; code: string }

/**
 * The example corpus: every built-in the gate accepts as written (the
 * channel-object ones are not examples of what the model may return).
 */
export function exampleCorpus(assets: readonly CorpusAsset[], catalogue: Catalogue): Example[] {
  const out: Example[] = [];
  for (const a of assets) {
    const r = gateProgram(a.code, '', { catalogue, takenNames: new Set() });
    if (!r.ok) continue;
    const words = new Map<string, number>();
    addWords(words, identWords(a.code), 1);
    addWords(words, a.description, 2);
    addWords(words, assetText(a.description, 'lv'), 2);
    addWords(words, a.name, 3);
    addWords(words, assetText(a.name, 'lv'), 3);
    out.push({ id: a.id, request: a.description.replace(/\s+/g, ' ').trim(), code: r.tsl.trim(), words, cost: r.cost });
  }
  return out;
}

/** The `k` examples sharing the most words with `request` — ties by lower
 *  cost, then id; the default trio when nothing matches. */
export function selectExamples(request: string, corpus: readonly Example[], k: number): Example[] {
  const words = new Set(wordsOf(request));
  const scored = corpus
    .map((e) => {
      let score = 0;
      for (const w of words) {
        // A shared stem counts too ("rippling" ↔ "ripples").
        for (const [ew, weight] of e.words) {
          if (ew === w) score += weight;
          else if (w.length >= 5 && ew.length >= 5 && (ew.startsWith(w.slice(0, 5)) || w.startsWith(ew.slice(0, 5)))) score += weight / 2;
        }
      }
      return { e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.e.cost - b.e.cost || (a.e.id < b.e.id ? -1 : 1))
    .map((s) => s.e);
  const picked = scored.slice(0, k);
  for (const id of DEFAULT_EXAMPLE_IDS) {
    if (picked.length >= k) break;
    const d = corpus.find((e) => e.id === id);
    if (d && !picked.includes(d)) picked.push(d);
  }
  return picked;
}
