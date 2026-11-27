/**
 * Ask the Palettes dialog to import a palette file — a `.gpl`, or a FastShaders
 * palette `.json` — picked with an Import button (utils/fileImport.ts). The
 * dialog opens and reads it exactly as its own "Open file" does: the size gate,
 * the parser, one undo step per palette and the dialog's own report. A LEAF:
 * it imports nothing. The toolbar (which owns the dialog) listens; nothing
 * happens where it is not mounted (the embed).
 */
export const PALETTE_FILE_EVENT = 'fs:palette-file';

export interface PaletteFileDetail {
  file: File;
}

export function requestPaletteImport(file: File): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PaletteFileDetail>(PALETTE_FILE_EVENT, { detail: { file } }));
}

/** The file a request carries — a real `File` only, whatever its shape. */
export function paletteFileOf(ev: Event): File | null {
  const file = (ev as CustomEvent<PaletteFileDetail | null>).detail?.file;
  return file instanceof File ? file : null;
}
