/**
 * FastShaders i18n — a display-only English/Latvian overlay.
 *
 * DESIGN: Latvian never touches anything stored, generated, or matched by the
 * engine. Node types, TSL identifiers (`varName`), generated shader code,
 * `.fastshader` payloads and `data.label` all stay canonical English. Every
 * lookup here FALLS BACK to English when a Latvian string is missing, so the app
 * is never half-broken — untranslated keys simply render in English.
 *
 * SINGLE SOURCE OF TRUTH for node + category labels is `node-i18n.json`, which
 * the `fs-i18n-sync` vite plugin copies to `public/node-i18n.json` so the
 * standalone Node Designer (node-designer.html) fetches the very same data — no
 * duplicate label table. Descriptions / socket labels / UI chrome live in
 * `lv.json` (React-only; the designer doesn't need them).
 *
 * Node HEADERS on the canvas are deliberately NOT translated: they show the
 * generated TSL variable name (`mul1`, `perlin1`) so the graph mirrors the code.
 * The bilingual "Latviešu (English)" labels live where you PICK and read about a
 * node — the Add-node menu, the content browser, tooltips, the Node-Settings
 * menu, and the node designer.
 */
import nodeI18n from './node-i18n.json';
import lv from './lv.json';

export type Language = 'en' | 'lv';

const NODE_LABELS = nodeI18n.nodes as Record<string, string>;
const CATEGORY_LABELS = nodeI18n.categories as Record<string, string>;
const DESCRIPTIONS = lv.descriptions as Record<string, string>;
const PORTS = lv.ports as Record<string, string>;
const UI = lv.ui as Record<string, string>;

/** Raw Latvian label for a node type ('' if none). */
export function nodeLabelLV(type: string): string {
  return NODE_LABELS[type] ?? '';
}

/** Raw Latvian description for a node type ('' if none). */
export function nodeDescLV(type: string): string {
  return DESCRIPTIONS[type] ?? '';
}

/**
 * Node label for display. In Latvian mode, `bilingual` (the default) →
 * "Latviešu (English)" keeping the original English name in brackets, e.g.
 * "Reizināt (Multiply)" — used on roomy surfaces (add-node menu, tooltips).
 * `bilingual: false` → the Latvian word alone, for tight spots like palette
 * tiles where the bracketed form would overflow. English mode, or a missing
 * Latvian entry → the canonical English label unchanged. `enLabel` is the
 * registry `def.label`.
 */
export function formatNodeLabel(
  enLabel: string,
  type: string,
  lang: Language,
  bilingual = true,
): string {
  if (lang !== 'lv') return enLabel;
  const lvLabel = NODE_LABELS[type];
  if (!lvLabel) return enLabel;
  return bilingual ? `${lvLabel} (${enLabel})` : lvLabel;
}

/**
 * Category label. `bilingual` → "Latviešu (English)" (used in the roomy
 * add-node menu headers); otherwise Latvian-only (used on compact tabs). Falls
 * back to `enLabel` in English mode or when no Latvian entry exists.
 */
export function formatCategoryLabel(
  enLabel: string,
  id: string,
  lang: Language,
  bilingual = false,
): string {
  if (lang !== 'lv') return enLabel;
  const lvLabel = CATEGORY_LABELS[id];
  if (!lvLabel) return enLabel;
  return bilingual ? `${lvLabel} (${enLabel})` : lvLabel;
}

/** Node description for display: Latvian in LV mode (falls back to `enDesc`). */
export function nodeDescription(
  enDesc: string | undefined,
  type: string,
  lang: Language,
): string | undefined {
  if (lang !== 'lv') return enDesc;
  return DESCRIPTIONS[type] || enDesc;
}

/** Socket/port label for display: Latvian in LV mode (falls back to `enLabel`). */
export function portLabel(enLabel: string, lang: Language): string {
  if (lang !== 'lv') return enLabel;
  return PORTS[enLabel] || enLabel;
}

/**
 * UI chrome string, keyed by its English text. In Latvian mode returns the
 * translation, else the English key verbatim — so `t('Save', lang)` is safe
 * whether or not a translation exists yet.
 */
export function t(enKey: string, lang: Language): string {
  if (lang !== 'lv') return enKey;
  return UI[enKey] || enKey;
}

/**
 * Extra Latvian search haystack for a node type (label + description), so a
 * Latvian user can find nodes by Latvian terms. Empty string when untranslated;
 * callers OR this into their existing English match.
 */
export function nodeSearchLV(type: string): string {
  const label = NODE_LABELS[type] ?? '';
  const desc = DESCRIPTIONS[type] ?? '';
  return `${label} ${desc}`.toLowerCase();
}
