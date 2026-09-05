import type { NodeCategory } from '@/types';

/**
 * The palette's OPTIONAL categories — the ready-made Textures library and the
 * Distance fields family — which are OFF by default and switched on from the
 * toolbar's right-click list (the row beside "Trackpad scrolling").
 *
 * Off means "the editor never OFFERS them": no content-browser tab, no texture
 * cards or distance-field nodes in a live search, no rows in the Add-node
 * menu, none floated into its Recent list. It is an ADD-SURFACE filter, the
 * `editorVisibility` rule verbatim — `NODE_REGISTRY`, `getAllDefinitions()` and
 * `getBuiltinTextures()` keep every entry, so a saved `.fastshader`, a saved
 * group or a built-in preset holding one still loads, renders, compiles and
 * exports byte-identically whether the switch is on or off. Nothing under
 * `engine/` may import this module (`optionalCategories.test.ts` greps for it).
 *
 * Two layers, deliberately, and this is the SECOND: `editorVisibility.json`
 * hides individual UNFINISHED nodes as project source (the same answer for
 * every user of a build); this hides whole FINISHED categories per browser, as
 * a preference the user flips. The registry applies them in that order —
 * `getEditorDefinitions()` is the file's answer, `getEditorDefinitions(hidden)`
 * narrows it by this preference — so the tests that pin ranking over "the
 * editor set" stay meaningful whatever the user has switched on.
 *
 * The flags live in the store (the `trackpadScroll` precedent: several
 * surfaces read them, so React state in any one of them is the wrong home) and
 * persist per key, because a switch you flip in a settings list is expected to
 * stay flipped — a toggle that reset on reload would read as broken. This
 * replaced the `/textures` one-load session unlock (2026-09-04), whose
 * consume-once mechanism only existed because there was no visible control.
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
