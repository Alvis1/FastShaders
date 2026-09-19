/**
 * The words for a zip the importer refused or partly skipped (N2, N3b).
 *
 * `zipLimitCopy` is what LimitModal's `zip-limit` notice says when the reader
 * crossed a cap (utils/zipReader.ts `ZipLimitError`); `zipModelSkippedLine` is
 * the canvas import-note line for a model entry that was refused while the rest
 * of the archive loaded (or, for a model-only zip, instead of it).
 *
 * Pure apart from `t()`: no store import, so limitNoticeCopy.ts and
 * importNote.ts can both use it in a node test.
 */
import { t, type Language } from '@/i18n';
import type { ZipLimitKind } from './zipReader';
import { MESH_MAX_BYTES, type MeshRefusal } from './previewMesh';
import { formatMiB } from './formatSize';
import { meshRefusalMessage } from './previewMeshMessage';
import { fillTemplate } from './fillTemplate';

export interface ZipLimitCopy {
  title: string;
  message: string;
  suggestions: string[];
}

/** The quoted file name, or "This file". User-supplied, so every sentence it
 *  goes into is filled in ONE pass (`fillTemplate`): a name spelling `{limit}`
 *  stays text, and a `$&` in it is never read as a replacement pattern. */
function quotedName(fileName: string | undefined, lang: Language): string {
  return fileName ? `“${fileName}”` : t('This file', lang);
}

export function zipLimitCopy(
  z: { kind: ZipLimitKind; limit: number; value: number },
  fileName: string | undefined,
  lang: Language,
): ZipLimitCopy {
  const name = quotedName(fileName, lang);
  const unzip = t('Unzip it, load the .js inside, then drop the 3D model onto the 3D preview (models up to {model} MB).', lang)
    .replace('{model}', () => formatMiB(MESH_MAX_BYTES, lang));
  switch (z.kind) {
    case 'total-size':
      return {
        title: t('File too large to open', lang),
        message: fillTemplate(
          t('{name} unpacks to more than {limit} MB, the most FastShaders opens from one file. Nothing was changed.', lang),
          { name, limit: formatMiB(z.limit, lang) },
        ),
        suggestions: [
          unzip,
          t('If you made it and still have the shader open, re-export it without the 3D model: right-click EXPORT.', lang),
        ],
      };
    case 'entry-count':
      // The count includes folder entries; "files" is the user-facing
      // simplification. The LV noun agrees with a limit ending in 2 (512).
      return {
        title: t('File too large to open', lang),
        message: fillTemplate(
          t('{name} holds more than {max} files, the most FastShaders opens from one archive. Nothing was changed.', lang),
          { name, max: z.limit },
        ),
        suggestions: [unzip],
      };
    case 'name':
      return {
        title: t('Cannot open this archive', lang),
        message: fillTemplate(
          t('{name} contains a file name longer than {max} bytes, which FastShaders cannot read. Nothing was changed.', lang),
          { name, max: z.limit },
        ),
        suggestions: [unzip],
      };
    case 'method':
      return {
        title: t('Cannot open this archive', lang),
        message: fillTemplate(t('{name} uses a compression method FastShaders cannot read. Nothing was changed.', lang), { name }),
        suggestions: [
          t('Re-create the archive with the zip tool built into your system, without a password.', lang),
        ],
      };
  }
}

/**
 * The import-note line for a refused model entry. `{reason}` is the SAME
 * sentence a preview drop of that model shows (`meshRefusalMessage`), so a
 * Draco model inside a zip gets the same advice as one dropped on its own.
 */
export function zipModelSkippedLine(
  line: { shaderLoaded: boolean; fileName: string; refusal: MeshRefusal },
  lang: Language,
): string {
  const reason = meshRefusalMessage(line.refusal, lang);
  if (line.shaderLoaded) {
    return fillTemplate(t('The shader loaded, but its 3D model was skipped: {reason}', lang), { reason });
  }
  return fillTemplate(t('The 3D model in {name} was skipped: {reason}', lang), {
    name: quotedName(line.fileName, lang),
    reason,
  });
}
