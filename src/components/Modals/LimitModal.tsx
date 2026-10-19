import { useEffect, useRef, useState, type RefObject } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t, type Language } from '@/i18n';
import { limitNoticeCopy, type NoticeCopy } from './limitNoticeCopy';
import { desktopLiftsLimit } from '@/utils/desktopAppNoteRules';
import { DesktopAppNote } from './DesktopAppNote';
import { useModalKeys } from './useModalKeys';
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

  useModalKeys(!!head, (e) => {
    if (e.key === 'Escape') commit('dismiss');
  });

  // Move focus into the dialog so keyboard users land on it and screen readers
  // announce it, rather than leaving focus behind on the canvas.
  useEffect(() => {
    if (head) panelRef.current?.focus();
  }, [head?.id]);

  if (!head || !copy) return null;

  return (
    <div className="csv-import-modal__backdrop" onClick={() => commit('dismiss')}>
      <LimitNoticePanel
        copy={copy}
        language={language}
        panelRef={panelRef}
        desktopNote={desktopLiftsLimit(head, ignoreLimits)}
        checkboxOn={checkboxOn}
        onCheck={setCheckboxOn}
        onDismiss={() => commit('dismiss')}
        onProceed={() => commit('proceed')}
      />
    </div>
  );
}

/**
 * A notice's panel, from its copy (`limitNoticeCopy`): the dialog above, and
 * the intro window's stage (intro/ImageScene.tsx), which draws the
 * device-downscale notice inert over its small canvas.
 */
export function LimitNoticePanel({
  copy, language, panelRef, desktopNote, checkboxOn, onCheck, onDismiss, onProceed, inert = false,
}: {
  copy: NoticeCopy;
  language: Language;
  panelRef?: RefObject<HTMLDivElement>;
  desktopNote: boolean;
  checkboxOn: boolean;
  onCheck: (on: boolean) => void;
  onDismiss: () => void;
  onProceed: () => void;
  /** A picture of the dialog: no dialog role, nothing focusable. */
  inert?: boolean;
}) {
  const tab = inert ? -1 : undefined;
  return (
    <div
      ref={panelRef}
      className="csv-import-modal__panel"
      role={inert ? undefined : 'dialog'}
      aria-modal={inert ? undefined : true}
      aria-labelledby={inert ? undefined : 'limit-modal-title'}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="csv-import-modal__title" id={inert ? undefined : 'limit-modal-title'}>{copy.title}</div>
      <div className="csv-import-modal__message">{copy.message}</div>
      {copy.suggestions.length > 0 && (
        <ul className="limit-modal__suggestions">
          {copy.suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      {desktopNote && <DesktopAppNote language={language} />}
      {copy.toggle && (
        <label className="csv-import-modal__check">
          <input
            type="checkbox"
            tabIndex={tab}
            checked={checkboxOn}
            onChange={(e) => onCheck(e.target.checked)}
          />
          {copy.toggle.label}
        </label>
      )}
      <div className="csv-import-modal__buttons">
        <button
          className="csv-import-modal__button"
          tabIndex={tab}
          onClick={onDismiss}
        >
          {copy.canProceed ? t('Cancel', language) : t('OK', language)}
        </button>
        {copy.canProceed && (
          <button
            className="csv-import-modal__button csv-import-modal__button--primary"
            tabIndex={tab}
            onClick={onProceed}
          >
            {copy.proceedLabel ?? t('Add anyway', language)}
          </button>
        )}
      </div>
    </div>
  );
}
