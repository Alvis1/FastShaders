/**
 * The picture among pasted or dropped things, if there is one. A LEAF beside
 * `imageImport`'s file test: the palette's search box (the boot path) and the
 * generator dialog both ask it, so it must not live under src/llm.
 */
import { isImageFile } from './imageImport';

/** The first picture file a paste or a drop carries, or null. */
export function pictureFrom(transfer: DataTransfer | null | undefined): File | null {
  if (!transfer) return null;
  try {
    for (const file of Array.from(transfer.files ?? [])) if (isImageFile(file)) return file;
    // A pasted screenshot is an item, not always a file.
    for (const item of Array.from(transfer.items ?? [])) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) return file;
    }
  } catch {
    /* an unreadable clipboard holds no picture */
  }
  return null;
}

/**
 * Does a drag still in the air look like it carries a picture? Only the item
 * TYPES can be read before the drop, and some engines hide them: a file drag
 * whose types are unknown is let through, and the drop itself decides.
 */
export function dragMayHoldPicture(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false;
  try {
    if (Array.prototype.indexOf.call(transfer.types ?? [], 'Files') === -1) return false;
    const files = Array.from(transfer.items ?? []).filter((i) => i.kind === 'file');
    return files.length === 0 || files.some((i) => i.type === '' || i.type.startsWith('image/'));
  } catch {
    return false;
  }
}
