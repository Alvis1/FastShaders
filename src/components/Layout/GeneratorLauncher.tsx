/**
 * Opens "Generate nodes from text" (src/llm/GeneratorDialog.tsx) when the
 * toolbar's Settings list asks — its "Open the generator…" row, shown once the
 * user has ticked the opt-in. This and the leaf flag (utils/generatorFlag.ts)
 * are the generator's ONLY boot-path pieces: everything else is src/llm/,
 * loaded through `lazyOr` when the dialog first opens, so a visitor who never
 * opts in never downloads it (bootWave.test.ts).
 *
 * It renders nothing unless the build can reach a model, the user switched
 * the feature on, and this is neither a study session nor the embed — the
 * Settings row checks the same, and the dialog's own run and Add refuse in a
 * study again (docs/dev/node-generator.md).
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
  /** A request to start from (the asset search, once that entry exists). */
  initialPrompt: string;
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

export function GeneratorLauncher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const enabled = useAppStore((s) => s.nodeGenerator);
  if (!open || isEmbedMode() || !generatorOffered(enabled, isEvalMode(), generatorBuild(__FS_DESKTOP__, __FS_LLM_CLOUD__))) return null;
  return (
    <Suspense fallback={null}>
      <GeneratorDialog initialPrompt="" onClose={onClose} />
    </Suspense>
  );
}
