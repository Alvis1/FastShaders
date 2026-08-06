import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import './CsvImportModal.css';

interface Props {
  open: boolean;
  /** Dismiss without touching the graph (Cancel / Escape / backdrop). */
  onCancel: () => void;
  /** Start the new shader. `save` first downloads the current one. */
  onConfirm: (save: boolean) => void;
}

/**
 * "Start a new shader?" confirmation for the canvas NEW button.
 *
 * Clearing IS undoable (one history entry restores nodes, edges and board
 * ink), but undo lives in memory only — the localStorage auto-save is
 * overwritten the moment the graph changes, so a reload after NEW is
 * unrecoverable. That is what the save offer is for: "Export first" runs the
 * same Download Shader path as the toolbar button, whose `.js`/`.zip` embeds
 * the whole project and can be dragged back in.
 */
export function NewShaderModal({ open, onCancel, onConfirm }: Props) {
  const language = useAppStore((s) => s.language);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      // Everything else is swallowed while the dialog is up. The canvas binds
      // its shortcuts on `window` (Delete, Ctrl+G, Shift+A, Cmd+Z…) and skips
      // only INPUT/TEXTAREA targets — focus here is a DIV, so without this a
      // keypress meant for the dialog would edit the graph behind it. CAPTURE
      // phase: a window capture listener runs before the canvas's bubble one.
      if (e.key !== 'Tab') e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  // Move focus into the dialog so it's announced and Escape/Tab land here
  // rather than back on the canvas behind it.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={onCancel}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-shader-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="new-shader-modal-title">
          {t('Save this shader first?', language)}
        </div>
        <div className="csv-import-modal__message">
          {t('Starting a new shader replaces the current nodes, connections and board drawings with an empty Output node. Undo (Ctrl+Z / ⌘Z) brings them back while this tab stays open — but the browser auto-save is overwritten right away, so export now if you want a file to come back to.', language)}
        </div>
        <div className="csv-import-modal__buttons">
          <button className="csv-import-modal__button" onClick={onCancel}>
            {t('Cancel', language)}
          </button>
          <button className="csv-import-modal__button" onClick={() => onConfirm(false)}>
            {t('Don’t save', language)}
          </button>
          <button
            className="csv-import-modal__button csv-import-modal__button--primary"
            onClick={() => onConfirm(true)}
          >
            {t('Export, then start new', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
