import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
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

// TODO(study): confirm the retention wording and the DPO contact line with
// the institution's data-management plan before the first real participant.

interface Props {
  onAgree: (participant: string) => void;
  onDecline: () => void;
}

export function ConsentModal({ onAgree, onDecline }: Props) {
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const [participant, setParticipant] = useState('');

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
          {t('You are invited to take part in a usability study of FastShaders, a visual shader editor developed as part of a research project.', language)}{' '}
          <strong>{t('Data controller: Vidzeme University of Applied Sciences (ViA).', language)}</strong>{' '}
          {t('Contact: alvis.misjuns@va.lv. For data-protection questions you can also contact the university’s data protection officer.', language)}
        </div>

        <div className="eval-consent__section">
          <strong>{t('What is recorded during the session:', language)}</strong>
          <ul className="eval-consent__list">
            <li>{t('Interaction events inside this app — timestamps of adding nodes, making and removing connections, undo/redo, applying code, and how long the app is active.', language)}</li>
            <li>{t('Your answers to a short questionnaire (10 statements) at the end.', language)}</li>
            <li>{t('The shader you create during the session.', language)}</li>
            <li>{t('Basic technical facts needed to interpret the results — browser and platform version, screen size, and time zone.', language)}</li>
          </ul>
          {t('Nothing else is recorded: no keystroke content, no audio or video, nothing outside this app. The data is packaged into one file only when you submit the questionnaire; that file is then sent to the university’s server (alvismisjuns.lv), where only the researcher can open it, and a copy is saved on this computer.', language)}
        </div>

        <div className="eval-consent__section">
          {t('The data is stored under your participant code (not your name), used only for this research, kept for the duration of the research project, and deleted afterwards.', language)}{' '}
          {t('Participation is voluntary: you can stop at any time by closing this tab, and the study data is discarded unless you submit the questionnaire. (The editor keeps its usual local autosave of the current shader on this computer, as it does for any user.) You may later ask for your data to be removed by contacting the researcher and quoting your participant code, and you have the right to complain to the Data State Inspectorate (Datu valsts inspekcija).', language)}
        </div>

        <div className="eval-consent__section">
          <strong>{t('When you are finished, press the EXPORT button at the top and choose “Submit”.', language)}</strong>
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
    </div>,
    document.body,
  );
}
