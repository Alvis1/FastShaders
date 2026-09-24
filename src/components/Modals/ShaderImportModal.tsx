/**
 * The dropped-shader dialog: a `.js` / `.mjs` / `.tsl` / `.zip` landed on the
 * canvas, the 3D preview or the code panel, and it has TWO answers.
 *
 *   · OPEN — what a drop has always done: this file BECOMES the document. The
 *     graph on the canvas goes, and the shader takes the file's name (or the
 *     one authored inside it — `utils/shaderDropName.ts`).
 *   · ADD — the document stays. The dropped shader's chain is parked beside it
 *     in one group frame named after the file, wired to nothing
 *     (`engine/shaderGroupImport.ts`).
 *
 * WHY A DIALOG AT ALL. Dropping a file used to replace the whole project with
 * no warning — the single most destructive thing a drag can do in this app,
 * reachable by accident, and undoable only if you notice in time. The second
 * answer is what makes the question worth asking rather than a speed bump:
 * "open someone else's shader beside mine and take a piece of it" is the
 * thing people were doing by hand, with two windows and the clipboard.
 *
 * The SHAPE is the model-drop dialog's (GlbImportModal): the file name, then
 * one warning line when there is work to lose, then a heading over two EQUAL
 * plates with a red text Cancel below. Two equal plates because neither answer
 * is the recommended one — that depends entirely on what the user meant.
 *
 * WHAT each answer DOES is a `title` on the answer itself, never a paragraph
 * in the panel; the body carries only the WARNING, the thing about THIS canvas
 * that changes what Open will cost.
 *
 * Focus starts on ADD, so Enter is the answer that cannot throw work away.
 * Escape is Cancel, and every other key but Tab is swallowed in the CAPTURE
 * phase (the canvas binds its shortcuts on `window`, the NewShaderModal rule).
 * The backdrop is Cancel only while idle — a click during an import is
 * ignored — and it swallows drag/drop so a second file dropped on the dialog
 * never navigates the page.
 *
 * ONE dialog serves all three surfaces through the store queue
 * (`pendingShaderImports`), which is also what makes "a drop while the dialog
 * is open" a question the surfaces can answer consistently.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import {
  addDroppedShader,
  openDroppedShader,
  reportZipImportError,
} from '@/engine/projectImport';
import './CsvImportModal.css';
import './ShaderImportModal.css';

function fullscreenHost(): HTMLElement {
  const d = document as Document & { webkitFullscreenElement?: Element | null };
  const el = document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  // The fullscreen top layer renders only that element's subtree, so a body
  // portal would be invisible over a fullscreened preview — the colour
  // picker's rule. This dialog is app-wide and has no anchor to test against,
  // so whatever is fullscreen is where it belongs.
  return el instanceof HTMLElement ? el : document.body;
}

export function ShaderImportModal() {
  const head = useAppStore((s) => s.pendingShaderImports[0] ?? null);
  const dequeue = useAppStore((s) => s.dequeueShaderImport);
  const language = useAppStore((s) => s.language);
  // A fresh document is ONE bare Output node; anything more is work the user
  // would lose to Open, and the only thing worth a line in the panel.
  // This component is mounted for the life of the app and the selector runs on
  // EVERY store notify (a drag or a scrub is one per frame), so it counts only
  // while a drop is pending, and without allocating.
  const liveNodes = useAppStore((s) => {
    if (s.pendingShaderImports.length === 0) return 0;
    let count = 0;
    for (const n of s.nodes) if (n.type !== 'group' && n.type !== 'note') count++;
    return count;
  });
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  const close = useCallback(() => {
    if (!head) return;
    dequeue(head.id);
    setBusy(false);
    // The surface that raised this drop learns there was no answer, so the
    // rest of what was dropped with it (a paired 3D model) is dropped too.
    head.onResolved?.('cancelled');
  }, [head, dequeue]);

  // The portal host follows fullscreen for as long as the dialog is up.
  useEffect(() => {
    if (!head) return;
    const resolve = () => setHost(fullscreenHost());
    resolve();
    document.addEventListener('fullscreenchange', resolve);
    document.addEventListener('webkitfullscreenchange', resolve);
    return () => {
      document.removeEventListener('fullscreenchange', resolve);
      document.removeEventListener('webkitfullscreenchange', resolve);
    };
  }, [head]);

  useEffect(() => {
    if (!head) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!busy) close();
        return;
      }
      if (e.key !== 'Tab') e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [head, busy, close]);

  // Initial focus: ADD — never Open, so Enter cannot replace the document by
  // reflex. Keyed on the queued id, so a second drop re-focuses.
  useEffect(() => {
    if (!head) return;
    if (addRef.current) addRef.current.focus();
    else panelRef.current?.focus();
  }, [head?.id, host]);

  const answer = useCallback(
    (choice: 'open' | 'add') => {
      const item = head;
      if (!item || busy) return;
      setBusy(true);
      // What the raising surface is told when this settles. Only a clean
      // import is 'imported' — every alert below is a failure, and the drop's
      // companions must not be announced as if the shader had loaded.
      let outcome: 'imported' | 'failed' = 'imported';
      void (async () => {
        try {
          if (choice === 'open') {
            const imported = await openDroppedShader(item.file);
            if (imported === null) {
              outcome = 'failed';
              window.alert(
                fillTemplate(
                  t('{name} does not contain a shader script (.js / .mjs / .tsl).', language),
                  { name: '“' + item.fileName + '”' },
                ),
              );
            }
          } else {
            const r = await addDroppedShader(item.file);
            if (r.ok) {
              useAppStore.getState().showImportNote([
                { kind: 'shader-added', name: r.groupLabel, nodes: r.added, droppedSinks: r.droppedSinks },
              ]);
            } else {
              outcome = 'failed';
            }
            if (!r.ok && r.reason === 'no-shader') {
              window.alert(
                fillTemplate(
                  t('{name} does not contain a shader script (.js / .mjs / .tsl).', language),
                  { name: '“' + item.fileName + '”' },
                ),
              );
            } else if (!r.ok && r.reason === 'nothing-to-add') {
              window.alert(
                fillTemplate(t('{name} has nothing to add — it is only an Output.', language), {
                  name: '“' + item.fileName + '”',
                }),
              );
            } else if (!r.ok && r.reason === 'parse-failed') {
              window.alert(
                fillTemplate(t('{name} could not be read as a node graph. Open it instead.', language), {
                  name: '“' + item.fileName + '”',
                }),
              );
            }
            // 'over-budget' raised its own LimitModal, which owns the retry.
          }
        } catch (e) {
          outcome = 'failed';
          // A zip the reader refused says why (the ONE shared mapping, every
          // surface); anything else keeps the engine's own English message,
          // framed. An import that crashes must surface — imported files are
          // adversarial input and a silent no-op reads as the drop being lost.
          if (!reportZipImportError(e, item.fileName)) {
            window.alert(
              fillTemplate(t('Could not import {name}: {reason}', language), {
                name: '“' + item.fileName + '”',
                reason: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        } finally {
          setBusy(false);
          useAppStore.getState().dequeueShaderImport(item.id);
          item.onResolved?.(outcome);
        }
      })();
    },
    [head, busy, language],
  );

  if (!head) return null;

  return createPortal(
    <div
      className="csv-import-modal__backdrop"
      onClick={() => { if (!busy) close(); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div
        ref={panelRef}
        className="csv-import-modal__panel shader-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shader-import-modal-title"
        aria-busy={busy || undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title shader-import-modal__name" id="shader-import-modal-title">
          {head.fileName}
        </div>
        {liveNodes > 1 && (
          <div className="csv-import-modal__message">
            {fillTemplate(
              t('Open replaces the {n} nodes on the canvas. Add keeps them.', language),
              { n: liveNodes },
            )}
          </div>
        )}
        <div className="shader-import-modal__heading">{t('Import', language)}</div>
        {/* DOM order IS visual order, and Cancel — the one that changes
            nothing — is last rather than first. */}
        <div className="csv-import-modal__choices">
          <button
            ref={addRef}
            className="csv-import-modal__button csv-import-modal__button--yes csv-import-modal__choice"
            title={t('Keeps your shader and parks this one beside it, in a group named after the file. Its Output is left out, so it drives nothing until you wire it in.', language)}
            disabled={busy}
            onClick={() => answer('add')}
          >
            {t('Add', language)}
          </button>
          <button
            className="csv-import-modal__button csv-import-modal__button--yes csv-import-modal__choice"
            title={t('This file becomes the shader: the graph on the canvas is replaced, and the document takes the file’s name.', language)}
            disabled={busy}
            onClick={() => answer('open')}
          >
            {t('Open', language)}
          </button>
        </div>
        <button className="csv-import-modal__cancel" disabled={busy} onClick={close}>
          {t('Cancel', language)}
        </button>
      </div>
    </div>,
    host ?? document.body,
  );
}
