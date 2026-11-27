/**
 * `?lang=en` / `?lang=lv`: a link that opens FastShaders in a chosen UI
 * language (owner, 2026-11-27). A LEAF — no imports — so the store, the
 * device-comparison page and their tests can all read it.
 *
 * The rule, mirrored by the pre-paint guards in index.html and
 * compare/index.html: the FIRST `lang` parameter, trimmed and lower-cased,
 * counts only when it is exactly `en` or `lv`; anything else (absent, `de`,
 * `lv-LV`, empty) is no choice at all, and the stored preference decides.
 *
 * The editor ADOPTS the link's language as if the language button had been
 * clicked — it is saved to `fs:lang` — and then removes `lang` from the
 * address (`searchWithoutLang`), so a later reload keeps whatever the user
 * switches to rather than flipping back to the link's choice. The comparison
 * page writes no storage key, so there the parameter simply stays in its link.
 */

export type LinkLanguage = 'en' | 'lv';

/** The language a query string asks for, or null when it names none. */
export function linkLanguage(search: string): LinkLanguage | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('lang');
  } catch {
    return null;
  }
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'en' || v === 'lv' ? v : null;
}

/**
 * The query string with every `lang` parameter removed and every other
 * parameter left exactly as written (no re-encoding — a study link's own
 * parameters must not change spelling). `''` when nothing is left, else a
 * string starting with `?`.
 */
export function searchWithoutLang(search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const kept = query.split('&').filter((part) => {
    if (!part) return false;
    const eq = part.indexOf('=');
    let name = eq < 0 ? part : part.slice(0, eq);
    try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* keep raw */ }
    return name !== 'lang';
  });
  return kept.length ? `?${kept.join('&')}` : '';
}
