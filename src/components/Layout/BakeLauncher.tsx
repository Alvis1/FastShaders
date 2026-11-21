/**
 * Opens "Bake to texture" (components/Modals/BakeModal.tsx) while the store
 * holds a request (`bakeRequest`, written by `openBake` from the node and group
 * menus). The dialog and everything it runs are one `lazyOr` chunk, so the
 * boot wave carries only this file (docs/dev/baking.md). Never in the embed,
 * where no preview runs to render a bake.
 */
import { Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { isEmbedMode } from '@/embed/embedMode';
import { t } from '@/i18n';
import { lazyOr } from '@/utils/lazyOr';
import { useModalKeys } from '@/components/Modals/useModalKeys';
import '@/components/Modals/CsvImportModal.css';

interface DialogProps {
  selectedIds: string[];
  onClose: () => void;
}

/** What shows when the dialog's chunk cannot be fetched — the app has no error boundary. */
function BakeUnavailable({ onClose }: DialogProps) {
  const language = useAppStore((s) => s.language);
  useModalKeys(true, (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') e.stopPropagation();
  }, true);
  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={onClose}>
      <div className="csv-import-modal__panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="csv-import-modal__message">
          {t('Bake to texture could not be loaded. Reload the page and try again.', language)}
        </div>
        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" onClick={onClose}>{t('Close', language)}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const BakeModal = lazyOr<DialogProps>(
  () => import('@/components/Modals/BakeModal').then((m) => m.BakeModal),
  BakeUnavailable,
);

export function BakeLauncher() {
  const request = useAppStore((s) => s.bakeRequest);
  const closeBake = useAppStore((s) => s.closeBake);
  if (!request || isEmbedMode()) return null;
  return (
    <Suspense fallback={null}>
      <BakeModal selectedIds={request.selectedIds} onClose={closeBake} />
    </Suspense>
  );
}
