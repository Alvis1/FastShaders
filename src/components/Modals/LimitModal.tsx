import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t, type Language } from '@/i18n';
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

function copyFor(n: LimitNotice, language: Language): NoticeCopy {
  const name = n.fileName ? `“${n.fileName}”` : t('This image', language);
  switch (n.kind) {
    case 'image-too-large':
      return {
        title: t('Image too large to embed', language),
        message: t('{name} is still over the {limit} per-image budget even after downscaling. Images are embedded into the shader itself, so every kilobyte multiplies through auto-save and undo history.', language)
          .replace('{name}', () => name)
          .replace('{limit}', () => kb(MAX_IMAGE_ENCODED_CHARS)),
        suggestions: [
          t('Use several smaller images instead of one big one — small tiling textures usually read just as well and stay fast.', language),
          t('Crop to the detail you actually need before importing.', language),
          t('Flatten transparency: sources with alpha are stored as PNG, which is much heavier than WebP/JPEG.', language),
          t('Lower the source resolution — the preview rarely benefits beyond 1024px.', language),
        ],
        canProceed: true,
        showIgnoreToggle: true,
      };
    case 'image-too-many-pixels':
      return {
        title: t('Image dimensions too large', language),
        message: t('{name} {detail}exceeds the {limit} decode guard — decoding it would allocate gigabytes of raw pixels.', language)
          .replace('{name}', () => name)
          .replace('{detail}', () => (n.detail ? `(${n.detail}) ` : ''))
          .replace('{limit}', () => mp(MAX_SOURCE_PIXELS)),
        suggestions: [
          t('Resize the image in an editor before importing (≤2048px per side is plenty).', language),
          t('Split a huge atlas/panorama into several smaller images and combine them with UV nodes.', language),
        ],
        canProceed: true,
        showIgnoreToggle: true,
      };
    case 'image-total-cap':
      return {
        title: t('Project image budget reached', language),
        message: t('Adding {name} would push the combined size of all embedded images past {limit}. Every image is copied into auto-save, undo history, and any saved groups.', language)
          .replace('{name}', () => name)
          .replace('{limit}', () => kb(MAX_TOTAL_IMAGE_CHARS)),
        suggestions: [
          t('Prefer more, smaller textures over a few large ones — drop the resolution and tile them via the UV node.', language),
          t('Delete Image nodes you no longer use (their pixels stay embedded until removed).', language),
          t('Reuse one Image node for several effects instead of importing the file again.', language),
          t('Export the project (Download Shader) as a backup before going over the budget.', language),
        ],
        canProceed: true,
        showIgnoreToggle: true,
      };
    case 'images-stripped':
      return {
        title: t('Some images were not loaded', language),
        message: t('{detail} image payload(s) in the imported project exceeded the size limits and were skipped (the nodes stay, without pixels).', language)
          .replace('{detail}', () => n.detail ?? t('One or more', language)),
        suggestions: [
          t('Tick the checkbox below and re-import the file to keep the original images.', language),
          t('Or re-add the images at a smaller resolution — several small textures beat one big one.', language),
        ],
        canProceed: false,
        showIgnoreToggle: true,
      };
    case 'storage-quota':
      return {
        title: t('Browser storage is full', language),
        message: t('Saving {detail} to browser storage failed — the project is too big for the ~5 MB localStorage quota. Changes will NOT survive a reload until it fits again.', language)
          .replace('{detail}', () => n.detail ?? t('your work', language)),
        suggestions: [
          t('Click "Download Shader" in the code panel now — that file embeds the whole project and is your reliable backup.', language),
          t('Shrink or remove embedded images — they dominate the storage footprint; smaller resolutions tile just as well.', language),
          t('Delete saved groups you no longer need (they store their own copy of every embedded image).', language),
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
  const language = useAppStore((s) => s.language);
  const [ignoreFuture, setIgnoreFuture] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A fresh notice starts from the persisted opt-out state, so the checkbox
    // both enables AND disables it (unchecking turns the limits back on).
    setIgnoreFuture(useAppStore.getState().ignoreImageLimits);
  }, [head?.id]);

  useEffect(() => {
    if (!head) return;
    const onKey = (e: KeyboardEvent) => {
      // Every dismissal path commits the checkbox. It's a persisted global
      // preference, orthogonal to whether THIS image gets added, so its fate
      // must not depend on which cancel gesture was used — the Cancel button
      // already commits it, and Escape meaning something different was a trap.
      if (e.key === 'Escape') resolve('dismiss', ignoreFuture);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [head, resolve, ignoreFuture]);

  // Move focus into the dialog so keyboard users land on it and screen readers
  // announce it, rather than leaving focus behind on the canvas.
  useEffect(() => {
    if (head) panelRef.current?.focus();
  }, [head?.id]);

  if (!head) return null;
  const copy = copyFor(head, language);

  return (
    <div className="csv-import-modal__backdrop" onClick={() => resolve('dismiss', ignoreFuture)}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="limit-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="limit-modal-title">{copy.title}</div>
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
            {t('Ignore image size limits from now on (may slow the editor and break auto-save)', language)}
          </label>
        )}
        <div className="csv-import-modal__buttons">
          <button
            className="csv-import-modal__button"
            onClick={() => resolve('dismiss', ignoreFuture)}
          >
            {copy.canProceed ? t('Cancel', language) : t('OK', language)}
          </button>
          {copy.canProceed && (
            <button
              className="csv-import-modal__button csv-import-modal__button--primary"
              onClick={() => resolve('proceed', ignoreFuture)}
            >
              {t('Add anyway', language)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
