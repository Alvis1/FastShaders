/**
 * The picture extensions a FILE NAME can carry into an Image node — ONE list,
 * read by the two places that must agree on it: the drop filter
 * (`isImageFile`, utils/imageImport.ts) and the glTF image-name strip
 * (`gltfImageFileName`, utils/gltfReader.ts).
 *
 * They must agree because a file's own name rides into a model and back: a
 * drop stores `file.name` on the Image node, the single-GLB export writes the
 * picture's name as its glTF image name (engine/glbExportPlan.ts), and "Mesh
 * with Materials" over that export strips ONE picture extension before it
 * appends the sniffed one. With two lists the strip knew fewer than the filter
 * took, so 'photo.jfif' came back 'photo.jfif.png' (2026-10-09).
 *
 * Each reader adds the one name only it has: the filter takes `svg` (markup,
 * never pixels — it is let through only to reach its visible refusal, and
 * never reaches a model), the strip takes `ktx2` (a glTF image container,
 * KHR_texture_basisu, that no file brings into an Image node). A name accepted
 * by its MIME type alone ('cat.heic' on Safari) is in neither list: the export
 * renames it from the bytes instead. A LEAF with no imports, so the DOM-only
 * drop module and the trusted-side reader can both read it.
 */

export const PICTURE_EXTENSIONS: readonly string[] = Object.freeze([
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'pjp',
  'pjpeg',
  'webp',
  'gif',
  'bmp',
  'avif',
  'tif',
  'tiff',
  'ico',
]);

/** ONE trailing `.<extension>` from `extensions`, any case — never a general
 *  extension: 'photo.final' keeps its dot. */
export function trailingExtensionRe(extensions: readonly string[]): RegExp {
  const alternatives = extensions.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\.(?:${alternatives.join('|')})$`, 'i');
}
