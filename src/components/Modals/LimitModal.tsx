import { useEffect, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import type { LimitNotice } from '@/store/useAppStore';
import {
  MAX_IMAGE_ENCODED_CHARS,
  MAX_TOTAL_IMAGE_CHARS,
  MAX_SOURCE_PIXELS,
} from '@/utils/imageNode';
import './CsvImportModal.css';
import './LimitModal.css';

const kb = (chars: number) => `${Math.round((chars * 0.75) / 1024)} KB`;
const mp = (px: number) => `${Math.round(px / 1e6)} MP`;

interface NoticeCopy {
  title: string;
  message: string;
  /** Actionable ways around the limit, rendered as a bullet list. */
  suggestions: string[];
  /** Whether the notice offers "Add anyway" (drop-time imports only). */
  canProceed: boolean;
  /** Whether the ignore-limits checkbox makes sense for this notice. */
  showIgnoreToggle: boolean;
}

function copyFor(n: LimitNotice): NoticeCopy {
  const name = n.fileName ? `“${n.fileName}”` : 'This image';
  switch (n.kind) {
    case 'image-too-large':
      return {
        title: 'Image too large to embed',
        message: `${name} is still over the ${kb(MAX_IMAGE_ENCODED_CHARS)} per-image budget even after downscaling. Images are embedded into the shader itself, so every kilobyte multiplies through auto-save and undo history.`,
        suggestions: [
          'Use several smaller images instead of one big one — small tiling textures usually read just as well and stay fast.',
          'Crop to the detail you actually need before importing.',
          'Flatten transparency: sources with alpha are stored as PNG, which is much heavier than WebP/JPEG.',
          'Lower the source resolution — the preview rarely benefits beyond 1024px.',
        ],
        canProceed: true,
        showIgnoreToggle: true,
      };
    case 'image-too-many-pixels':
      return {
        title: 'Image dimensions too large',
        message: `${name} ${n.detail ? `(${n.detail}) ` : ''}exceeds the ${mp(MAX_SOURCE_PIXELS)} decode guard — decoding it would allocate gigabytes of raw pixels.`,
        suggestions: [
          'Resize the image in an editor before importing (≤2048px per side is plenty).',
          'Split a huge atlas/panorama into several smaller images and combine them with UV nodes.',
        ],
        canProceed: true,
        showIgnoreToggle: true,
      };
    case 'image-total-cap':
      return {
        title: 'Project image budget reached',
        message: `Adding ${name} would push the combined size of all embedded images past ${kb(MAX_TOTAL_IMAGE_CHARS)}. Every image is copied into auto-save, undo history, and any saved groups.`,
        suggestions: [
          'Prefer more, smaller textures over a few large ones — drop the resolution and tile them via the UV node.',
          'Delete Image nodes you no longer use (their pixels stay embedded until removed).',
          'Reuse one Image node for several effects instead of importing the file again.',
          'Export the project (Download Script) as a backup before going over the budget.',
        ],
        canProceed: true,
        showIgnoreToggle: true,
      };
    case 'images-stripped':
      return {
        title: 'Some images were not loaded',
        message: `${n.detail ?? 'One or more'} image payload(s) in the imported project exceeded the size limits and were skipped (the nodes stay, without pixels).`,
        suggestions: [
          'Tick the checkbox below and re-import the file to keep the original images.',
          'Or re-add the images at a smaller resolution — several small textures beat one big one.',
        ],
        canProceed: false,
        showIgnoreToggle: true,
      };
    case 'storage-quota':
      return {
        title: 'Browser storage is full',
        message: `Saving ${n.detail ?? 'your work'} to browser storage failed — the project is too big for the ~5 MB localStorage quota. Changes will NOT survive a reload until it fits again.`,
        suggestions: [
          'Click "Download Shader" in the code panel now — that file embeds the whole project and is your reliable backup.',
          'Shrink or remove embedded images — they dominate the storage footprint; smaller resolutions tile just as well.',
          'Delete saved groups you no longer need (they store their own copy of every embedded image).',
        ],
        canProceed: false,
        // Shown here too so the opt-out can be turned back OFF from the place
        // where its consequences (quota failures) surface.
        showIgnoreToggle: true,
      };
  }
}

/**
 * One-at-a-time dialog for limit/storage notices. Beyond acknowledging, it
 * offers concrete ways around the limit and — for the import limits — a
 * persisted opt-out checkbox plus an "Add anyway" one-shot override.
 * Backdrop click + Escape dismiss.
 */
export function LimitModal() {
  const head = useAppStore((s) => s.pendingLimitNotices[0] ?? null);
  const resolve = useAppStore((s) => s.resolveLimitNotice);
  const [ignoreFuture, setIgnoreFuture] = useState(false);

  useEffect(() => {
    // A fresh notice starts from the persisted opt-out state, so the checkbox
    // both enables AND disables it (unchecking turns the limits back on).
    setIgnoreFuture(useAppStore.getState().ignoreImageLimits);
  }, [head?.id]);

  useEffect(() => {
    if (!head) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape = walk away: don't commit the checkbox either way.
      if (e.key === 'Escape') resolve('dismiss', null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [head, resolve]);

  if (!head) return null;
  const copy = copyFor(head);

  return (
    <div className="csv-import-modal__backdrop" onClick={() => resolve('dismiss', null)}>
      <div
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title">{copy.title}</div>
        <div className="csv-import-modal__message">{copy.message}</div>
        <ul className="limit-modal__suggestions">
          {copy.suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
        {copy.showIgnoreToggle && (
          <label className="limit-modal__ignore">
            <input
              type="checkbox"
              checked={ignoreFuture}
              onChange={(e) => setIgnoreFuture(e.target.checked)}
            />
            Ignore image size limits from now on (may slow the editor and break auto-save)
          </label>
        )}
        <div className="csv-import-modal__buttons">
          <button
            className="csv-import-modal__button"
            onClick={() => resolve('dismiss', ignoreFuture)}
          >
            {copy.canProceed ? 'Cancel' : 'OK'}
          </button>
          {copy.canProceed && (
            <button
              className="csv-import-modal__button csv-import-modal__button--primary"
              onClick={() => resolve('proceed', ignoreFuture)}
            >
              Add anyway
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
