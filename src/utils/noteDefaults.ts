/**
 * A fresh note's look, in ONE place: the store's `addNote` creates it, NoteNode
 * falls back to these colours, and the asset bar's Note tile draws a fresh
 * note from them — so the tile cannot drift from what a drop creates.
 */
export const NOTE_BODY_COLOR = '#fff7cc';
export const NOTE_HEADER_COLOR = '#ffd24a';
export const NOTE_WIDTH = 240;
export const NOTE_HEIGHT = 150;
/** The smallest a note can be resized to (NoteNode's NodeResizeControl). */
export const NOTE_MIN_WIDTH = 120;
export const NOTE_MIN_HEIGHT = 70;
/** The tile payload's `nodeType` for a note — a flow type, not a registry type. */
export const NOTE_TILE_TYPE = 'note';
