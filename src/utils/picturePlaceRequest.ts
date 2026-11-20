/**
 * Ask the canvas to place picture files as Image nodes — through its OWN
 * picture drop (NodeEditor's `placePictureFiles`: the convert-or-keep question,
 * the ghosts, every cap and budget, one note), so a picture handed over from a
 * dialog gets exactly what a dropped one does. A LEAF: the generator dialog
 * raises it ("Use the picture itself"), and it imports nothing.
 *
 * `at` is a spot on the canvas in flow coords; without one the pictures land
 * at the middle of the view. The canvas takes only real `File`s that look like
 * pictures, and ignores the request while it is not mounted.
 */
export const PLACE_PICTURES_EVENT = 'fs:place-pictures';

export interface PlacePicturesDetail {
  files: File[];
  at?: { x: number; y: number };
}

export function requestPicturePlacement(files: File[], at?: { x: number; y: number }): void {
  if (typeof window === 'undefined' || files.length === 0) return;
  window.dispatchEvent(new CustomEvent<PlacePicturesDetail>(PLACE_PICTURES_EVENT, { detail: { files, ...(at ? { at } : {}) } }));
}
