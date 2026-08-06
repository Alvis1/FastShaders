import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import './CsvImportModal.css';
import './LimitModal.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * The long form behind the "?" on the import one-liner.
 *
 * Everything that used to be a blocking modal on every failed conversion
 * lives here instead: the notice itself is now a single line the user can
 * ignore, and the explanation is one click away for whoever wants it. The
 * facts are measured on real browsers, not inferred from a UA string — see
 * `probeEncodeCaps`, which decides the actual behaviour the same way.
 */
export function ImageConvertInfoModal({ open, onClose }: Props) {
  const language = useAppStore((s) => s.language);
  const hide = useAppStore((s) => s.hideImageConvertNotice);
  const setHide = useAppStore((s) => s.setHideImageConvertNotice);
  const convertMode = useAppStore((s) => s.imageConvertMode);
  const setConvertMode = useAppStore((s) => s.setImageConvertMode);
  const [checked, setChecked] = useState(hide);

  useEffect(() => {
    if (open) setChecked(useAppStore.getState().hideImageConvertNotice);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key !== 'Tab') e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const commit = () => {
    setHide(checked);
    onClose();
  };

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={commit}>
      <div
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-info-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="convert-info-title">
          {t('About image optimization', language)}
        </div>
        <div className="csv-import-modal__message">
          {t('“Optimized” means WebP: typically 2–3× smaller than PNG for the same pixels, and completely lossless where the browser supports it. Sizes are also snapped to a power of two when that costs almost nothing.', language)}
        </div>
        <div className="csv-import-modal__message">
          {t('Some browsers can DISPLAY WebP but cannot CREATE it. Safari — and anything built on WebKit, including the FastShaders desktop app on macOS — quietly returns a PNG when asked for WebP. When that happens the image is stored in its own format instead (PNG, or JPEG for photos), which is why a large .png can end up as a .jpg.', language)}
        </div>
        <ul className="limit-modal__suggestions">
          <li>{t('Import images in Chrome, Edge or Firefox to get WebP. The shader itself runs identically either way.', language)}</li>
          <li>{t('Or convert the file to WebP before dropping it in — an already-WebP source is kept as it is.', language)}</li>
          <li>{t('For photographs, JPEG at this size is close to WebP anyway. The difference shows on flat colour, sharp edges and transparency.', language)}</li>
          <li>{t('Whatever happens, the image is still stripped of EXIF/GPS data and still resized to fit your target headset and the project’s image budget.', language)}</li>
          <li>{t('Any conversion can be undone per image: right-click the node → “Revert to original”.', language)}</li>
        </ul>
        {/* The import dialog's "Don't ask again" writes this; without a
            control here that would be a one-way door — a remembered "No"
            looks exactly like the optimization being broken. */}
        <div className="csv-import-modal__row">
          <span>{t('Optimize on import', language)}</span>
          <select
            value={convertMode}
            onChange={(e) => setConvertMode(e.target.value as 'ask' | 'always' | 'never')}
          >
            <option value="ask">{t('Ask each time', language)}</option>
            <option value="always">{t('Always', language)}</option>
            <option value="never">{t('Never', language)}</option>
          </select>
        </div>
        <label className="limit-modal__ignore">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {t('Don’t show this message again', language)}
        </label>
        <div className="csv-import-modal__buttons">
          <button className="csv-import-modal__button csv-import-modal__button--primary" onClick={commit}>
            {t('OK', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
