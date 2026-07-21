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

/** Which persisted preference this notice's checkbox toggles. */
type TogglePref = 'ignore-limits' | 'hide-downscale-warning';

interface NoticeCopy {
  title: string;
  message: string;
  /** Actionable ways around the limit, rendered as a bullet list. */
  suggestions: string[];
  /** Whether the notice offers "Add anyway" (drop-time imports only). */
  canProceed: boolean;
  /** The persisted opt-out checkbox this notice offers, if any. */
  toggle: { label: string; pref: TogglePref } | null;
}

function copyFor(n: LimitNotice, language: Language): NoticeCopy {
  const name = n.fileName ? `“${n.fileName}”` : t('This image', language);
  const ignoreToggle = {
    label: t('Ignore image size limits from now on (may slow the editor and break auto-save)', language),
    pref: 'ignore-limits' as const,
  };
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
        toggle: ignoreToggle,
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
        toggle: ignoreToggle,
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
        toggle: ignoreToggle,
      };
    case 'image-device-downscaled': {
      const d = n.downscale;
      const dim = (w?: number, h?: number) => (w && h ? `${w}×${h}` : '');
      const device = d?.deviceLabel || t('your device', language);
      return {
        title: t('Image resized for {device}', language).replace('{device}', () => device),
        message: t('{name} ({src}) is larger than the recommended texture size for {device} ({cap}px). It was downscaled to {final} to keep the shader fast on that headset.', language)
          .replace('{name}', () => name)
          .replace('{src}', () => dim(d?.sourceW, d?.sourceH))
          .replace('{device}', () => device)
          .replace('{cap}', () => String(d?.cap ?? ''))
          .replace('{final}', () => dim(d?.finalW, d?.finalH)),
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
        message: t('{detail} image payload(s) in the imported project exceeded the size limits and were skipped (the nodes stay, without pixels).', language)
          .replace('{detail}', () => n.detail ?? t('One or more', language)),
        suggestions: [
          t('Tick the checkbox below and re-import the file to keep the original images.', language),
          t('Or re-add the images at a smaller resolution — several small textures beat one big one.', language),
        ],
        canProceed: false,
        toggle: ignoreToggle,
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
        toggle: ignoreToggle,
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
  const [checkboxOn, setCheckboxOn] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // The device-downscale notice hides a warning (`hideImageDownscaleWarning`);
  // every other notice toggles the size-limit opt-out (`ignoreImageLimits`).
  const isDownscale = head?.kind === 'image-device-downscaled';

  // Commit the checkbox to its persisted preference and advance the queue. The
  // preference is orthogonal to whether THIS image is added, so every dismissal
  // path commits it — Cancel, Escape, and the backdrop must not differ.
  const commit = (action: 'dismiss' | 'proceed') => {
    if (isDownscale) {
      useAppStore.getState().setHideImageDownscaleWarning(checkboxOn);
      resolve(action, null); // leave `ignoreImageLimits` unchanged
    } else {
      resolve(action, checkboxOn);
    }
  };

  useEffect(() => {
    // A fresh notice starts from its checkbox's persisted state, so the box both
    // enables AND disables the preference (unchecking turns it back off).
    const st = useAppStore.getState();
    setCheckboxOn(isDownscale ? st.hideImageDownscaleWarning : st.ignoreImageLimits);
  }, [head?.id, isDownscale]);

  useEffect(() => {
    if (!head) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') commit('dismiss');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `commit` closes over the current head/checkboxOn — re-bind when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head, checkboxOn, isDownscale]);

  // Move focus into the dialog so keyboard users land on it and screen readers
  // announce it, rather than leaving focus behind on the canvas.
  useEffect(() => {
    if (head) panelRef.current?.focus();
  }, [head?.id]);

  if (!head) return null;
  const copy = copyFor(head, language);

  return (
    <div className="csv-import-modal__backdrop" onClick={() => commit('dismiss')}>
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
        {copy.toggle && (
          <label className="limit-modal__ignore">
            <input
              type="checkbox"
              checked={checkboxOn}
              onChange={(e) => setCheckboxOn(e.target.checked)}
            />
            {copy.toggle.label}
          </label>
        )}
        <div className="csv-import-modal__buttons">
          <button
            className="csv-import-modal__button"
            onClick={() => commit('dismiss')}
          >
            {copy.canProceed ? t('Cancel', language) : t('OK', language)}
          </button>
          {copy.canProceed && (
            <button
              className="csv-import-modal__button csv-import-modal__button--primary"
              onClick={() => commit('proceed')}
            >
              {t('Add anyway', language)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
