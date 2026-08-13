import visibilityData from './editorVisibility.json';

/**
 * Which registry nodes and built-in textures the EDITOR offers as things to add.
 *
 * This is the "unfinished node" switch behind node-editor.html's `In editor`
 * checkbox: a node that is written but not ready to be shown to users is listed
 * here and disappears from the content browser, the Add-node menu, search and
 * the recents list — while staying fully functional everywhere else.
 *
 * Three rules make that safe, and all three are load-bearing:
 *
 * 1. **The file lists what is HIDDEN, not what is shown.** Default-visible means
 *    a node added to the registry tomorrow appears without anyone remembering
 *    this file exists; an allow-list would make every new node invisible until
 *    someone edited it, which is the failure nobody would think to look for.
 *
 * 2. **Hiding is an ADD-SURFACE filter, never a registry filter.** `NODE_REGISTRY`
 *    and `getAllDefinitions()` keep every definition, so a hidden node still
 *    resolves for `codeToGraph`, `graphToCode`, `cpuEvaluator`, `loadGraph`, the
 *    built-in textures/presets that contain it, the Node Designer (you hide a
 *    node precisely so you can finish designing it) and node-editor.html itself
 *    (which is where you switch it back on). Filtering the registry instead would
 *    turn every saved `.fastshader` holding that node into `unknown` nodes.
 *
 * 3. **Only the add surfaces consult it**, through `getEditorDefinitions()` /
 *    `searchNodes()` in `nodeRegistry.ts` and `isTextureHiddenFromEditor` in the
 *    content browser. `editorVisibility.test.ts` greps those surfaces, so a new
 *    palette-like list that calls `getAllDefinitions()` directly fails the suite
 *    rather than quietly leaking a hidden node back into the UI.
 *
 * The file is rewritten wholesale by the dev-only `POST /__nd/visibility`
 * endpoint (the `citations.json` shape), so it is project SOURCE that ships in
 * the build — not a per-browser preference. There is deliberately no runtime
 * override: "hidden" has to mean the same thing for every user of a build, or a
 * shared `.fastshader` would reference a node the recipient cannot see the tile
 * for while the author can.
 *
 * ── What hiding does NOT mean ───────────────────────────────────────────────
 *
 * Hidden means "the editor never OFFERS it", not "it is unreachable". Four
 * paths deliberately stay open, each for its own reason:
 *
 *  • **The code panel.** `tslLanguage.ts` completes from `NODE_REGISTRY`, and
 *    that is correct: a node's `tslFunction` is usually a REAL three/tsl symbol
 *    (`mod`, `abs`, `mx_noise_float`), so dropping it would degrade the TSL
 *    editor to police a palette decision. Typing it still parses back into the
 *    node, which is the point — the code panel edits TSL, not the palette.
 *  • **Convert to Property / Constant** (`NodeSettingsMenu`) transforms a node
 *    that already exists rather than adding a new one from a list.
 *  • **Built-in textures and presets** that were authored with the node keep
 *    containing it. Rewriting shipped artwork because a checkbox moved would be
 *    a far bigger side effect than the checkbox promises; node-editor.html shows
 *    a "⚠ in N built-ins" note on the row instead.
 *  • **Presets themselves are not hideable** — node-editor.html has no preset
 *    rows, so there is no checkbox that could produce one. Adding them means
 *    adding rows there plus a key locator for `builtinPresets.ts`, not widening
 *    this file.
 *
 * If a node must be genuinely unreachable, delete it from the registry — that
 * is a different (and much more expensive) decision, because every graph that
 * already holds one degrades to an `unknown` node.
 */
interface EditorVisibilityFile {
  /** Node `type` keys hidden from the editor's add surfaces. */
  nodes: string[];
  /** Built-in texture ids hidden from the content browser's Textures tab. */
  textures: string[];
}

const data = visibilityData as Partial<EditorVisibilityFile>;

/**
 * `new Set(x)` THROWS on a non-iterable, and this module is imported by
 * `nodeRegistry`, so a hand-edited `"nodes": {}` would take down the whole app
 * AND node-editor.html — the one tool that could fix the file. A malformed half
 * degrades to "nothing hidden" instead, which is the safe direction: a node
 * that should be hidden merely shows up.
 */
const keys = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && k !== '') : [];

/** Node types hidden from the editor's add surfaces. Empty in a finished build. */
export const HIDDEN_NODE_TYPES: ReadonlySet<string> = new Set(keys(data.nodes));

/** Built-in texture ids hidden from the content browser. */
export const HIDDEN_TEXTURE_IDS: ReadonlySet<string> = new Set(keys(data.textures));

/** True when `type` must not be offered as a node to add. */
export function isNodeHiddenFromEditor(type: string): boolean {
  return HIDDEN_NODE_TYPES.has(type);
}

/** True when `id` must not be offered as a texture to add. */
export function isTextureHiddenFromEditor(id: string): boolean {
  return HIDDEN_TEXTURE_IDS.has(id);
}

/**
 * The on-disk lists, sorted, for node-editor.html's save payload and for the
 * test that pins the file's shape. Sorted so a toggle produces a one-line diff
 * instead of reordering the whole array.
 */
export function readEditorVisibility(): EditorVisibilityFile {
  return {
    nodes: [...HIDDEN_NODE_TYPES].sort(),
    textures: [...HIDDEN_TEXTURE_IDS].sort(),
  };
}
