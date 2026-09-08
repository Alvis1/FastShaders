/**
 * FastShaders i18n — a display-only English/Latvian overlay.
 *
 * DESIGN: Latvian never touches anything stored, generated, or matched by the
 * engine. Node types, TSL identifiers (`varName`), generated shader code,
 * `.fastshader` payloads and `data.label` all stay canonical English. Every
 * lookup here FALLS BACK to English when a Latvian string is missing, so the app
 * is never half-broken — untranslated keys simply render in English.
 *
 * SINGLE SOURCE OF TRUTH for node + category labels is `node-i18n.json`. Every
 * consumer imports THIS module — including the Node Designer, which is a Vite
 * entry whose bridge (src/nodeDesigner/bridge.tsx) wraps formatNodeLabel /
 * formatCategoryLabel. (The old standalone designer fetched a
 * `public/node-i18n.json` copy published by a vite sync plugin; both are
 * gone.) Descriptions / socket labels / UI chrome live in `lv.json`.
 *
 * Node HEADERS on the canvas are deliberately NOT translated: they show the
 * generated TSL variable name (`mul1`, `perlin1`) so the graph mirrors the code.
 * The bilingual "Latviešu (English)" labels live where you PICK and read about a
 * node — the Add-node menu, the content browser, tooltips, the Node-Settings
 * menu, and the node designer.
 *
 * `lv.ui`/`lv.ports` are keyed by the ENGLISH TEXT, so a reword at the call site
 * silently ORPHANS its translation — the key stops being asked for, `t()` falls
 * back to English, and the app quietly goes half-Latvian for a user who has
 * pressed LV, with nothing failing anywhere. That had happened 21 times by
 * 2026-09-05 (the tuned-uniform chip, the cost bar's device picker, the Model
 * dropdown's disabled-state tooltip); those were translated then, and on
 * 2026-09-08 the other direction was swept too — 79 `ui` and 2 `ports` keys no
 * `t()`/`portLabel` call could reach were deleted (4.5 KB raw, 1.6 KB gzipped).
 * Most were reworded call sites; ~40 were the Node Designer's inspector, whose
 * chrome lives as static English markup in node-designer.html and never passes
 * through `t()` at all. So lv.json is now exactly the set of strings the app
 * asks for, minus FOUR it deliberately leaves untranslated: "1x"/"2x"/"3x"/"FPS"
 * are identical in Latvian, and an identity entry there is bulk, not a
 * translation.
 *
 * WHEN YOU REWORD A `t('…')` LITERAL, move the lv.json key with it rather than
 * adding a second one. There is deliberately no CI guard for this: a sweep can
 * only run over the whole tree, and a red suite on every in-progress reword
 * would train people to delete the guard. A sweep is cheap to redo by hand —
 * a key is live when its exact text appears as a string literal somewhere in
 * `src`, which must be measured with a scanner that skips comments and looks
 * INSIDE `${…}` (both mistakes report live keys as dead), and dozens of `t()`
 * sites pass a variable, so matching only `t('…')` literals is not enough.
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
