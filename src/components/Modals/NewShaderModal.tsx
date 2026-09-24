import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import './CsvImportModal.css';

interface Props {
  open: boolean;
  /** Dismiss without touching the graph (Cancel / Escape / backdrop). */
  onCancel: () => void;
  /** Download the current shader. Resolves true only when a file was produced
   *  — a cancelled export pre-flight resolves false and nothing is claimed. */
  onExport: () => Promise<boolean>;
  /** Start the new shader. Never exports: that is the other button's job. */
  onStartNew: () => void;
}

/**
 * "Save this shader first?" — the canvas NEW button's confirmation.
 *
 * TWO ANSWERS IN ONE ROW, the model-drop dialog's shape: **Start NEW** and
 * **Export Current**, equal plates, with a red text Cancel below. They are not
 * alternatives, which is exactly why the old single "Export, then start new"
 * button was the wrong control: exporting and starting new are two things a
 * user may want in either order, and welding them together meant a cancelled
 * export pre-flight also abandoned NEW. Here Export Current downloads and
 * STAYS, turning into the word "Exported!", and Start NEW is then one more
 * press — or the only press, for someone who does not want a file.
 *
 * WHY each answer is safe rides the answer as a `title`, never a paragraph in
 * the panel: what the dialog says in the middle is the ONE thing the user has
 * to know before pressing anything — that NEW replaces what is on the canvas.
 * Clearing IS undoable (one history entry restores nodes, edges and board
 * ink), but undo lives in memory only and the localStorage auto-save is
 * overwritten the moment the graph changes, so a reload after NEW is
 * unrecoverable; that is what Export Current is for, and it is what its
 * tooltip says. NEW also removes the imported preview MODEL, and that part is
 * NOT undoable (the mesh is session-only, never in history) — so the middle
 * line ITSELF says so when a model is loaded, rather than hiding an
 * irreversible loss in a tooltip.
 *
 * While the export runs the dialog is INERT: Escape, the backdrop and the
 * buttons all stop answering. The export pre-flight is its own modal on top of
 * this one, and both swallow keys in the capture phase — without the gate one
 * Escape would answer both, cancelling the pre-flight and the NEW dialog
 * under it.
 */
export function NewShaderModal({ open, onCancel, onExport, onStartNew }: Props) {
  const language = useAppStore((s) => s.language);
  const hasModel = useAppStore((s) => s.previewMesh !== null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'ask' | 'exporting' | 'exported'>('ask');
  const busy = phase === 'exporting';

  // A fresh dialog always asks again: "Exported!" describes THIS document at
  // THIS moment, and the graph may have changed since it was last open.
  useEffect(() => { if (open) setPhase('ask'); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Busy gates only the ANSWER, never the swallow: a Delete or Cmd+Z
      // pressed while the bundle builds must still not reach the canvas.
      // `stopPropagation` leaves the pre-flight's own window listener running
      // (same target), so its Escape still works.
      if (busy) {
        if (e.key !== 'Tab') e.stopPropagation();
        return;
      }
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
  }, [open, onCancel, busy]);

  // Move focus into the dialog so it's announced and Escape/Tab land here
  // rather than back on the canvas behind it. The PANEL, not a button: neither
  // answer may be reachable by a reflex Enter — one throws the shader away.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const handleExport = () => {
    if (busy) return;
    setPhase('exporting');
    // Resolves false when the pre-flight was cancelled or the export produced
    // nothing: then the button comes BACK rather than claiming a file exists.
    void onExport().then(
      (ok) => setPhase(ok ? 'exported' : 'ask'),
      () => setPhase('ask'),
    );
  };

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={() => { if (!busy) onCancel(); }}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-shader-modal-title"
        aria-busy={busy || undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="new-shader-modal-title">
          {t('Save this shader first?', language)}
        </div>
        <div className="csv-import-modal__message">
          {t(
            hasModel
              ? 'Pressing New replaces the nodes, connections and drawings on the canvas with an empty Output node, and removes the imported 3D model.'
              : 'Pressing New replaces the nodes, connections and drawings on the canvas with an empty Output node.',
            language,
          )}
        </div>
        <div className="csv-import-modal__choices">
          <button
            className="csv-import-modal__button csv-import-modal__button--yes csv-import-modal__choice"
            title={t(
              hasModel
                ? 'Undo (Ctrl+Z / ⌘Z) brings the shader back while this tab stays open, but the browser auto-save is overwritten right away — and the imported 3D model does not come back at all.'
                : 'Undo (Ctrl+Z / ⌘Z) brings the shader back while this tab stays open, but the browser auto-save is overwritten right away, so a reload after this cannot recover it.',
              language,
            )}
            disabled={busy}
            onClick={onStartNew}
          >
            {t('Start NEW', language)}
          </button>
          {/* The answer that becomes a FACT. `aria-live` because the control
              the user just pressed is replaced by its own result, which a
              screen reader would otherwise never hear; the slot keeps the
              row's two equal halves either way. */}
          {phase === 'exported' ? (
            <div className="csv-import-modal__choice csv-import-modal__done" aria-live="polite">
              {t('Exported!', language)}
            </div>
          ) : (
            <button
              className="csv-import-modal__button csv-import-modal__button--yes csv-import-modal__choice"
              title={t(
                'Downloads the current shader with the whole project embedded — drag the file back into FastShaders to carry on where you left off.',
                language,
              )}
              disabled={busy}
              onClick={handleExport}
            >
              {t(busy ? 'Exporting…' : 'Export Current', language)}
            </button>
          )}
        </div>
        <button className="csv-import-modal__cancel" disabled={busy} onClick={onCancel}>
          {t('Cancel', language)}
        </button>
      </div>
    </div>,
    document.body,
  );
}
