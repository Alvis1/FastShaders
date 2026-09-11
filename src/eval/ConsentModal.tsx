import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { EVAL_DPO_CONTACT, EVAL_RETENTION_PERIOD, warnIfConsentIncomplete } from './evalMode';
import { DataDisclosureModal } from './DataDisclosureModal';
import '@/components/Modals/CsvImportModal.css';
import './eval.css';

/**
 * Eval-mode consent screen — shown at boot, BEFORE any logging starts.
 * Content follows the Horizon Europe "Ethics and Data Protection" consent
 * checklist: controller identity + contact, specific purpose, exactly what is
 * collected, retention, withdrawal and complaint rights (see EVAL_MODE_PLAN.md
 * §2.6). Deliberately NOT dismissible by backdrop click or Escape — the only
 * ways out are the two explicit choices, so consent is an affirmative act.
 *
 * The participant field asks for a CODE, not a name (GDPR data minimisation;
 * pseudonymisation is the Horizon Europe default) — the researcher assigns
 * P01, P02, … and keeps the code→name key on the paper consent form, apart
 * from the data.
 */

/*
 * TWO THINGS ARE STILL MISSING and the text is written to survive their absence
 * rather than to paper over it: `EVAL_DPO_CONTACT` and `EVAL_RETENTION_PERIOD`
 * in evalMode.ts. While they are empty this dialog OMITS the data-protection-
 * officer sentence and falls back to "for the duration of the research
 * project" — consent-2 instead promised "you can also contact the university's
 * data protection officer" with no name, address or route, which is a promise
 * the app could not keep. Fill the constants in and both sentences appear.
 * `warnIfConsentIncomplete()` shouts at the researcher on every study boot until
 * then; the participant sees nothing untrue either way.
 *
 * THE SUMMARY IS SHORT ON PURPOSE, AND THE DETAILS BUTTON IS WHY IT CAN BE. A consent
 * screen nobody finishes reading is not consent, but "what do you collect" has a
 * page-long honest answer. `DataDisclosureModal` holds the literal walk of the
 * package; these five bullets have to be true, not complete.
 */

interface Props {
  onAgree: (participant: string) => void;
  onDecline: () => void;
}

export function ConsentModal({ onAgree, onDecline }: Props) {
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const [participant, setParticipant] = useState('');
  const [showDisclosure, setShowDisclosure] = useState(false);

  useEffect(warnIfConsentIncomplete, []);

  return createPortal(
    <div className="csv-import-modal__backdrop">
      <div
        className="csv-import-modal__panel eval-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eval-consent-title"
      >
        {/* The panel carries its OWN language switch: this dialog is modal, so
            the toolbar's button is unreachable behind the backdrop — and a
            consent form nobody can read in their language is not consent. */}
        <div className="eval-consent__head">
          <div className="csv-import-modal__title" id="eval-consent-title">
            {t('FastShaders user study', language)}
          </div>
          <button
            type="button"
            className="csv-import-modal__button eval-consent__lang"
            onClick={() => setLanguage(language === 'lv' ? 'en' : 'lv')}
            title={
              language === 'lv'
                ? 'Pārslēgt uz angļu valodu (Switch to English)'
                : 'Pārslēgt uz latviešu valodu (Switch to Latvian)'
            }
            aria-label={language === 'lv' ? 'Switch to English' : 'Pārslēgt uz latviešu valodu'}
          >
            {language === 'lv' ? 'EN' : 'LV'}
          </button>
        </div>

        <div className="eval-consent__section">
          {t('You are invited to a usability study of FastShaders, a visual shader editor built in a research project.', language)}{' '}
          <strong>{t('Data controller: Vidzeme University of Applied Sciences (ViA).', language)}</strong>{' '}
          {t('Contact: alvis.misjuns@va.lv.', language)}{' '}
          {EVAL_DPO_CONTACT
            ? `${t('Data-protection questions can also go to the data protection officer:', language)} ${EVAL_DPO_CONTACT}`
            : t('Data-protection questions go to the same address.', language)}
        </div>

        {/* A LAYERED notice: one sentence naming the categories, with the
            complete field-by-field list one click away behind "Details". The
            long list used to sit here in full, which made the dialog a page
            of prose nobody reads — the categories are what informs the
            decision, the detail is what answers a question about it. */}
        <div className="eval-consent__section">
          <div className="eval-consent__what-head">
            <strong>{t('What is recorded during the session:', language)}</strong>
            <button
              type="button"
              className="eval-consent__help"
              onClick={() => setShowDisclosure(true)}
              title={t('What exactly is collected', language)}
            >
              {t('Details', language)}
            </button>
          </div>
          {t('Your actions in the editor (not what you type), your questionnaire answers, the shader you build with a picture of it, and technical facts about this computer.', language)}
        </div>

        <div className="eval-consent__section">
          {t('Nothing is sent while you work. When you submit the questionnaire, the data is packed into one file, saved on this computer and uploaded to the study server alvismisjuns.lv (also reachable as fs.sferas.lv), operated by the researcher.', language)}
        </div>

        <div className="eval-consent__section">
          {EVAL_RETENTION_PERIOD
            ? `${t('The data is stored under your participant code, not your name, used only for this research and kept', language)} ${EVAL_RETENTION_PERIOD}.`
            : t('The data is stored under your participant code, not your name, used only for this research and deleted when the project ends.', language)}{' '}
          {t('Taking part is voluntary. To stop, close this tab: nothing is kept unless you submit. Later you can have your data deleted by quoting your participant code, and you can complain to the Data State Inspectorate (Datu valsts inspekcija).', language)}
        </div>

        <div className="eval-consent__section">
          <strong>{t('When you are finished, press EXPORT in the toolbar and choose “Submit”.', language)}</strong>
        </div>

        <div className="eval-consent__code-row">
          <label htmlFor="eval-participant">{t('Participant code (from the researcher):', language)}</label>
          <input
            id="eval-participant"
            type="text"
            value={participant}
            maxLength={40}
            placeholder="P01"
            onChange={(e) => setParticipant(e.target.value)}
            autoFocus
          />
        </div>

        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" onClick={onDecline}>
            {t('No thanks — open the normal app', language)}
          </button>
          <button
            type="button"
            className="csv-import-modal__button csv-import-modal__button--yes"
            onClick={() => onAgree(participant.trim())}
          >
            {t('I agree — start the session', language)}
          </button>
        </div>
      </div>
      {showDisclosure && <DataDisclosureModal onClose={() => setShowDisclosure(false)} />}
    </div>,
    document.body,
  );
}
