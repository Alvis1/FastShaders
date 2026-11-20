/**
 * Does a search query read as a REQUEST ("glowing lava with slow waves")
 * rather than a search ("perlin noise")? A LEAF: it imports only the search
 * fold, because both search boxes call it on the boot path
 * (docs/dev/node-generator.md § The search-box entry).
 *
 * It only ever OFFERS: a detected query shows an AI button or a last menu row,
 * and Enter opens the dialog. Nothing is sent, loaded or added by detection.
 *
 * The rules, on the folded query's words:
 *
 *   T1  4+ words, not part of a known name
 *   T2  exactly 3 words, no ordinary result, not part of a known name
 *   T3  exactly 2 words, no ordinary result, and a trailing "?" or a request
 *       verb first
 *
 * One word is never a request. "No ordinary result" alone would misfire:
 * search matches the whole phrase as ONE substring, so most multi-word names
 * typed as plain words ("perlin noise vec3") find nothing. Hence the name
 * guard: a query whose words run along a known name's words is someone typing
 * that name.
 */
import { foldSearchText } from './searchFold';

/** Words that open a request. English only — requests are written in English.
 *  Never "add" or "show": those are search verbs ("add noise node"). */
export const REQUEST_VERBS: ReadonlySet<string> = new Set([
  'make', 'create', 'generate', 'build', 'give', 'want', 'need', 'how', 'i',
]);

/** The longest query detection looks at; a longer one is a request by length
 *  alone, and the name scan below stays bounded on a pasted wall of text. */
const MAX_SCANNED_WORDS = 12;

/** A query's words: folded like every search text, split on anything that is
 *  not a letter or a digit ("Perlin Noise (vec3)" → perlin, noise, vec3). */
export function promptWords(text: string): string[] {
  return foldSearchText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * The known names as word lists, built once per name list by the caller
 * (`knownNameWords`), so a keystroke does not re-split a few hundred labels.
 */
export type KnownNames = readonly (readonly string[])[];

/** A name's words past this are not scanned: a saved group's name is stored
 *  text of any length, and no query that still needs the guard is longer. */
const MAX_NAME_WORDS = 16;
const MAX_NAME_CHARS = 200;

export function knownNameWords(names: Iterable<string>): KnownNames {
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const words = promptWords(name.slice(0, MAX_NAME_CHARS)).slice(0, MAX_NAME_WORDS);
    if (words.length === 0) continue;
    const key = words.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(words);
  }
  return out;
}

/**
 * Do the query's words run along a known name's words — whole words in order,
 * from any word of the name, the LAST one possibly still being typed?
 * "noise vec" is part of "Perlin Noise (vec3)"; "noise glowing" is not.
 */
export function partOfKnownName(words: readonly string[], known: KnownNames): boolean {
  if (words.length === 0) return false;
  const last = words.length - 1;
  for (const name of known) {
    for (let start = 0; start + words.length <= name.length; start++) {
      let ok = true;
      for (let i = 0; i < words.length && ok; i++) {
        const w = name[start + i];
        ok = i === last ? w.startsWith(words[i]) : w === words[i];
      }
      if (ok) return true;
    }
  }
  return false;
}

export interface PromptContext {
  /** Does the ordinary search (the All tab: nodes, the note, presets,
   *  textures) show at least one result for this query? */
  hasResults: boolean;
  /** Node labels and aliases, preset / recipe / texture names, lesson titles
   *  and "note", in English and Latvian (`knownNameWords`). */
  known: KnownNames;
}

/** Is this settled query a request? See the rules at the top. */
export function detectPrompt(query: string, ctx: PromptContext): boolean {
  const words = promptWords(query);
  if (words.length < 2) return false;
  if (words.length > MAX_SCANNED_WORDS) return true;
  if (partOfKnownName(words, ctx.known)) return false;
  if (words.length >= 4) return true;
  if (ctx.hasResults) return false;
  if (words.length === 3) return true;
  return query.trim().endsWith('?') || REQUEST_VERBS.has(words[0]);
}

/** The query as a menu row or a button shows it: one line, shortened. */
export function shortPrompt(query: string, max = 40): string {
  const flat = query.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}
