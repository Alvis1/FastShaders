/**
 * The NAME a dropped shader file gives the document — the pure half of the
 * dropped-shader dialog (`components/Modals/ShaderImportModal.tsx`).
 *
 * OPEN adopts a name, and there are two candidates: the one AUTHORED inside
 * the file (its FASTSHADERS_PROJECT_V1 block's `shaderName`) and the file's
 * own stem. The authored name wins when there is one — it is what the author
 * called the shader, and a file renamed by a browser download (`waves (1).js`)
 * or by Finder should not rewrite it. The stem is the FALLBACK, and it is what
 * this adds: a bare shaderloader script and a block that ships no name both
 * used to leave the PREVIOUS shader's name on a graph that has nothing to do
 * with it, which is what then misled the next export.
 *
 * (The desktop Work folder answers the same question differently and
 * deliberately — `utils/workFolderFile.ts`'s `adoptShaderName` lets the name on
 * DISK win, because there the file is the document's identity and Save has to
 * find its way back to it. A drop has no such loop.)
 *
 * A dropped file name is attacker-chosen: it is rendered in the toolbar, saved
 * to `fs:shaderName` and written into the next export, so it is trimmed,
 * stripped of control characters and bounded here.
 */

/** Every extension a shader DROP may arrive under (the three surfaces agree). */
const DROP_EXT_RE = /\.(js|mjs|tsl|txt|zip|fastshader)$/i;

/** Longest adopted name. Generous for a title, far short of a storage problem. */
export const MAX_DROPPED_NAME_LENGTH = 120;

/** The file name without its shader extension (`waves.js` -> `waves`). */
export function shaderDropStem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(DROP_EXT_RE, '');
}

/**
 * Bound a name arriving from a dropped file. Control characters (including the
 * line breaks that would break the toolbar's one-line box) become spaces, runs
 * collapse, and the result is trimmed and capped. Returns '' when nothing
 * usable is left, which every caller reads as "this file supplied no name".
 */
export function sanitizeDroppedName(name: string): string {
  const flat = name
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > MAX_DROPPED_NAME_LENGTH
    ? flat.slice(0, MAX_DROPPED_NAME_LENGTH).trim()
    : flat;
}

/**
 * The name OPEN gives the document: the authored one when the file supplies
 * one, else the file's stem. '' when neither is usable — the caller then
 * leaves the current name alone rather than blanking it.
 */
export function droppedShaderName(fileName: string, authoredName: string | null | undefined): string {
  return sanitizeDroppedName(authoredName ?? '') || sanitizeDroppedName(shaderDropStem(fileName));
}

/**
 * The label ADD writes on the group frame. Always the FILE's stem, never the
 * authored name: the frame answers "which drop did this come from", and the
 * user matched the file they dragged, not a name stored inside it.
 */
export function droppedGroupLabel(fileName: string): string {
  return sanitizeDroppedName(shaderDropStem(fileName)) || 'Added shader';
}
