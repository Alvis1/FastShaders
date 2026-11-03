import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { LangSwitch } from './LangSwitch';
import { useStudyDialog } from './studyDialog';
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
 * Escape closes it as well as its Close button. A click OUTSIDE it does
 * nothing, as on every study dialog: the list is long and scrolls, and a
 * scrollbar drag released past the panel's edge lands on the backdrop. Its
 * keys go through `useStudyDialog` like every study dialog's: WINDOW capture,
 * every key but Tab stopped. It must be window capture, not document: the
 * consent behind it swallows keys there, and a later listener on the same
 * target still runs, while one further down the path never would. The
 * consent makes its own panel inert while this one is open, so Shift+Tab
 * cannot walk onto its hidden "I agree".
 *
 * Focus goes to Close ONCE, on open. It used to sit in an effect keyed on
 * `onClose`, which the consent passes inline — so every language switch re-ran
 * it, moved focus from the LV/EN button to Close (a second Enter then closed
 * the dialog) and scrolled the panel to its end.
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
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useStudyDialog(true, onClose);

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
    <div className="csv-import-modal__backdrop eval-disclosure__backdrop">
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
          <LangSwitch />
        </div>

        <div className="eval-consent__section">
          {t('Nothing leaves this computer while you work. Submitting builds one ZIP file containing only the items below.', language)}
        </div>

        <div className="eval-consent__section">
          <strong>{t('Contents of the ZIP file', language)}</strong>
          <ul className="eval-consent__list eval-disclosure__list">
            {item(
              'Editor actions log',
              'telemetry-events.json',
              'Timestamped editor events: nodes added/removed (by type), setting names changed (never values), connections, undo/redo, code applies, dropped assets, intro slides and tutorial steps used, language switches, tab visibility, and periodic graph-size counts. No keystrokes, typed text, clipboard, or addresses.',
            )}
            {item(
              'Session totals',
              'telemetry-summary.json',
              'Session duration, active time, action counts, node types used, time to first node and connection, and quality checks.',
            )}
            {item(
              'Your questionnaire answers',
              'sus.json',
              'Responses to the 10 usability statements and computed SUS score; session/tool questions (task completion, mental effort, node look and performance points, plus workflow and suitability items on /evalpro); prior experience with 3D tools, node editors, and shader code; your optional free-text comment; and the language of each answer.',
            )}
            {item(
              'One-row CSV summary',
              'summary.csv',
              'Key session metrics and coded questionnaire answers as a single spreadsheet row.',
            )}
            {item(
              'Session metadata',
              'session.json',
              'Participant code, 18+ confirmation (when asked), start/submit timestamps, time zone, study arm, task and budget condition, cost table, graph counts, and device info.',
            )}
            {item(
              'The shader you built',
              'shader/',
              'Your node graph, note text, custom property/colour names, board drawings, and any image or 3D model you added (the file and its file name).',
            )}
            {item(
              '3D preview screenshot',
              'preview.png',
              'Snapshot of the 3D viewport at submit (only the 3D view, never the rest of the screen).',
            )}
            {item(
              'ZIP file guide',
              'README.txt',
              'Plain-text explanation of the files in the archive.',
            )}
          </ul>
        </div>

        <div className="eval-consent__section">
          <strong>{t('Technical facts about this computer', language)}</strong>
          <ul className="eval-consent__list eval-disclosure__list">
            {item(
              'Device and browser profile',
              'session.json → device',
              'Browser and OS version, screen/window size, pixel ratio, graphics card name, processor cores, approximate memory, touch and WebGPU support, locale, time zone, and theme/motion preferences — used to interpret performance across devices.',
            )}
          </ul>
        </div>

        <div className="eval-consent__section">
          <strong>{t('Not collected', language)}</strong>
          <div className="eval-disclosure__body">
            {t('No keystrokes, microphone, camera, screen outside the app, browsing history, other files, or your name/email.', language)}
          </div>
        </div>

        <div className="eval-consent__section">
          <strong>{t('Where it goes', language)}</strong>
          <div className="eval-disclosure__body">
            {t('Saved to your Downloads folder and uploaded to the study server alvismisjuns.lv (fs.sferas.lv), operated by the researcher. Sending by email is optional and reveals your email address.', language)}
          </div>
        </div>

        <div className="eval-consent__section">
          <strong>{t('During the session', language)}</strong>
          <div className="eval-disclosure__body">
            {t('Data stays in this browser tab until you press Submit; closing the tab discards everything.', language)}
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
