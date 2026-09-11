import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import '@/components/Modals/CsvImportModal.css';
import './eval.css';

/**
 * "What exactly is collected" — the full disclosure behind the consent screen's
 * Details button.
 *
 * WHY IT EXISTS. The consent dialog has to be readable in under a minute, and
 * the honest answer to "what do you collect" is a page long. consent-2 resolved
 * that tension by summarising the technical block as "browser and platform
 * version, screen size, and time zone" and closing with "Nothing else is
 * recorded" — a sentence that was simply false: the package also carries a
 * 14-field device block, a rendered screenshot, a free-text comment, and the
 * whole shader including any dropped image, 3D model and its FILE NAME. Putting
 * the complete list one click away lets the summary stay short AND true.
 *
 * WHAT IT MUST SAY. The content is not prose about intentions — it is a literal
 * walk of `buildEvalPackageEntries` (evalPackage.ts) and of the object literal
 * SusModal builds for session.json. `evalDisclosure.test.ts` pins that every zip
 * entry name the builder can emit appears here, so a future entry cannot ship
 * undisclosed. Anything added to the package is a change to THIS FILE and to
 * `CONSENT_TEXT_VERSION` first.
 *
 * DISMISSIBLE, unlike its parent. The consent screen is deliberately not
 * escapable — consent must be an affirmative act. This one is informational, so
 * Escape and the backdrop both close it, and it restores focus to the ? button
 * that opened it. Its Escape listener is CAPTURE-phase and stops propagation:
 * without that the key would also reach whatever else is listening and the
 * participant would find themselves somewhere they did not ask to be.
 *
 * It carries its own language switch for the same reason the consent screen
 * does — it is modal, so the toolbar's is unreachable, and a disclosure nobody
 * can read in their language discloses nothing.
 */

interface Props {
  onClose: () => void;
}

export function DataDisclosureModal({ onClose }: Props) {
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture + stop: the consent screen sits behind this one and other
      // global Escape handlers are live underneath both.
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  /**
   * One disclosed item: a plain-language LINE anyone can read at a glance,
   * plus a `?` whose tooltip names the file it lands in and spells out the
   * fields. The list answers "what do you take" in eight lines; the `?`
   * answers "what exactly, and where does it go" without turning the dialog
   * back into the page of prose it started as.
   *
   * The detail rides `title`, so it stays in the accessibility tree (a screen
   * reader announces it) rather than behind a `display: none` that reads as
   * absent. A hover has no touch equivalent, so every LINE is written to be
   * true and sufficient on its own.
   */
  const item = (line: string, file: string, detail: string) => (
    <li className="eval-disclosure__item">
      <span>{t(line, language)}</span>
      <button
        type="button"
        className="eval-disclosure__q"
        title={`${file} — ${t(detail, language)}`}
        aria-label={`${file} — ${t(detail, language)}`}
      >
        ?
      </button>
    </li>
  );

  return createPortal(
    <div
      className="csv-import-modal__backdrop eval-disclosure__backdrop"
      onClick={onClose}
    >
      <div
        className="csv-import-modal__panel eval-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eval-disclosure-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eval-consent__head">
          <div className="csv-import-modal__title" id="eval-disclosure-title">
            {t('What exactly is collected', language)}
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
          {t('Nothing leaves this computer while you work. When you submit the questionnaire, one ZIP file is built from the items below. The list is complete.', language)}
        </div>

        <div className="eval-consent__section">
          <strong>{t('Contents of the ZIP file', language)}</strong>
          <ul className="eval-consent__list eval-disclosure__list">
            {item(
              'What you did, step by step',
              'telemetry-events.json',
              'a timestamped list of your actions: nodes added or removed (by type), connections made and broken, undo and redo, code applied, assets dropped, the app shown or hidden, and a periodic graph-size count. What you did, never what you typed: no keystrokes, text, file contents, clipboard or addresses.',
            )}
            {item(
              'Totals derived from those steps',
              'telemetry-summary.json',
              'session length, active time, counts per action type, node types used, time to your first node and first connection, and automatic quality checks.',
            )}
            {item(
              'Your questionnaire answers',
              'sus.json',
              'the four experience answers and any software you name; in a professional session also your role, years, platforms and the other work questions; the ten statements, the score computed from them, and your free-text comment. Text you type in those boxes is stored word for word.',
            )}
            {item(
              'The main numbers as one spreadsheet row',
              'summary.csv',
              'the headline figures from the totals above, in spreadsheet form.',
            )}
            {item(
              'The session record',
              'session.json',
              'your participant code, start and submit times, time zone, your task and cost-budget condition, the price table used for your shader, graph counts, and the technical facts about this computer.',
            )}
            {item(
              'The shader you built',
              'shader/',
              'the complete shader with its node graph: note text, property and colour names you typed, freehand drawings on the board, and every image or 3D model you added, as the file itself plus its file name.',
            )}
            {item(
              'A picture of the 3D preview',
              'preview.png',
              'the 3D view as it looked when you pressed Submit. Only the rendered view: no toolbar, node graph or screen outside the app.',
            )}
            {item(
              'A description of the ZIP contents',
              'README.txt',
              'a plain-text description of the files above.',
            )}
          </ul>
        </div>

        <div className="eval-consent__section">
          <strong>{t('Technical facts about this computer', language)}</strong>
          <ul className="eval-consent__list eval-disclosure__list">
            {item(
              'What this computer is and how fast it is',
              'session.json → device',
              'browser and version, operating system, screen and window size, pixel ratio, graphics card name as the browser reports it, number of processor cores, approximate memory, touch support, WebGPU availability, browser language, time zone, and your dark-mode and reduced-motion settings. Collected to explain performance differences between participants; together they are fairly distinctive to this machine.',
            )}
          </ul>
        </div>

        <div className="eval-consent__section">
          <strong>{t('Not collected', language)}</strong>
          <div className="eval-disclosure__body">
            {t('Keystrokes. Microphone or camera. Any screen or window outside this app. Browsing history, other tabs, or files other than those you add to your shader. Your name, email address or account.', language)}
          </div>
        </div>

        <div className="eval-consent__section">
          <strong>{t('Where it goes', language)}</strong>
          <div className="eval-disclosure__body">
            {t('The ZIP file is saved in this computer’s Downloads folder and uploaded to the study server alvismisjuns.lv (also reachable as fs.sferas.lv), operated by the researcher. An optional button can also email it to the researcher; that shows them the address you send from.', language)}
          </div>
        </div>

        <div className="eval-consent__section">
          <strong>{t('During the session', language)}</strong>
          <div className="eval-disclosure__body">
            {t('Events are kept in this browser tab only, so a reload does not lose the session. Closing the tab discards them. Only Submit builds and sends the ZIP file.', language)}
          </div>
        </div>

        <div className="csv-import-modal__buttons">
          <button
            ref={closeRef}
            type="button"
            className="csv-import-modal__button csv-import-modal__button--yes"
            onClick={onClose}
          >
            {t('Close', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
