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
 * The dropped-model dialog: the model's FILE NAME, what it holds (textures
 * and their memory, materials), then ONE question — "Import" — with two equal
 * answers and a red Cancel below (the owner's layout, 2026-09-19).
 *
 *   · Only Mesh — the model alone; its materials and textures are discarded.
 *     The caller's own model drop over bytes it has already read, so this
 *     branch writes nothing and fires nothing.
 *   · Mesh with Materials — the model's materials REPLACE the graph (the
 *     nodes, wires and board drawings) and the shader takes the model's name;
 *     palettes and tuned values stay (engine/projectImport.ts'
 *     `commitGlbImport`, the ONE commit path).
 *
 * There are TWO buttons whatever the plan says. The texture-budget case folds
 * its reduced resolution INTO the second label ("Mesh with Materials
 * (1024 px)") rather than standing as a third answer — a dialog that grows a
 * button in the one case the user is least equipped to judge is the wrong
 * shape. The only third button is "Restore the stored shader", which is not
 * an import at all: it replaces the whole project with code that came out of
 * someone else's model file, so it keeps its own row and its own wording.
 * There is deliberately NO checkbox, no "don't ask again" and no localStorage:
 * rewiring a shader is never remembered.
 *
 * WHAT each answer DOES is a `title` on the answer itself, never a paragraph
 * in the panel: the body keeps only WARNINGS (`copy.lines` is filtered to
 * them) — the things about THIS model that change what an answer will do.
 * The refusal reason still outranks the Only Mesh tooltip when it cannot be
 * pressed.
 *
 * Focus starts on Only Mesh (when it can be pressed), so Enter still means the
 * answer that cannot surprise; it never starts on the build. Escape is Cancel;
 * every other key but Tab is swallowed in the CAPTURE phase, the
 * NewShaderModal rule (the canvas binds its shortcuts on `window`). The
 * backdrop is Cancel only while asking — a click during a build is ignored —
 * and it swallows drag/drop so a file dropped on the dialog never navigates
 * the page. The words come from `glbDialogCopy`; nothing here branches on the
 * plan.
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
        aria-describedby="glb-import-modal-facts"
        aria-busy={building || undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title glb-import-modal__name" id="glb-import-modal-title">
          {copy.title}
        </div>
        {copy.facts.length > 0 && (
          <div className="glb-import-modal__facts" id="glb-import-modal-facts">
            {copy.facts.map((line, i) => (
              <div key={i} className="csv-import-modal__message">{line}</div>
            ))}
          </div>
        )}
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
        <div className="glb-import-modal__heading">{copy.importHeading}</div>
        {/* DOM order IS visual order: the two answers, then the restore when
            it is offered, then Cancel. Tab therefore walks the dialog the way
            it reads, and Cancel — the one that changes nothing — is last
            rather than first. */}
        <div className="csv-import-modal__choices">
          <button
            ref={modelOnlyRef}
            className="csv-import-modal__button csv-import-modal__button--yes csv-import-modal__choice"
            // `aria-disabled`, never `disabled`, for the refused case: a truly
            // disabled control drops its native `title` in WebKit, and the
            // title is the only place the refusal is explained.
            aria-disabled={modelOnlyBlocked || undefined}
            title={copy.modelOnlyTitle}
            disabled={building}
            onClick={() => { if (!modelOnlyBlocked) onChoose('model'); }}
          >
            {copy.modelOnlyLabel}
          </button>
          {copy.primaryLabel && (
            <button
              className="csv-import-modal__button csv-import-modal__button--yes csv-import-modal__choice"
              title={copy.primaryTitle}
              disabled={building}
              onClick={() => onChoose('build')}
            >
              {copy.primaryLabel}
            </button>
          )}
        </div>
        {copy.restoreLabel && (
          <div className="csv-import-modal__choices">
            <button
              className="csv-import-modal__button csv-import-modal__button--primary csv-import-modal__choice"
              title={copy.restoreTitle ?? undefined}
              disabled={building}
              onClick={() => onChoose('restore')}
            >
              {copy.restoreLabel}
            </button>
          </div>
        )}
        <button className="csv-import-modal__cancel" disabled={building} onClick={() => onChoose('cancel')}>
          {copy.cancelLabel}
        </button>
      </div>
    </div>,
    portalHost ?? document.body,
  );
}
