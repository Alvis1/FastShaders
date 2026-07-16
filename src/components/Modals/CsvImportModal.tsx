import { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { MAX_COLUMNS } from '@/utils/csvParser';
import './CsvImportModal.css';

/**
 * Warning shown when a dropped CSV has more than COLUMN_WARN_THRESHOLD columns.
 * Reads the head of the store's `pendingCsvImports` queue (so multiple over-wide
 * drops surface one at a time) and offers: Cancel (skip), Continue as-is, or
 * Convert rows → columns (transpose). Backdrop click + Escape both cancel.
 */
export function CsvImportModal() {
  const head = useAppStore((s) => s.pendingCsvImports[0] ?? null);
  const resolve = useAppStore((s) => s.resolveCsvImport);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!head) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolve('cancel');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [head, resolve]);

  // Move focus into the dialog so keyboard users land on it and screen readers
  // announce it, rather than leaving focus behind on the canvas.
  useEffect(() => {
    if (head) panelRef.current?.focus();
  }, [head?.fileName]);

  if (!head) return null;

  // Transpose produces one column per original row, so it's only valid when the
  // row count stays within the hard column cap.
  const canTranspose = head.rowCount <= MAX_COLUMNS;

  return (
    <div className="csv-import-modal__backdrop" onClick={() => resolve('cancel')}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="csv-import-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="csv-import-modal-title">Import “{head.fileName}”</div>
        <div className="csv-import-modal__message">
          This CSV has <strong>{head.columnCount} columns</strong> and{' '}
          <strong>{head.rowCount} rows</strong>. A Data node exposes one output per column,
          so a wide table gets unwieldy — you can convert rows to columns instead.
        </div>
        <div className="csv-import-modal__buttons">
          <button className="csv-import-modal__button" onClick={() => resolve('cancel')}>
            Cancel
          </button>
          <button className="csv-import-modal__button" onClick={() => resolve('continue')}>
            Continue as-is
          </button>
          <button
            className="csv-import-modal__button csv-import-modal__button--primary"
            disabled={!canTranspose}
            title={
              canTranspose
                ? undefined
                : `Transposing would make ${head.rowCount} columns (max ${MAX_COLUMNS}).`
            }
            onClick={() => resolve('transpose')}
          >
            Convert rows → columns
          </button>
        </div>
      </div>
    </div>
  );
}
