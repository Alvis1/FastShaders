import visibilityData from './editorVisibility.json';

/**
 * Which registry nodes and built-in textures the editor OFFERS to add (the
 * `In editor` checkbox of node-editor.html). The JSON lists what is HIDDEN, so
 * a new node is visible by default. Hiding is an ADD-SURFACE filter, never a
 * registry filter: a hidden node still parses, emits, evaluates and loads.
 * Only `getEditorDefinitions()`/`searchNodes()` and `isTextureHiddenFromEditor`
 * consult it (pinned by editorVisibility.test.ts). Project SOURCE, rewritten by
 * the dev-only `POST /__nd/visibility`; there is no runtime override.
 * See docs/dev/discovery-and-i18n.md.
 */
interface EditorVisibilityFile {
  /** Node `type` keys hidden from the editor's add surfaces. */
  nodes: string[];
  /** Built-in texture ids hidden from the content browser's Textures tab. */
  textures: string[];
}

const data = visibilityData as Partial<EditorVisibilityFile>;

/**
 * `new Set(x)` THROWS on a non-iterable and `nodeRegistry` imports this module,
 * so a hand-edited `"nodes": {}` degrades to "nothing hidden" instead of taking
 * down the app and node-editor.html, the one tool that could fix the file.
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
