/**
 * The words of every LimitModal notice, kept out of the component so they can
 * be pinned in a node test (the vitest env has no DOM to render the dialog in).
 * A new notice kind adds its `case` HERE and its keys to lv.json; the modal
 * only lays out whatever this returns.
 *
 * `LimitNotice` is imported as a TYPE so this module never loads the store.
 */
import { t, type Language } from '@/i18n';
import type { LimitNotice } from '@/store/useAppStore';
import {
  MAX_IMAGE_ENCODED_CHARS,
  MAX_TOTAL_IMAGE_CHARS,
  MAX_SOURCE_PIXELS,
  MAX_LIBRARY_IMAGE_CHARS,
  formatImageBudget,
} from '@/utils/imageNode';
import { READ_MAX_TOTAL_UNCOMPRESSED } from '@/utils/zipReader';
import { zipLimitCopy } from '@/utils/zipImportNotices';
import { fillTemplate } from '@/utils/fillTemplate';

const mp = (px: number) => `${Math.round(px / 1e6)} MP`;

/** Which persisted preference this notice's checkbox toggles. */
export type TogglePref = 'ignore-limits' | 'hide-downscale-warning';

export interface NoticeCopy {
  title: string;
  message: string;
  /** Actionable ways around the limit, rendered as a bullet list. */
  suggestions: string[];
  /** Whether the notice offers "Add anyway" (drop-time imports only). */
  canProceed: boolean;
  /** The persisted opt-out checkbox this notice offers, if any. */
  toggle: { label: string; pref: TogglePref } | null;
  /** The primary button's label when `canProceed` (default "Add anyway"). A
   *  kind whose override is not an ADD names its own action here. */
  proceedLabel?: string;
}

/**
 * Which grammatical slot a notice's `{name}` fills. English only needs its
 * sentence-initial capital, but Latvian inflects the fallback: "Šis attēls"
 * opens a sentence, "Pievienojot šo attēlu" takes the accusative and
 * "Atjaunojot šī attēla pirmspārveides versiju" the genitive. One nominative
 * fallback made two Latvian sentences ungrammatical and gave English
 * "Adding This image".
 */
type NameRole = 'subject' | 'object' | 'possessor';

const NAME_FALLBACK: { readonly [R in NameRole]: { en: string; lvKey: string } } = {
  subject: { en: 'This image', lvKey: 'This image' },
  object: { en: 'this image', lvKey: 'this image (object)' },
  possessor: { en: 'this image', lvKey: 'this image (possessor)' },
};

/** The `{name}` a notice prints: the quoted file name when it has one, else
 *  the fallback for `role`. English never goes through the disambiguated keys
 *  — `t()` returns the key verbatim in English, "(object)" included. */
function nameFor(n: LimitNotice, role: NameRole, language: Language): string {
  if (n.fileName) return `“${n.fileName}”`;
  if (n.nameFallback === 'these-images') {
    return language === 'lv' ? t('these images (object)', 'lv') : 'these images';
  }
  const f = NAME_FALLBACK[role];
  return language === 'lv' ? t(f.lvKey, 'lv') : f.en;
}

/**
 * The object of "Saving {detail} to browser storage failed" (N7). Latvian takes
 * the accusative there, so these keys hold accusative forms and must never be
 * reused where the sentence needs another case (N8 writes the locative into
 * its own whole-sentence keys for exactly that reason).
 */
function storageSlotObject(n: LimitNotice, language: Language): string {
  if (n.slot === 'graph') return t('graph auto-save', language);
  if (n.slot === 'savedGroups') return t('saved groups', language);
  return t('your work', language);
}

export function limitNoticeCopy(n: LimitNotice, language: Language): NoticeCopy {
  const ignoreToggle = {
    label: t('Ignore image size limits from now on (may slow the editor and break auto-save)', language),
    pref: 'ignore-limits' as const,
  };
  switch (n.kind) {
    case 'image-too-large':
      return {
        title: t('Image too large to embed', language),
        message: fillTemplate(
          t('{name} is still over the {limit} per-image budget even after downscaling. Images are embedded into the shader itself, so every kilobyte multiplies through auto-save and undo history.', language),
          { name: nameFor(n, 'subject', language), limit: formatImageBudget(MAX_IMAGE_ENCODED_CHARS) },
        ),
        suggestions: [
          t('Use several smaller images instead of one big one — small tiling textures usually read just as well and stay fast.', language),
          t('Crop to the detail you actually need before importing.', language),
          t('Flatten transparency: sources with alpha are stored as PNG, which is much heavier than WebP/JPEG.', language),
          t('Lower the source resolution — the preview rarely benefits beyond 1024px.', language),
        ],
        canProceed: true,
        toggle: ignoreToggle,
      };
    case 'image-too-many-pixels':
      return {
        title: t('Image dimensions too large', language),
        message: fillTemplate(
          t('{name} {detail}exceeds the {limit} decode guard — decoding it would allocate gigabytes of raw pixels.', language),
          {
            name: nameFor(n, 'subject', language),
            detail: n.detail ? `(${n.detail}) ` : '',
            limit: mp(MAX_SOURCE_PIXELS),
          },
        ),
        suggestions: [
          t('Resize the image in an editor before importing (≤2048px per side is plenty).', language),
          t('Split a huge atlas/panorama into several smaller images and combine them with UV nodes.', language),
        ],
        canProceed: true,
        toggle: ignoreToggle,
      };
    case 'image-total-cap':
      // "Add anyway" either re-places the dropped File (a drop) or runs the
      // notice's `proceed` (paste, duplicate, saved-group instantiate).
      return {
        title: t('Project image budget reached', language),
        message: fillTemplate(
          t('Adding {name} would push the combined size of all embedded images past {limit}. Every image is copied into auto-save, undo history, and any saved groups.', language),
          { name: nameFor(n, 'object', language), limit: formatImageBudget(MAX_TOTAL_IMAGE_CHARS) },
        ),
        suggestions: [
          t('Prefer more, smaller textures over a few large ones — drop the resolution and tile them via the UV node.', language),
          t('Delete Image nodes you no longer use (their pixels stay embedded until removed).', language),
          t('Reuse one Image node for several effects instead of importing the file again.', language),
          t('Export the project (the "Export" button in the toolbar) as a backup before going over the budget.', language),
        ],
        canProceed: true,
        toggle: ignoreToggle,
      };
    case 'image-revert-cap':
      // Deliberately NOT 'image-total-cap' with canProceed. That notice's
      // "Add anyway" places a NEW node from a File; a revert has neither, so
      // the override would silently do nothing. Here the checkbox IS the
      // override: tick it, then click Revert again.
      return {
        title: t('Not enough image budget to revert', language),
        message: fillTemplate(
          t('Restoring {name} to its pre-conversion version would push the combined size of all embedded images past {limit}. The original is usually larger than the converted copy, which is the point of the conversion.', language),
          { name: nameFor(n, 'possessor', language), limit: formatImageBudget(MAX_TOTAL_IMAGE_CHARS) },
        ),
        suggestions: [
          t('Delete or shrink other Image nodes, then revert again.', language),
          t('Or tick the box below and click “Revert to original” again to go over the budget anyway.', language),
        ],
        canProceed: false,
        toggle: ignoreToggle,
      };
    case 'image-device-downscaled': {
      const d = n.downscale;
      const dim = (w?: number, h?: number) => (w && h ? `${w}×${h}` : '');
      const device = d?.deviceLabel || t('your device', language);
      return {
        title: fillTemplate(t('Image resized for {device}', language), { device }),
        // {name} AND {device} are user-supplied (a device label comes from an
        // imported cost profile), so the fill is one pass: neither can capture
        // a placeholder the other sentence half still needs.
        message: fillTemplate(
          t('{name} ({src}) is larger than the recommended texture size for {device} ({cap}px). It was downscaled to {final} to keep the shader fast on that headset.', language),
          {
            name: nameFor(n, 'subject', language),
            src: dim(d?.sourceW, d?.sourceH),
            device,
            cap: String(d?.cap ?? ''),
            final: dim(d?.finalW, d?.finalH),
          },
        ),
        suggestions: [
          t('Pick a more powerful target headset in the cost bar to allow larger textures.', language),
          t('Or re-import with “Ignore image size limits” ticked to keep more resolution (heavier project, may slow the editor).', language),
        ],
        canProceed: false,
        toggle: { label: t('Don’t show this warning again', language), pref: 'hide-downscale-warning' },
      };
    }
    case 'images-stripped':
      return {
        title: t('Some images were not loaded', language),
        message: fillTemplate(
          t('{detail} image payload(s) in the imported project exceeded the size limits and were skipped (the nodes stay, without pixels).', language),
          { detail: n.detail ?? t('One or more', language) },
        ),
        suggestions: [
          t('Tick the checkbox below and re-import the file to keep the original images.', language),
          t('Or re-add the images at a smaller resolution — several small textures beat one big one.', language),
        ],
        canProceed: false,
        toggle: ignoreToggle,
      };
    case 'output-sections-trimmed':
      // Decision 9: a restore that dropped or emptied Output sections, or mesh
      // assignments, past the caps or invalid says so. A refusal with no
      // checkbox: nothing the user can tick brings the dropped entries back.
      // One whole-sentence key per slot, the N8 shape (Latvian puts the
      // location in the locative and the count at the end).
      return {
        title: t('Some Output sections were not loaded', language),
        message: fillTemplate(
          n.slot === 'savedGroups'
            ? t('{n} Output section(s) or mesh assignment(s) in your saved groups were invalid or over the limits of the editor, and were removed or left without a target.', language)
            : n.slot === 'graph'
              ? t('{n} Output section(s) or mesh assignment(s) in your saved graph were invalid or over the limits of the editor, and were removed or left without a target.', language)
              : t('{n} Output section(s) or mesh assignment(s) in the opened file were invalid or over the limits of the editor, and were removed or left without a target.', language),
          { n: n.detail ?? t('One or more', language) },
        ),
        suggestions: [],
        canProceed: false,
        toggle: null,
      };
    case 'images-stripped-on-load':
      // N8. Its own copy: the Ignore-limits checkbox cannot lift the 8M hard
      // ceiling, and there is no file to re-import. One whole-sentence key per
      // slot, because Latvian puts the location in the locative.
      return {
        title: t('Some images were not loaded', language),
        message: fillTemplate(
          n.slot === 'savedGroups'
            ? t('{n} image(s) in your saved groups were invalid or over the 8-million-character hard limit and were removed (the nodes stay, without pixels).', language)
            : t('{n} image(s) in your saved graph were invalid or over the 8-million-character hard limit and were removed (the nodes stay, without pixels).', language),
          { n: n.detail ?? t('One or more', language) },
        ),
        suggestions: [],
        canProceed: false,
        toggle: null,
      };
    case 'images-missing':
      // A project block named an image by key (`imageRefs`) and its own module
      // held no matching payload. A refusal with no checkbox: Ignore-limits
      // cannot recover bytes the file does not contain. The title is the N8
      // one; the count sits at the end in Latvian, like the N8 sentences.
      return {
        title: t('Some images were not loaded', language),
        message: fillTemplate(
          t('{n} image(s) in this file were not found in its shader module and were skipped (the nodes stay, without pixels).', language),
          { n: n.detail ?? t('One or more', language) },
        ),
        suggestions: [
          t('Export the shader again with the FastShaders version that made it, then import the new file.', language),
        ],
        canProceed: false,
        toggle: null,
      };
    case 'storage-quota':
      return {
        title: t('Browser storage is full', language),
        // The slot, never a free-form English `detail`: that string is how
        // this sentence reached Latvian users half in English.
        message: fillTemplate(
          t('Saving {detail} to browser storage failed — the project is too big for the ~5 MB localStorage quota. Changes will NOT survive a reload until it fits again.', language),
          { detail: storageSlotObject(n, language) },
        ),
        suggestions: [
          t('Click "Export" in the toolbar now — that file embeds the whole project and is your reliable backup.', language),
          t('Shrink or remove embedded images — they dominate the storage footprint; smaller resolutions tile just as well.', language),
          t('Delete saved groups you no longer need (they store their own copy of every embedded image).', language),
        ],
        canProceed: false,
        // Shown here too so the opt-out can be turned back OFF from the place
        // where its consequences (quota failures) surface.
        toggle: ignoreToggle,
      };
    case 'image-resolution-cap': {
      // N6. Like the revert notice, the checkbox IS the override: tick it,
      // then pick the resolution again. Raised when the new encode GROWS the
      // payload (ImageNodeSettings) — which a step DOWN can do too (a lossless
      // source that fits a lower rung only lossy comes back longer), so
      // "Raising" is said only when the pick adds pixels (`resize.raising`).
      // Latvian puts the neutral sentence's name in the genitive ("šī attēla
      // izšķirtspēju"), hence the second role.
      const raising = n.resize?.raising === true;
      return {
        title: t('Not enough image budget for this resolution', language),
        message: fillTemplate(
          raising
            ? t('Raising {name} to {w}×{h} would push the combined size of all embedded images past {limit}.', language)
            : t('Resizing {name} to {w}×{h} would push the combined size of all embedded images past {limit}.', language),
          {
            name: nameFor(n, raising ? 'object' : 'possessor', language),
            w: String(n.resize?.width ?? ''),
            h: String(n.resize?.height ?? ''),
            limit: formatImageBudget(MAX_TOTAL_IMAGE_CHARS),
          },
        ),
        suggestions: [
          t('Delete or shrink other Image nodes, then pick the resolution again.', language),
          t('Or tick the box below and pick the resolution again to go over the budget anyway.', language),
        ],
        canProceed: false,
        toggle: ignoreToggle,
      };
    }
    case 'image-pick-cap':
      // The texture picker (and its "From file…" entry) REPLACES this node's
      // payload. Like the revert and resolution notices the checkbox IS the
      // override: tick it, then pick again. Not 'image-total-cap' — its "Add
      // anyway" places a NEW node from a File at a drop point, and a pick has
      // neither, so the override would silently do nothing.
      return {
        title: t('Not enough image budget for this texture', language),
        message: fillTemplate(
          t('Using {name} here would push the combined size of all embedded images past {limit}. Each Image node counts its own copy, even of an image another node already uses.', language),
          { name: nameFor(n, 'object', language), limit: formatImageBudget(MAX_TOTAL_IMAGE_CHARS) },
        ),
        suggestions: [
          t('Delete or shrink other Image nodes, then pick the texture again.', language),
          t('Or tick the box below and pick the texture again to go over the budget anyway.', language),
        ],
        canProceed: false,
        toggle: ignoreToggle,
      };
    case 'image-library-cap':
      // Counted against the saved-group library's OWN total: fs:savedGroups
      // is a second localStorage document beside fs:graph. "Save anyway" runs
      // the notice's `proceed`, which re-snapshots the live group.
      return {
        title: t('Saved groups image budget reached', language),
        message: fillTemplate(
          t('Saving {name} would push the combined size of all images in your saved groups past {limit}. Saved groups share browser storage with your auto-save.', language),
          { name: nameFor(n, 'object', language), limit: formatImageBudget(MAX_LIBRARY_IMAGE_CHARS) },
        ),
        suggestions: [
          t('Delete saved groups you no longer need (they store their own copy of every embedded image).', language),
          t('Shrink the group’s images before saving it: right-click an Image node → Resolution.', language),
        ],
        canProceed: true,
        proceedLabel: t('Save anyway', language),
        toggle: ignoreToggle,
      };
    case 'autosave-file-failed':
      // Desktop N7: the autosave FILE could not be written (utils/desktopAutosave.ts).
      // A refusal with no checkbox — no preference can make a disk accept a
      // write. `{reason}` is the OS error text Rust returned, kept in English
      // like `{error}` in the drop alerts.
      return {
        title: t('Could not save your work', language),
        message: fillTemplate(
          t('Writing the auto-save file failed: {reason}. Changes will NOT survive a restart until it succeeds.', language),
          { reason: n.detail ?? '' },
        ),
        suggestions: [
          t('Click "Export" in the toolbar now — that file embeds the whole project and is your reliable backup.', language),
        ],
        canProceed: false,
        toggle: null,
      };
    case 'autosave-file-read-failed':
      // Desktop: the boot could not READ the autosave file, so nothing was
      // loaded from it and file writes are paused for the session — an
      // unreadable file must never be overwritten.
      return {
        title: t('Could not open your auto-save', language),
        message: fillTemplate(
          t('Reading the auto-save file failed: {reason}. Nothing was loaded from it, and auto-save is paused for this session so the file is not overwritten — export your work to keep it.', language),
          { reason: n.detail ?? '' },
        ),
        suggestions: [],
        canProceed: false,
        toggle: null,
      };
    case 'zip-limit':
      // A REFUSAL with no checkbox: Ignore-limits cannot lift a reader cap,
      // and the file was never read. The words live in zipImportNotices.ts.
      return {
        ...zipLimitCopy(
          n.zipLimit ?? { kind: 'total-size', limit: READ_MAX_TOTAL_UNCOMPRESSED, value: 0 },
          n.fileName,
          language,
        ),
        canProceed: false,
        toggle: null,
      };
  }
}
