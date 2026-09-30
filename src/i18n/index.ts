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
 * menu, and the node designer — and, in Latvian mode, in the hover tooltip that
 * opens ABOVE a canvas node's header (`nodeHeaderTip`).
 *
 * `lv.ui`/`lv.ports` are keyed by the ENGLISH TEXT: rewording a `t('…')` literal
 * silently ORPHANS its translation (English shows, nothing fails), so MOVE the
 * lv.json key with it. No CI guard, on purpose — sweep by hand for keys whose
 * text no source literal holds (mind `\'`/`\n` escapes, `${…}` and variable keys).
 */
import nodeI18n from './node-i18n.json';
import lv from './lv.json';

export type Language = 'en' | 'lv';

const NODE_LABELS = nodeI18n.nodes as Record<string, string>;
const CATEGORY_LABELS = nodeI18n.categories as Record<string, string>;
const DESCRIPTIONS = lv.descriptions as Record<string, string>;
const PORTS = lv.ports as Record<string, string>;
const UI = lv.ui as Record<string, string>;
const ASSETS = lv.assets as Record<string, string>;
const PALETTES = lv.palettes as Record<string, string>;

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
  // A name both languages share ("SDF") must not print as "SDF (SDF)".
  if (lvLabel === enLabel) return enLabel;
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
 * Built-in PRESET and TEXTURE text — names, descriptions, and the explainer
 * note a preset pins inside its frame — keyed by the ENGLISH text, like `ui`.
 * A reword in builtinPresets.ts/builtinTextures.ts therefore orphans the
 * Latvian (English shows), and `builtinAssetsI18n.test.ts` fails on it — unlike
 * a key by asset id, which would keep showing a stale translation silently.
 *
 * Its own map rather than `ui` because this lookup also runs over text the USER
 * owns: a dropped preset's group label and note are ordinary node data, stored
 * in English (a `.fastshader` never carries the UI language of whoever made
 * it) and translated only at display, so a sticky note that happens to read
 * "Save" must not come back as "Saglabāt". Text the user has edited no longer
 * matches and simply shows as typed.
 */
export function assetText(en: string, lang: Language): string {
  // The argument is often node data from a file: never let the lookup's own
  // ToPropertyKey run on a crafted object (`{"toString":1}` throws).
  if (lang !== 'lv' || typeof en !== 'string') return en;
  return (Object.prototype.hasOwnProperty.call(ASSETS, en) && ASSETS[en]) || en;
}

/**
 * Names of the BUILT-IN palettes and their swatches (`builtinPalettes.ts`),
 * keyed by the English text. Display-only and only for the built-ins — a
 * duplicated palette belongs to the shader and keeps the names it was saved
 * with (PalettesModal: the names are data in an exported file).
 */
export function paletteText(en: string, lang: Language): string {
  if (lang !== 'lv' || typeof en !== 'string') return en;
  return (Object.prototype.hasOwnProperty.call(PALETTES, en) && PALETTES[en]) || en;
}

/**
 * The hover tooltip of a CANVAS node's header in Latvian mode: the node's
 * bilingual name, "Reizināt (Multiply)". The header itself keeps showing the
 * generated varName (the graph mirrors the code), so this is where a Latvian
 * user reads what the node IS. `null` in English — the header's title then
 * stays the full header text, as before.
 */
export function nodeHeaderTip(enLabel: string, type: string, lang: Language): string | null {
  if (lang !== 'lv') return null;
  return formatNodeLabel(enLabel, type, lang);
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
