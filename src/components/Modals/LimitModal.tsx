import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { limitNoticeCopy } from './limitNoticeCopy';
import { desktopLiftsLimit } from '@/utils/desktopAppNoteRules';
import { DesktopAppNote } from './DesktopAppNote';
import './CsvImportModal.css';
import './LimitModal.css';

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
  // The persisted opt-out the notice was raised under (not the dialog's own
  // checkbox, which is only committed on dismissal): under Ignore limits an
  // image-too-large refusal was the 8M hard ceiling, which desktop shares.
  const ignoreLimits = useAppStore((s) => s.ignoreImageLimits);
  const [checkboxOn, setCheckboxOn] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // The device-downscale notice hides a warning (`hideImageDownscaleWarning`);
  // every other notice toggles the size-limit opt-out (`ignoreImageLimits`).
  const isDownscale = head?.kind === 'image-device-downscaled';

  // The notice's words (limitNoticeCopy.ts). Computed before `commit`, which
  // needs to know whether this notice offers a checkbox at all.
  const copy = head ? limitNoticeCopy(head, language) : null;

  // Commit the checkbox to its persisted preference and advance the queue. The
  // preference is orthogonal to whether THIS image is added, so every dismissal
  // path commits it — Cancel, Escape, and the backdrop must not differ.
  const commit = (action: 'dismiss' | 'proceed') => {
    if (isDownscale) {
      useAppStore.getState().setHideImageDownscaleWarning(checkboxOn);
      resolve(action, null); // leave `ignoreImageLimits` unchanged
    } else {
      // A notice with no checkbox has no preference to commit: passing the
      // (stale) box state would silently rewrite `ignoreImageLimits`.
      resolve(action, copy?.toggle ? checkboxOn : null);
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

  if (!head || !copy) return null;

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
        {copy.suggestions.length > 0 && (
          <ul className="limit-modal__suggestions">
            {copy.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
        {desktopLiftsLimit(head, ignoreLimits) && <DesktopAppNote language={language} />}
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
              {copy.proceedLabel ?? t('Add anyway', language)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
