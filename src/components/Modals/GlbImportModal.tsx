import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { glbDialogCopy } from '@/utils/glbImportCopy';
import type { GlbDialogPlan, GlbImportFacts } from '@/utils/glbImportGate';
import './CsvImportModal.css';
import './GlbImportModal.css';

export type GlbImportChoice = 'build' | 'model' | 'cancel' | 'restore';

interface Props {
  /** `facts` is null for a restore of a model the reader refused; `fileName` is sanitized. */
  request: { facts: GlbImportFacts | null; plan: GlbDialogPlan; fileName: string } | null;
  phase: 'ask' | 'building';
  progress: { done: number; total: number } | null;
  /** Where to portal: the preview's fullscreen element when it holds the
   *  anchor, else `document.body` (`pickPortalHost`). */
  portalHost: HTMLElement | null;
  onChoose: (c: GlbImportChoice) => void;
}

/**
 * "Build a shader from this model's materials?" — the model-drop REPLACE
 * gate (GLB Phase 5 Step 9). Three answers, in this order on screen: Cancel
 * (changes nothing; aborts a build in flight), Model only (today's model
 * drop, exactly), and the primary — Build, or "Import at {res} px" when the
 * textures would not fit the image budget at their slot sizes. There is
 * deliberately NO checkbox, no "don't ask again" and no localStorage here:
 * replacing a shader is never remembered.
 *
 * Focus starts on Model only (when it is enabled), so Enter keeps the
 * historical one-gesture outcome; it never starts on the primary. Escape is
 * Cancel; every other key but Tab is swallowed in the CAPTURE phase, the
 * NewShaderModal rule (the canvas binds its shortcuts on `window`). The
 * backdrop is Cancel only while asking — a click during a build is ignored —
 * and it swallows drag/drop so a file dropped on the dialog never navigates
 * the page. The words come from `glbDialogCopy`.
 *
 * GLB Phase 7: "Restore the stored shader" renders LAST when the plan offers
 * a restore (`plan.embeddedShader`), and then it — not Build — carries the
 * primary styling. It is a click-only gate: it replaces the whole project
 * with code that came out of someone's model file, so it is never the focused
 * default (Enter still means Model only) and no choice is ever remembered.
 */
export function GlbImportModal({ request, phase, progress, portalHost, onChoose }: Props) {
  const language = useAppStore((s) => s.language);
  const hasModel = useAppStore((s) => s.previewMesh !== null);
  const panelRef = useRef<HTMLDivElement>(null);
  const modelOnlyRef = useRef<HTMLButtonElement>(null);
  const open = request !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onChoose('cancel');
        return;
      }
      if (e.key !== 'Tab') e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onChoose]);

  // Initial focus: Model only when it can be pressed, else the panel — never
  // the primary, so Enter cannot replace the shader by reflex.
  useEffect(() => {
    if (!open) return;
    const btn = modelOnlyRef.current;
    if (btn && btn.getAttribute('aria-disabled') !== 'true') btn.focus();
    else panelRef.current?.focus();
  }, [open, portalHost]);

  if (!request) return null;
  const { facts, plan, fileName } = request;
  const copy = glbDialogCopy(plan, facts, { hasModel, phase, progress, fileName }, language);
  const building = phase === 'building';
  const modelOnlyBlocked = copy.modelOnlyDisabledReason !== null;

  return createPortal(
    <div
      className="csv-import-modal__backdrop"
      onClick={() => { if (!building) onChoose('cancel'); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div
        ref={panelRef}
        className="csv-import-modal__panel glb-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="glb-import-modal-title"
        aria-busy={building || undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="glb-import-modal-title">
          {copy.title}
        </div>
        {copy.lines.map((line, i) =>
          line.tone === 'heading' ? (
            <div key={i} className="glb-import-modal__subtitle">{line.text}</div>
          ) : (
            <div key={i} className={'csv-import-modal__message' + (line.tone === 'warn' ? ' glb-import-modal__warn' : '')}>
              {line.text}
            </div>
          ),
        )}
        {copy.progress && (
          <div className="glb-import-modal__progress" aria-live="polite">{copy.progress}</div>
        )}
        <div className="csv-import-modal__buttons">
          <button className="csv-import-modal__button" onClick={() => onChoose('cancel')}>
            {copy.cancelLabel}
          </button>
          <button
            ref={modelOnlyRef}
            className="csv-import-modal__button"
            // `aria-disabled`, never `disabled`, for the refused case: a truly
            // disabled control drops its native `title` in WebKit, and the
            // title is the only place the refusal is explained.
            aria-disabled={modelOnlyBlocked || undefined}
            title={copy.modelOnlyDisabledReason ?? undefined}
            disabled={building}
            onClick={() => { if (!modelOnlyBlocked) onChoose('model'); }}
          >
            {copy.modelOnlyLabel}
          </button>
          {copy.primaryLabel && (
            <button
              className={'csv-import-modal__button' + (copy.restoreLabel ? '' : ' csv-import-modal__button--primary')}
              disabled={building}
              onClick={() => onChoose('build')}
            >
              {copy.primaryLabel}
            </button>
          )}
          {copy.restoreLabel && (
            <button
              className="csv-import-modal__button csv-import-modal__button--primary"
              title={copy.restoreTitle ?? undefined}
              disabled={building}
              onClick={() => onChoose('restore')}
            >
              {copy.restoreLabel}
            </button>
          )}
        </div>
      </div>
    </div>,
    portalHost ?? document.body,
  );
}
