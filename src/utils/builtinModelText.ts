/**
 * The served bunny's OBJ text, once the preview has fetched it (ShaderPreview's
 * `fetchObjText` is the one writer). The export reads it SYNCHRONOUSLY: an
 * export must not await a fetch between the click and the download (Safari's
 * transient activation), and while the preview shows the bunny the text has
 * already arrived. Session-only module state, never persisted; LEAF.
 */
let bunnyText: string | null = null;

export function rememberBunnyText(text: string): void {
  if (typeof text === 'string' && text.length > 0) bunnyText = text;
}

export function bunnyTextNow(): string | null {
  return bunnyText;
}
