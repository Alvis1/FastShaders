import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { formatMiB } from '@/utils/formatSize';
import { fillTemplate } from '@/utils/fillTemplate';
import { GLB_EXPORT_KEYS, glbTooLargeCopy } from '@/utils/glbExportCopy';
import type { GlbExportUi, GlbTooLargeChoice, GlbTooLargeRequest } from '@/engine/exportShader';
import { preflightKeydown } from './ExportPreflightModal';
import './CsvImportModal.css';

/**
 * The single-GLB export's dialog (engine/exportShader.ts's
 * buildShaderExportChecked asks; utils/glbExportCopy.ts holds every sentence).
 * Four views, each raised only when it applies:
 *
 *  - **building** — shown only if the build is still running after 300 ms, so
 *    an ordinary export never flashes a dialog. Cancel aborts it.
 *  - **too-large** (N1-GLB) — the file would not open again in FastShaders:
 *    Cancel / Export anyway / Export WebP only (when dropping the PNG-JPEG
 *    copies fits) / Export as .zip instead (only when THAT bundle reopens).
 *  - **failed** — the build refused; Cancel / Export as .zip instead.
 *  - **ready** — the awaited encodes outlived the click's transient
 *    activation, so the Download button supplies a fresh one (Safari drops an
 *    anchor download without it). Its onClick resolves INSIDE the click task.
 *
 * ExportPreflightModal's rules verbatim: the resolver lives in a ref and is
 * never resolved inside a setState updater (StrictMode runs updaters twice), a
 * second ask cancels the first, unmount answers every pending promise, the
 * capture-phase keydown stops every key but Tab with Escape as Cancel, and
 * focus goes to the PANEL so a stray Enter cannot commit "Export anyway".
 *
 * No evalLog here: the GLB path is unreachable in a study session, and
 * evalHooks.test.ts's ALLOWED_FILES would fail on a new logging file.
 */

/** How long a build may run before it is worth a dialog. */
const BUILDING_DELAY_MS = 300;

type View =
  | { view: 'hidden' }
  | { view: 'building'; fileName: string; ktx2?: { done: number; total: number } }
  | { view: 'too-large'; request: GlbTooLargeRequest }
  | { view: 'failed'; message: string; canBundle: boolean }
  | { view: 'ready'; fileName: string; sizeBytes: number };

const HIDDEN: View = { view: 'hidden' };

interface Props {
  state: View;
  onAnswer: (answer: GlbTooLargeChoice | boolean) => void;
  onCancelBuild: () => void;
}

export function GlbExportModal({ state, onAnswer, onCancelBuild }: Props) {
  const language = useAppStore((s) => s.language);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = state.view !== 'hidden';
  // ONE cancel for the three ways out (Escape, the backdrop, the button): on
  // the building view it must also ABORT the build, or the dialog would go
  // away while the encodes ran on and asked again.
  const building = state.view === 'building';
  const cancel = useCallback(() => {
    if (building) onCancelBuild();
    onAnswer('cancel');
  }, [building, onAnswer, onCancelBuild]);

  useEffect(() => {
    if (!open) return;
    // CAPTURE phase, so this runs before the canvas hears the key.
    const onKey = (e: KeyboardEvent) => preflightKeydown(e, cancel);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, cancel]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open, state.view]);

  if (state.view === 'hidden') return null;

  const tooLarge = state.view === 'too-large' ? glbTooLargeCopy(state.request, language) : null;
  const title =
    state.view === 'building'
      ? fillTemplate(t(GLB_EXPORT_KEYS.building, language), { file: state.fileName })
      : state.view === 'ready'
        ? fillTemplate(t(GLB_EXPORT_KEYS.readyTitle, language), { file: state.fileName })
        : state.view === 'too-large'
          ? tooLarge!.title
          : fillTemplate(t(GLB_EXPORT_KEYS.failed, language), { reason: state.message });
  const message =
    // While the KTX2 encodes run they are what the wait IS, so the building
    // view says so; without an encoder nothing reports and it stays silent.
    state.view === 'building' && state.ktx2
      ? fillTemplate(t(GLB_EXPORT_KEYS.ktx2Progress, language), { done: state.ktx2.done, total: state.ktx2.total })
      : state.view === 'too-large'
        ? tooLarge!.message
        : state.view === 'ready'
          ? fillTemplate(t(GLB_EXPORT_KEYS.readyMessage, language), {
              size: formatMiB(state.sizeBytes, language),
            })
          : null;

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={cancel}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="glb-export-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="glb-export-modal-title">
          {title}
        </div>
        {message && <div className="csv-import-modal__message">{message}</div>}
        {state.view === 'too-large' && tooLarge!.webpOnlyHint && (
          <div className="csv-import-modal__message">{tooLarge!.webpOnlyHint}</div>
        )}
        <div className="csv-import-modal__buttons">
          <button className="csv-import-modal__button" onClick={cancel}>
            {t('Cancel', language)}
          </button>
          {state.view === 'too-large' && (
            <button className="csv-import-modal__button" onClick={() => onAnswer('full')}>
              {t('Export anyway', language)}
            </button>
          )}
          {state.view === 'too-large' && tooLarge!.webpOnlyLabel && (
            <button className="csv-import-modal__button" onClick={() => onAnswer('webp-only')}>
              {tooLarge!.webpOnlyLabel}
            </button>
          )}
          {/* Offered only when dropping the KTX2 copies alone brings the file
              within the limit; invisible in every build with no encoder. */}
          {state.view === 'too-large' && tooLarge!.noKtx2Label && (
            <button className="csv-import-modal__button" onClick={() => onAnswer('no-ktx2')}>
              {tooLarge!.noKtx2Label}
            </button>
          )}
          {((state.view === 'too-large' && state.request.asBundle !== null) ||
            (state.view === 'failed' && state.canBundle)) && (
            <button
              className="csv-import-modal__button csv-import-modal__button--primary"
              onClick={() => onAnswer('as-bundle')}
            >
              {t(GLB_EXPORT_KEYS.asBundle, language)}
            </button>
          )}
          {state.view === 'ready' && (
            <button
              className="csv-import-modal__button csv-import-modal__button--primary"
              onClick={() => onAnswer(true)}
            >
              {t('Download', language)}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The per-surface host: each export surface mounts one `modal` and hands `ui`
 * to buildShaderExportChecked (through `useExportPreflight`, which composes
 * both dialogs). Every ask resolves exactly once.
 */
export function useGlbExportUi(): { ui: GlbExportUi; modal: ReactElement } {
  const [state, setState] = useState<View>(HIDDEN);
  // The pending ask: how to answer it, and what "cancel" means for it —
  // 'cancel' for the two dialogs, false for the ready step.
  const pendingRef = useRef<{ resolve: (v: never) => void; cancel: GlbTooLargeChoice | boolean } | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const cancelBuildRef = useRef<(() => void) | null>(null);

  const settle = useCallback((answer: GlbTooLargeChoice | boolean) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    (p?.resolve as ((v: GlbTooLargeChoice | boolean) => void) | undefined)?.(answer);
  }, []);

  /** Cancel whatever is open and stop the building timer. */
  const reset = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const p = pendingRef.current;
    if (p) settle(p.cancel);
  }, [settle]);

  const ask = useCallback(
    <T extends GlbTooLargeChoice | boolean>(next: View, cancel: T): Promise<T> =>
      new Promise<T>((resolve) => {
        reset();
        pendingRef.current = { resolve: resolve as (v: never) => void, cancel };
        setState(next);
      }),
    [reset],
  );

  const ui = useMemo<GlbExportUi>(
    () => ({
      begin(fileName, cancel) {
        reset();
        cancelBuildRef.current = cancel;
        timerRef.current = window.setTimeout(
          () => setState({ view: 'building', fileName }),
          BUILDING_DELAY_MS,
        );
      },
      progress(done, total) {
        // Only while the building view is up: a report that arrives before the
        // 300 ms timer must not open the dialog early.
        setState((v) => (v.view === 'building' ? { ...v, ktx2: { done, total } } : v));
      },
      failed: (message, canBundle) => ask({ view: 'failed', message, canBundle }, 'cancel'),
      tooLarge: (request) => ask({ view: 'too-large', request }, 'cancel'),
      ready: (fileName, sizeBytes) => ask({ view: 'ready', fileName, sizeBytes }, false),
      end() {
        reset();
        cancelBuildRef.current = null;
        setState(HIDDEN);
      },
    }),
    [ask, reset],
  );

  const onAnswer = useCallback(
    (answer: GlbTooLargeChoice | boolean) => {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      setState(HIDDEN);
      // The ONE `cancel` handler (Escape, the backdrop, the button) answers the
      // STRING 'cancel' whatever the view, but `ready` is a Promise<boolean>
      // whose cancel value is `false` — and a string is TRUTHY, so resolving it
      // verbatim passed exportShader's `!(await asks.glb.ready(…))` and
      // downloaded the file the user had just declined. Map a 'cancel' answer
      // onto the PENDING ask's own cancel value: identity for the two dialogs,
      // `false` here, and right by construction for any later boolean view.
      // Read before `settle`, which clears the ref.
      const pending = pendingRef.current;
      settle(answer === 'cancel' && pending ? pending.cancel : answer);
    },
    [settle],
  );

  // Unmount: never leave the caller awaiting forever (WorkFolder holds `busy`
  // across the await), and stop a timer that would paint into a dead tree.
  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      const p = pendingRef.current;
      pendingRef.current = null;
      (p?.resolve as ((v: GlbTooLargeChoice | boolean) => void) | undefined)?.(p?.cancel ?? 'cancel');
    },
    [],
  );

  return {
    ui,
    modal: (
      <GlbExportModal
        state={state}
        onAnswer={onAnswer}
        onCancelBuild={() => cancelBuildRef.current?.()}
      />
    ),
  };
}
