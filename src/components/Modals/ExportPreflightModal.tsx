import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { formatMiB } from '@/utils/formatSize';
import { fillTemplate } from '@/utils/fillTemplate';
import type { ExportPreflightChoice, ExportTooLarge } from '@/utils/exportPreflight';
import type { AskExportPreflight } from '@/engine/exportShader';
import type { GlbExportUi } from '@/engine/exportShader';
import { exportLiftedByDesktop } from '@/utils/desktopAppNoteRules';
import { DesktopAppNote } from './DesktopAppNote';
import { useGlbExportUi } from './GlbExportModal';
import './CsvImportModal.css';

interface Props {
  /** The pre-flight's finding, or null while no export is waiting on an answer. */
  request: ExportTooLarge | null;
  onResolve: (choice: ExportPreflightChoice) => void;
}

/**
 * N1, "This export is too large to open again": the export pre-flight's dialog
 * (utils/exportPreflight.ts decides, engine/exportShader.ts's
 * buildShaderBundleChecked asks). Raised only when the bundle would unpack
 * past zipReader's size cap or hold more entries than its MAX_ENTRIES, i.e. a
 * file neither the editor nor Podest could load back. The message names the cap
 * that was crossed (MB for the size, files for the count, both when both are).
 *
 * "Export anyway" is a plain button, not --danger: it discards nothing, and
 * CsvImportModal.css reserves --danger for that. "Export without the 3D model"
 * is offered only when dropping the model brings the bundle under the cap, and
 * answers THIS export alone — the session `exportIncludeMesh` flag is never
 * written, so the next over-cap export asks again.
 *
 * Deliberately no evalLog here: the pre-flight is skipped in a study session,
 * and evalHooks.test.ts's ALLOWED_FILES would fail on a new logging file.
 */
/**
 * The dialog's window-capture keydown rule (exported for the node test). The
 * dialog is modal, so every key but Tab is STOPPED — the canvas binds its
 * shortcuts on `window` and skips only INPUT/TEXTAREA targets (the
 * NewShaderModal precedent) — and Escape, which also answers Cancel, is no
 * exception: left to propagate, it reached useDismiss's document listener and
 * closed the Work-folder popover that save()'s cancel branch had just opened to
 * say "Save cancelled — nothing was written.", so the message never showed.
 */
export function preflightKeydown(
  e: Pick<KeyboardEvent, 'key' | 'stopPropagation'>,
  onResolve: (choice: ExportPreflightChoice) => void,
): void {
  if (e.key === 'Tab') return;
  e.stopPropagation();
  if (e.key === 'Escape') onResolve('cancel');
}

export function ExportPreflightModal({ request, onResolve }: Props) {
  const language = useAppStore((s) => s.language);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = request !== null;

  useEffect(() => {
    if (!open) return;
    // CAPTURE phase, so this runs before anything else hears the key.
    const onKey = (e: KeyboardEvent) => preflightKeydown(e, onResolve);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onResolve]);

  // Focus the PANEL, never a button, so a stray Enter cannot commit
  // "Export anyway".
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!request) return null;
  const withoutModel = request.withoutModel;

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={() => onResolve('cancel')}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-preflight-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="export-preflight-modal-title">
          {t('This export is too large to open again', language)}
        </div>
        <div className="csv-import-modal__message">
          {request.overSize
            ? fillTemplate(
                t('The export would unpack to {size} MB. FastShaders opens files up to {limit} MB, so neither the editor nor Podest could load it back. The shader inside would still run on an A-Frame page.', language),
                { size: formatMiB(request.sizeBytes, language), limit: formatMiB(request.limitBytes, language) },
              )
            : fillTemplate(
                t('The export would hold {count} files. FastShaders opens at most {max} files from one archive, so neither the editor nor Podest could load it back. The shader inside would still run on an A-Frame page.', language),
                { count: request.entryCount, max: request.entryLimit },
              )}
          {request.overSize && request.overEntries && (
            <>
              {' '}
              {fillTemplate(
                t('It would also hold {count} files; FastShaders opens at most {max} from one archive.', language),
                { count: request.entryCount, max: request.entryLimit },
              )}
            </>
          )}
        </div>
        {exportLiftedByDesktop(request) && <DesktopAppNote language={language} />}
        <div className="csv-import-modal__buttons">
          <button className="csv-import-modal__button" onClick={() => onResolve('cancel')}>
            {t('Cancel', language)}
          </button>
          <button className="csv-import-modal__button" onClick={() => onResolve('full')}>
            {t('Export anyway', language)}
          </button>
          {withoutModel && (
            <button
              className="csv-import-modal__button csv-import-modal__button--primary"
              onClick={() => onResolve('without-model')}
            >
              {t('Export without the 3D model ({model} MB)', language).replace(
                '{model}',
                () => formatMiB(withoutModel.modelBytes, language),
              )}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The per-surface host: each export surface (Toolbar, NodeEditor's NEW,
 * WorkFolder) mounts its own `modal` and hands `ask` + `glb` to
 * buildShaderExportChecked. Resolves through a ref and never inside a setState
 * updater (StrictMode runs updaters twice).
 *
 * ONE `modal` covers BOTH dialogs — N1 here and the single-GLB export's
 * (GlbExportModal) — so a surface mounts one element and cannot end up with an
 * export path whose dialog was never rendered.
 */
export function useExportPreflight(): { ask: AskExportPreflight; glb: GlbExportUi; modal: ReactElement } {
  const resolverRef = useRef<((choice: ExportPreflightChoice) => void) | null>(null);
  const [request, setRequest] = useState<ExportTooLarge | null>(null);

  const ask = useCallback<AskExportPreflight>(
    (req) =>
      new Promise<ExportPreflightChoice>((resolve) => {
        // A second ask while one is open cancels the first rather than
        // stranding its caller.
        resolverRef.current?.('cancel');
        resolverRef.current = resolve;
        setRequest(req);
      }),
    [],
  );

  const onResolve = useCallback((choice: ExportPreflightChoice) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolve?.(choice);
  }, []);

  // Unmount: never leave a caller awaiting forever (WorkFolder holds `busy`
  // across the await).
  useEffect(
    () => () => {
      resolverRef.current?.('cancel');
      resolverRef.current = null;
    },
    [],
  );

  const { ui: glb, modal: glbModal } = useGlbExportUi();

  return {
    ask,
    glb,
    modal: (
      <>
        <ExportPreflightModal request={request} onResolve={onResolve} />
        {glbModal}
      </>
    ),
  };
}
