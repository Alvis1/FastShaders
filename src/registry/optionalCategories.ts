import type { NodeCategory } from '@/types';

/**
 * The palette's OPTIONAL categories (Textures, Distance fields): OFF by
 * default, switched on per browser from the toolbar's right-click list. An
 * ADD-SURFACE filter layered over `editorVisibility`, never a registry filter:
 * a graph holding these nodes loads, compiles and exports identically either
 * way, and nothing under engine/, utils/ or hooks/ may import this module
 * (optionalCategories.test.ts). See docs/dev/discovery-and-i18n.md.
 */
export const OPTIONAL_CATEGORIES = ['texture', 'sdf'] as const satisfies readonly NodeCategory[];

export type OptionalCategory = (typeof OPTIONAL_CATEGORIES)[number];

/** Which optional categories are switched ON. */
export type OptionalCategoryFlags = Readonly<Record<OptionalCategory, boolean>>;

/** localStorage key per category; `'1'` means on, anything else off. */
export const OPTIONAL_CATEGORY_KEYS: Readonly<Record<OptionalCategory, string>> = {
  texture: 'fs:showTextures',
  sdf: 'fs:showDistanceFields',
};

/** Everything off — the shipped default, and the study's clean slate. */
export const DEFAULT_OPTIONAL_CATEGORIES: OptionalCategoryFlags = { texture: false, sdf: false };

export function isOptionalCategory(id: string): id is OptionalCategory {
  return (OPTIONAL_CATEGORIES as readonly string[]).includes(id);
}

/**
 * The persisted flags, read through `read` (the store's throw-safe
 * `localStorage.getItem` wrapper; a test passes a stub). Only the exact string
 * `'1'` switches a category on — the same validate-never-coerce rule every
 * other localStorage read follows, since anything at this origin can write
 * the key.
 */
export function loadOptionalCategories(read: (key: string) => string | null): OptionalCategoryFlags {
  const flags = { ...DEFAULT_OPTIONAL_CATEGORIES } as Record<OptionalCategory, boolean>;
  for (const id of OPTIONAL_CATEGORIES) {
    let raw: string | null = null;
    try { raw = read(OPTIONAL_CATEGORY_KEYS[id]); } catch { raw = null; }
    flags[id] = raw === '1';
  }
  return flags;
}

/**
 * The categories to WITHHOLD from an add surface given the flags — i.e. the
 * optional ones that are off. This is what `getEditorDefinitions(hidden)` and
 * `searchNodes(query, hidden)` take, so a consumer can never pass the flags
 * the wrong way round (a set of hidden ids has one meaning; a boolean per
 * category has two).
 */
export function hiddenOptionalCategories(flags: OptionalCategoryFlags): ReadonlySet<NodeCategory> {
  const hidden = new Set<NodeCategory>();
  for (const id of OPTIONAL_CATEGORIES) if (!flags[id]) hidden.add(id);
  return hidden;
}

/**
 * COMPANIONS: node types that live in ANOTHER category but exist for an
 * optional family, withheld from the add surfaces together with it (a family
 * hidden with one door left open was the reported bug). Add-surface only.
 */
export const OPTIONAL_CATEGORY_COMPANIONS: Readonly<Record<OptionalCategory, readonly string[]>> = {
  texture: [],
  sdf: ['raymarchOutput', 'rayDirection'],
};

/**
 * The node TYPES to withhold for a hidden-category set — the companions of
 * every optional category in it. `getEditorDefinitions(hidden)` applies this
 * beside the category test, so every consumer of the editor set gets both.
 */
export function withheldNodeTypes(hidden: ReadonlySet<NodeCategory>): ReadonlySet<string> {
  const types = new Set<string>();
  for (const id of OPTIONAL_CATEGORIES) {
    if (hidden.has(id)) for (const t of OPTIONAL_CATEGORY_COMPANIONS[id]) types.add(t);
  }
  return types;
}

/**
 * The content-browser tabs to DRAW: `tabs` minus every optional category that
 * is switched off. Pure so the decision can be tested by value — the strip's
 * whole visible half is this one filter.
 */
export function visibleTabs<T extends { id: string }>(tabs: readonly T[], flags: OptionalCategoryFlags): T[] {
  return tabs.filter((tab) => !isOptionalCategory(tab.id) || flags[tab.id]);
}

/**
 * The tab to SHOW for a stored `fs:assetTab` value: the stored one, unless it
 * names an optional category that is switched off, in which case `'all'`.
 *
 * DERIVED at render and never written back — the stored value survives, so
 * switching the category back on returns the user to the tab they left.
 * Writing `'all'` into storage instead would discard that tab for good
 * (`usePersistedState` persists every value it is handed).
 */
export function effectiveTab<T extends string>(stored: T, flags: OptionalCategoryFlags): T | 'all' {
  return isOptionalCategory(stored) && !flags[stored] ? 'all' : stored;
}
