/**
 * A fresh note's look, in ONE place: the store's `addNote` creates it, NoteNode
 * falls back to these colours, and the asset bar's Note tile draws a fresh
 * note from them — so the tile cannot drift from what a drop creates.
 */
export const NOTE_BODY_COLOR = '#fff7cc';
export const NOTE_HEADER_COLOR = '#ffd24a';
/** The same two colours on a DARK canvas — a note flips with the canvas, so its
 *  ink (`getContrastColor` of the body) turns light with it. */
export const NOTE_BODY_COLOR_DARK = '#3b3724';
export const NOTE_HEADER_COLOR_DARK = '#9a7a1c';

/**
 * The colours a note is DRAWN in. A note still holding the default light pair
 * (a fresh one stores it, an older file carries it) follows the canvas: on a
 * dark backdrop it takes the dark pair. A colour the user picked is never
 * touched. Display only — the stored value is unchanged.
 */
export function noteDrawnColors(
  color: string | undefined,
  headerColor: string | undefined,
  darkCanvas: boolean,
): { body: string; header: string } {
  const isDefault = (c: string | undefined, d: string) => c === undefined || (typeof c === 'string' && c.toLowerCase() === d);
  return {
    body: darkCanvas && isDefault(color, NOTE_BODY_COLOR) ? NOTE_BODY_COLOR_DARK : (color ?? NOTE_BODY_COLOR),
    header: darkCanvas && isDefault(headerColor, NOTE_HEADER_COLOR) ? NOTE_HEADER_COLOR_DARK : (headerColor ?? NOTE_HEADER_COLOR),
  };
}

export const NOTE_WIDTH = 240;
export const NOTE_HEIGHT = 150;
/** The smallest a note can be resized to (NoteNode's NodeResizeControl). */
export const NOTE_MIN_WIDTH = 120;
export const NOTE_MIN_HEIGHT = 70;
/** The tile payload's `nodeType` for a note — a flow type, not a registry type. */
export const NOTE_TILE_TYPE = 'note';
