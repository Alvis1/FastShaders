import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import '@/components/Modals/CsvImportModal.css';
import './eval.css';

/**
 * Eval-mode EXPORT interception. In a study session the EXPORT button is what
 * a participant naturally reaches for when they think they are done, so it
 * asks first instead of quietly downloading a bare shader: Continue (keep
 * working, nothing saved) or Finish (questionnaire, then the one package).
 *
 * There is deliberately ONE download and it happens after the questionnaire:
 * the SUS answers belong INSIDE the package (a study zip without them is not
 * a study package), and a pre-questionnaire zip would leave the researcher
 * with two near-identical files per participant — which `eval-analysis.mjs`
 * would then count twice. The body text promises exactly that sequence.
 *
 * Escape and the backdrop mean CONTINUE — the non-destructive choice, and the
 * same "a dismissal is the safe answer" rule the image-import dialog follows.
 */

interface Props {
  open: boolean;
  onContinue: () => void;
  onFinish: () => void;
}

export function EvalFinishModal({ open, onContinue, onFinish }: Props) {
  const language = useAppStore((s) => s.language);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onContinue();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onContinue]);

  if (!open) return null;

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={onContinue}>
      <div
        className="csv-import-modal__panel eval-modal__panel eval-finish__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eval-finish-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="eval-finish-title">
          {t('Are you finished?', language)}
        </div>
        <div className="csv-import-modal__message">
          {t('If you are finished, you will first answer a short questionnaire (10 statements). Your shader and everything recorded during this session are then packaged into one file and sent to the researcher by email.', language)}
        </div>
        <div className="csv-import-modal__message">
          {t('If you would like to keep working, choose “Continue working” — nothing is saved or sent yet.', language)}
        </div>

        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" onClick={onContinue}>
            {t('Continue working', language)}
          </button>
          <button
            type="button"
            className="csv-import-modal__button csv-import-modal__button--yes"
            onClick={onFinish}
          >
            {t('Submit', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
