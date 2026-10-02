import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { useModalKeys } from './useModalKeys';
import './CsvImportModal.css';
import './GlbImportModal.css';

export type SplatGraphChoice = 'clear' | 'keep' | 'cancel';

interface Props {
  /** The dropped splat's SANITIZED file name, or null when no dialog is up. */
  fileName: string | null;
  /** The preview's fullscreen element when it holds the anchor, else `document.body`. */
  portalHost: HTMLElement | null;
  onChoose: (c: SplatGraphChoice) => void;
}

/**
 * The dropped-splat question (owner, 2026-10-01): a Gaussian splat landed and
 * the graph has no Splat Output, so nothing on the canvas can shade it —
 * clear the node graph? (`utils/splatGraphStart.ts` decides when to ask.)
 *
 *   · Keep graph — the splat loads and the graph stays as it is.
 *   · Clear graph — the graph becomes ONE Splat Output, then the splat loads
 *     (`startSplatGraph`, engine/projectImport.ts: one undo entry, the
 *     document kept).
 *   · Cancel — nothing loads.
 *
 * The SHAPE is the other drop dialogs' (GlbImportModal, ShaderImportModal):
 * the file name, one line saying why it asks, a heading over two equal
 * plates, a red text Cancel below; what each answer DOES is its `title`.
 * Focus starts on Keep, so Enter is the answer that cannot throw work away.
 * Escape is Cancel, and every other key but Tab is swallowed in the CAPTURE
 * phase (the canvas binds its shortcuts on `window`). The backdrop is Cancel
 * and swallows drag/drop, so a file dropped on it never navigates the page.
 * No "don't ask again": rewiring a shader is never remembered.
 */
export function SplatGraphModal({ fileName, portalHost, onChoose }: Props) {
  const language = useAppStore((s) => s.language);
  const panelRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const open = fileName !== null;

  useModalKeys(open, (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onChoose('cancel');
      return;
    }
    if (e.key !== 'Tab') e.stopPropagation();
  }, true);

  useEffect(() => {
    if (!open) return;
    if (keepRef.current) keepRef.current.focus();
    else panelRef.current?.focus();
  }, [open, portalHost]);

  if (fileName === null) return null;

  return createPortal(
    <div
      className="csv-import-modal__backdrop"
      onClick={() => onChoose('cancel')}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div
        ref={panelRef}
        className="csv-import-modal__panel glb-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="splat-graph-modal-title"
        aria-describedby="splat-graph-modal-why"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title csv-import-modal__file" id="splat-graph-modal-title">
          {fileName}
        </div>
        <div className="csv-import-modal__message" id="splat-graph-modal-why">
          {t('The graph has no Splat Output, so its nodes cannot shade this Gaussian splat.', language)}
        </div>
        <div className="csv-import-modal__heading">{t('Clear the node graph?', language)}</div>
        {/* DOM order IS visual order, and Cancel — the one that changes
            nothing — is last rather than first. */}
        <div className="csv-import-modal__choices">
          <button
            ref={keepRef}
            className="csv-import-modal__button csv-import-modal__button--yes csv-import-modal__choice"
            title={t('Loads the splat and leaves the graph as it is.', language)}
            onClick={() => onChoose('keep')}
          >
            {t('Keep graph', language)}
          </button>
          <button
            className="csv-import-modal__button csv-import-modal__button--yes csv-import-modal__choice"
            title={t('Replaces the nodes, connections and drawings on the canvas with one Splat Output, ready to wire, and loads the splat. Your palettes and tuned values stay. Undo (Ctrl+Z / ⌘Z) brings the graph back.', language)}
            onClick={() => onChoose('clear')}
          >
            {t('Clear graph', language)}
          </button>
        </div>
        <button className="csv-import-modal__cancel" onClick={() => onChoose('cancel')}>
          {t('Cancel', language)}
        </button>
      </div>
    </div>,
    portalHost ?? document.body,
  );
}
