/**
 * Opens "Generate nodes from text" (src/llm/GeneratorDialog.tsx) when the
 * store holds a request (`generatorRequest`, written by `openGenerator`): the
 * asset bar's search, the Space menu's last row, or the Settings list's "Open
 * the generator…". This, the leaf flag (utils/generatorFlag.ts), the prompt
 * detector (utils/promptDetect.ts) and the offer hook are the generator's
 * ONLY boot-path pieces: everything else is src/llm/, loaded through `lazyOr`
 * when the dialog first opens, so a visitor who never opens it never
 * downloads it (bootWave.test.ts).
 *
 * It renders nothing unless the build can reach a model, the feature is not
 * switched off, and this is neither a study session nor the embed — every
 * entry checks the same (`useGeneratorOffer`), and the dialog's own run and
 * Add refuse in a study again (docs/dev/node-generator.md).
 */
import { Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { isEvalMode } from '@/eval/evalArm';
import { isEmbedMode } from '@/embed/embedMode';
import { t } from '@/i18n';
import { lazyOr } from '@/utils/lazyOr';
import { useModalKeys } from '@/components/Modals/useModalKeys';
import { generatorBuild, generatorOffered } from '@/utils/generatorFlag';
// The shared dialog chrome, for the fallback below (the dialog imports it too).
import '@/components/Modals/CsvImportModal.css';

interface DialogProps {
  /** The request to start from: a search box's query, or '' from Settings. */
  initialPrompt: string;
  /** Where on the canvas it was asked (flow coords): an unwired group lands there. */
  at?: { x: number; y: number };
  /** Start generating as soon as the route is ready (Ctrl/Cmd+Enter). */
  autostart?: boolean;
  /** A picture pasted or dropped on a search box. */
  initialPicture?: File;
  onClose: () => void;
}

/** What shows when the dialog's chunk cannot be fetched (a dropped connection,
 *  or a redeploy swapping the hashed assets) — the app has no error boundary.
 *  `lazyOr` keeps this fallback for the page's life, so only a reload helps.
 *  Modal like the dialog it stands in for: every key but Tab is swallowed
 *  before the canvas's window shortcuts (Delete would act behind it). */
function GeneratorUnavailable({ onClose }: DialogProps) {
  const language = useAppStore((s) => s.language);
  useModalKeys(true, (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') e.stopPropagation();
  }, true);
  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={onClose}>
      <div className="csv-import-modal__panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="csv-import-modal__message">
          {t('The generator could not be loaded. Reload the page and try again.', language)}
        </div>
        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" onClick={onClose}>{t('Close', language)}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const GeneratorDialog = lazyOr<DialogProps>(
  () => import('@/llm/GeneratorDialog').then((m) => m.GeneratorDialog),
  GeneratorUnavailable,
);

export function GeneratorLauncher() {
  const mode = useAppStore((s) => s.nodeGenerator);
  const request = useAppStore((s) => s.generatorRequest);
  const closeGenerator = useAppStore((s) => s.closeGenerator);
  if (!request || isEmbedMode() || !generatorOffered(mode, isEvalMode(), generatorBuild(__FS_DESKTOP__, __FS_LLM_CLOUD__))) return null;
  return (
    <Suspense fallback={null}>
      <GeneratorDialog initialPrompt={request.prompt} at={request.at} autostart={request.autostart} initialPicture={request.picture} onClose={closeGenerator} />
    </Suspense>
  );
}
