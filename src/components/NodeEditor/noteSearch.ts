/**
 * Words that find the note, in both UI languages — the Add menu's "Add Note"
 * row and the asset bar's Note tile alike. A note is not a registry node, so
 * `searchNodes` can never return it: without this both searches answered
 * "note" (or "piezīme") with nothing at all.
 */
const NOTE_WORDS = [
  'note', 'notes', 'annotate', 'annotation', 'comment', 'text', 'sticky',
  'piezīme', 'piezīmes', 'piezīmi', 'teksts', 'komentārs', 'anotācija',
];

/** Lower-case, with diacritics dropped, so "piezime" finds "piezīme". */
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const FOLDED = NOTE_WORDS.map(fold);

/** True when `query` names the note: a word starts with it, or one of its own
 *  words IS one ("add note"). Needs two letters, so a lone "t" stays quiet —
 *  and "texture" is not text. */
export function noteMatchesQuery(query: string): boolean {
  const q = fold(query.trim());
  if (q.length < 2) return false;
  const words = q.split(/\s+/);
  return FOLDED.some((w) => w.startsWith(q) || words.includes(w));
}
