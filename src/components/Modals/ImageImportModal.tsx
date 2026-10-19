import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t, type Language } from '@/i18n';
import { useModalKeys } from './useModalKeys';
import './CsvImportModal.css';

export type ImageImportChoice = 'convert' | 'keep';

interface Props {
  /** Null when closed; otherwise what is about to be imported. */
  request: { count: number; fileName: string } | null;
  onResolve: (choice: ImageImportChoice, remember: boolean) => void;
}

/**
 * Asked once per drop, before anything is decoded: optimize this image, or
 * store it as it is?
 *
 * It is a question rather than a default because the conversion is lossy in a
 * way the app can't judge for the user — a normal map, a pixel-art tile and a
 * photo want different answers, and at drop time the app doesn't know which it
 * has (the "Data map" flag is only set afterwards).
 *
 * Deliberately one line: the explanation lives in the node's settings menu
 * (Format / Resolution / Size / Original), where it is available when someone
 * actually wants it, instead of in a dialog standing between a drag and the
 * canvas. **No is not "cancel"** — the image is imported either way, so
 * Escape and the backdrop mean No, not "throw the drop away".
 */
export function ImageImportModal({ request, onResolve }: Props) {
  const language = useAppStore((s) => s.language);
  const [remember, setRemember] = useState(false);
  const yesRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (request) setRemember(false);
  }, [request]);

  useModalKeys(!!request, (e) => {
    if (e.key === 'Escape') {
      onResolve('keep', false);
      return;
    }
    // Swallow the rest: the canvas binds its shortcuts on window and only
    // skips INPUT/TEXTAREA targets, so a keypress meant for this dialog
    // would otherwise edit the graph behind it. Capture phase runs first.
    if (e.key !== 'Tab') e.stopPropagation();
  }, true);

  // Focus Yes so Enter takes the common answer.
  useEffect(() => {
    if (request) yesRef.current?.focus();
  }, [request]);

  if (!request) return null;

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={() => onResolve('keep', false)}>
      <ImageImportPanel
        count={request.count}
        language={language}
        remember={remember}
        onRemember={setRemember}
        onNo={() => onResolve('keep', remember)}
        onYes={() => onResolve('convert', remember)}
        yesRef={yesRef}
      />
    </div>,
    document.body,
  );
}

/**
 * The question's panel: the dialog above, and the intro window's stage
 * (intro/ImageScene.tsx), which draws it inert over its small canvas.
 */
export function ImageImportPanel({
  count, language, remember, onRemember, onNo, onYes, yesRef, inert = false,
}: {
  count: number;
  language: Language;
  remember: boolean;
  onRemember: (on: boolean) => void;
  onNo: () => void;
  onYes: () => void;
  yesRef?: RefObject<HTMLButtonElement>;
  /** A picture of the dialog: no dialog role, nothing focusable. */
  inert?: boolean;
}) {
  const tab = inert ? -1 : undefined;
  return (
    <div
      className="csv-import-modal__panel"
      role={inert ? undefined : 'dialog'}
      aria-modal={inert ? undefined : true}
      aria-labelledby={inert ? undefined : 'image-import-modal-title'}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="csv-import-modal__title" id={inert ? undefined : 'image-import-modal-title'}>
        {count > 1
          ? t('Convert {count} images to optimized format?', language)
              .replace('{count}', () => String(count))
          : t('Convert image to optimized format?', language)}
      </div>
      <label className="csv-import-modal__check">
        <input
          type="checkbox"
          tabIndex={tab}
          checked={remember}
          onChange={(e) => onRemember(e.target.checked)}
        />
        {t('Don’t ask again', language)}
      </label>
      <div className="csv-import-modal__buttons">
        <button className="csv-import-modal__button" tabIndex={tab} onClick={onNo}>
          {t('No', language)}
        </button>
        <button
          ref={yesRef}
          tabIndex={tab}
          className="csv-import-modal__button csv-import-modal__button--yes"
          onClick={onYes}
        >
          {t('Yes', language)}
        </button>
      </div>
    </div>
  );
}
