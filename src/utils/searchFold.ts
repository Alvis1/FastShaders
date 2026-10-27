/**
 * THE fold every search box applies to BOTH sides — the typed query and every
 * text it is matched against: lower-case, then diacritics dropped, so "krasa"
 * finds "Krāsa" and "piezime" finds "piezīme". A query typed without the
 * long vowels and softened consonants is the normal case, not a typo: plenty
 * of keyboards have no Latvian layout switched on, and before 2026-10-27 only
 * the Note search folded, so "krasa" found no Color node anywhere.
 *
 * NFD splits each Latvian letter into its base letter plus ONE combining mark
 * (macron U+0304, caron U+030C, cedilla U+0327), and all three sit in the
 * Combining Diacritical Marks block, U+0300–U+036F. Folding is idempotent, so
 * text folded twice matches text folded once.
 *
 * A LEAF: the registry, the compare page, the Node Designer and the label
 * validator (loaded by vite.config through `ssrLoadModule`) all import it.
 */
export function foldSearchText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
