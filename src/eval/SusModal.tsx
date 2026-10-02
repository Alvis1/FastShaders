import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t, type Language } from '@/i18n';
import { buildZip } from '@/utils/zipWriter';
import { buildMailtoUrl } from '@/utils/feedbackReport';
import { buildShaderBundle } from '@/engine/exportShader';
import { collectEnv, collectProject } from '@/components/Modals/FeedbackModal';
import {
  EVAL_SCHEMA,
  EVAL_STUDY_EMAIL,
  IDLE_THRESHOLD_MS,
  clearEvalMode,
  readEvalSession,
} from './evalMode';
import {
  evalLog,
  endEvalSession,
  getEvalEvents,
  getEvalClockOriginMs,
  clearEvalJournal,
  isEvalSessionActive,
} from './telemetry';
import { deriveSummary, runQualityChecks, type QualityCheck } from './telemetryModel';
import { evalTask } from './evalTask';
import {
  BACKGROUND_ITEMS,
  EXPERIENCE_LEVELS,
  backgroundComplete,
  buildBackgroundRecord,
  type BackgroundAnswers,
} from './background';
import { PRO_ITEMS, buildProRecord, proComplete, type ProAnswers } from './proQuestions';
import { LangSwitch } from './LangSwitch';
import { summarizeAnswerLanguages } from './answerLanguage';
import { useStudyDialog } from './studyDialog';
import { collectDevice, costTableProvenance } from './evalContext';
import { capturePreviewShot } from './previewShot';
import { buildEvalPackageEntries, evalZipFileName } from './evalPackage';
import { precheckEvalUpload, uploadEvalPackage, type EvalUploadResult } from './evalUpload';
import { formatMiB } from '@/utils/formatSize';
import { fillTemplate } from '@/utils/fillTemplate';
import { downloadBlob } from '@/utils/downloadBlob';
import {
  SUS_ANCHOR_HIGH_EN,
  SUS_ANCHOR_HIGH_LV,
  SUS_ANCHOR_LOW_EN,
  SUS_ANCHOR_LOW_LV,
  SUS_ITEM_COUNT,
  SUS_ITEMS_EN,
  SUS_ITEMS_LV,
  computeSusScore,
} from './susScore';
import '@/components/Modals/CsvImportModal.css';
import './eval.css';

/**
 * The SUS questionnaire — what the toolbar's red `!` opens in eval mode
 * (instead of the FeedbackModal). Administered per Brooke's original
 * instructions: immediately at session end, immediate responses, all items
 * required, "mark the centre point if you cannot respond" stated up front.
 * The score is computed into the package but NOT shown to the participant
 * (no pre-debrief anchoring).
 *
 * Submit is the session's end: telemetry stops, the package zip (SUS +
 * telemetry + the shader + session metadata) downloads, the package is
 * uploaded to the study server (evalUpload.ts says from which hosts that
 * works), and the thank-you screen OFFERS a prefilled mailto — `mailto:`
 * cannot carry attachments, so the body names the downloaded file. The
 * researcher can always collect the downloaded zip from the machine instead.
 *
 * Cancel ("Back to the editor" or Escape) returns to the session — nothing ends
 * until Submit. From Submit to the thank-you screen the form is frozen (busy):
 * neither works, and every answer control is disabled, so what is on screen is
 * what gets packed. A click OUTSIDE the panel does nothing, on both screens:
 * the form is long and scrolls, so a scrollbar drag or a text selection
 * released past the panel's edge used to land on the backdrop and hide it,
 * and on the thank-you screen that hid the Download and email buttons with
 * it. While open, the app behind it is inert and every key but Tab is
 * swallowed (studyDialog.ts, shared by every study dialog). Submit also
 * refuses outright without a consented session, so no path can produce a
 * package without a consent record.
 *
 * Both screens carry their own EN/LV switch (`LangSwitch`), as the consent
 * does: the dialog is modal, so the toolbar's button is out of reach. Answers
 * are kept by index, so a switch mid-questionnaire keeps them. Because that
 * makes a form answered partly in each language one click away, the language
 * of every SUS answer is noted as it is given and `sus.json.language` is the
 * language the SUS was ANSWERED in — 'mixed' when its answers span both
 * (answerLanguage.ts) — with `languageAtSubmit` beside it. A switch on the form
 * is a `lang-switch` event; one on the thank-you screen is not recorded, since
 * Submit has already ended the session. The email draft is built at render,
 * so its one line for the participant follows the switch.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

interface DoneState {
  fileName: string;
  zipBytes: Uint8Array;
  /** The email draft's subject and its researcher summary (English); the
   *  participant's line is added at render, in the current language. */
  mailSubject: string;
  mailSummary: string[];
  failedChecks: QualityCheck[];
  /** Delivery option B: 'pending' while in flight; 'disabled' = not configured; 'too-large' = over MAX_UPLOAD_BYTES, never sent (the size shown is zipBytes.length). */
  upload: EvalUploadResult | 'pending';
}

function downloadBytes(fileName: string, bytes: Uint8Array): void {
  const buf = new Uint8Array(bytes).buffer;
  downloadBlob(new Blob([buf], { type: 'application/zip' }), fileName);
}

export function SusModal({ open, onClose }: Props) {
  const language = useAppStore((s) => s.language);

  const [responses, setResponses] = useState<(number | null)[]>(
    () => Array<number | null>(SUS_ITEM_COUNT).fill(null),
  );
  const [comment, setComment] = useState('');
  // Asked BEFORE the SUS: a usability score is not interpretable without
  // knowing whose it is, and answering them first keeps thinking about one's
  // own expertise from colouring the SUS items.
  const [background, setBackground] = useState<BackgroundAnswers>({});
  // The professional block — only in the /evalpro arm.
  const [pro, setPro] = useState<ProAnswers>({});
  const submittingRef = useRef(false);
  // Submit → thank-you screen. See handleSubmit.
  const [busy, setBusy] = useState(false);
  // The UI language each SUS answer was GIVEN in, noted at the radio's
  // onChange (answerLanguage.ts says why the language at Submit is not enough).
  const susAnswerLangRef = useRef<(Language | undefined)[]>(Array(SUS_ITEM_COUNT).fill(undefined));
  const [participant, setParticipant] = useState(() => readEvalSession()?.participant ?? '');
  const [done, setDone] = useState<DoneState | null>(null);

  // One sus-open marker per opening (not while the thank-you screen shows).
  // The participant code is re-read here because the useState initializer ran
  // at Toolbar mount — BEFORE the consent screen wrote the session record, so
  // in the ordinary fresh-entry flow it captured nothing.
  useEffect(() => {
    if (open && !done) {
      evalLog('sus-open');
      setParticipant((prev) => prev || (readEvalSession()?.participant ?? ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Inert app behind, every key but Tab swallowed (studyDialog.ts says what
  // used to leak through). Escape is Cancel, except while Submit is packing.
  useStudyDialog(open, () => {
    if (!busy) onClose();
  });

  const items = language === 'lv' ? SUS_ITEMS_LV : SUS_ITEMS_EN;
  const anchorLow = language === 'lv' ? SUS_ANCHOR_LOW_LV : SUS_ANCHOR_LOW_EN;
  const anchorHigh = language === 'lv' ? SUS_ANCHOR_HIGH_LV : SUS_ANCHOR_HIGH_EN;
  const answered = useMemo(() => responses.filter((r) => r != null).length, [responses]);
  const proAsked = evalTask().proQuestions;
  const complete =
    answered === SUS_ITEM_COUNT && backgroundComplete(background) && (!proAsked || proComplete(pro));

  const handleSubmit = async () => {
    // A REF, not the `done` state: `capturePreviewShot()` below waits up to 4 s
    // (its own timeout) and nothing on screen changes while it does, so a
    // participant who clicks Submit twice — or once, sees nothing happen, and
    // clicks again — used to run the whole submission twice: two sus-submit
    // events, endEvalSession() twice, two downloads, two uploads and two
    // mailto navigations, leaving the server holding two packages for one
    // session id. State cannot close that window because React has not
    // re-rendered yet; a ref is set synchronously.
    if (!complete || done || submittingRef.current) return;
    // Fail closed: without a consented session (Agree, or a session resumed
    // after a reload) there is nothing to package. The inert app root makes
    // this unreachable from the consent screen; this keeps it so if a new
    // path to the questionnaire ever appears.
    if (!isEvalSessionActive()) return;
    submittingRef.current = true;
    // Busy until the thank-you screen replaces the form: the capture below
    // shows nothing for up to 4 s, and Escape or "Back to the editor" in that
    // window hid the dialog while the submission finished unseen — no
    // thank-you screen, no upload status, no Email button.
    setBusy(true);
    try {
      await submitPackage();
    } catch (err) {
      // An unexpected throw must not strand the participant behind disabled
      // buttons. The ref stays set, so no second, partial submission starts.
      setBusy(false);
      throw err;
    }
  };

  const submitPackage = async () => {
    const filled = responses.map((r) => r ?? 3);
    // Taken with `filled`, before the await below: both must describe the
    // same moment, the click.
    const answerLangs = susAnswerLangRef.current.slice();
    const score = computeSusScore(filled);
    const submittedIso = new Date().toISOString();
    const session = readEvalSession();
    const trimmedParticipant = participant.trim() || session?.participant || '';

    // The image is captured FIRST, while the preview still shows the finished
    // shader and before the session is torn down. Best-effort: a null here
    // just means the package ships without preview.png.
    const shot = await capturePreviewShot();

    // Order matters: the sus-submit + session-end events must be IN the log
    // the package carries, so log first, end the session, then read events.
    evalLog('sus-submit', { language });
    endEvalSession();
    const events = getEvalEvents();
    const summary = deriveSummary(events, { idleThresholdMs: IDLE_THRESHOLD_MS });
    const quality = runQualityChecks(events, summary, { susResponses: filled });

    // buildShaderBundle never throws (it catches internally), but the belt
    // matches the braces: a package without the shader still beats no package.
    let shader: { fileName: string; bytes: Uint8Array } | null = null;
    try {
      const bundle = buildShaderBundle();
      shader = { fileName: bundle.fileName, bytes: bundle.bytes };
    } catch {
      shader = null;
    }

    const device = collectDevice();
    const env = collectEnv();
    // Which language version of the SUS was answered — per item, and 'mixed'
    // for the form when its answers span both (answerLanguage.ts). Each item's
    // statement is recorded in the language it was answered in.
    const answeredIn = summarizeAnswerLanguages(answerLangs, language);
    const sus = {
      participant: trimmedParticipant,
      language: answeredIn.language,
      languageAtSubmit: language,
      background: buildBackgroundRecord(background),
      ...(proAsked ? { professional: buildProRecord(pro) } : {}),
      itemsVersion: 'brooke-1996-item8-awkward',
      items: filled.map((response, i) => {
        const itemLanguage = answeredIn.perItem[i];
        const statements = itemLanguage === 'lv' ? SUS_ITEMS_LV : SUS_ITEMS_EN;
        return { n: i + 1, item: statements[i], language: itemLanguage, response };
      }),
      score,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      submittedIso,
    };
    const input = {
      schema: EVAL_SCHEMA,
      session: {
        app: { version: env.version, build: env.build, address: env.address },
        env: {
          userAgent: env.userAgent,
          platform: env.platform,
          previewBackend: env.previewBackend,
          gpuExposed: env.gpuExposed,
          display: env.display,
        },
        session: {
          id: session?.id ?? 'unknown',
          participant: trimmedParticipant,
          startedIso: session?.startedIso ?? '',
          submittedIso,
          timezone: device.timezone,
          idleThresholdMs: IDLE_THRESHOLD_MS,
          // Wall-clock ms of the event clock's zero: event t → calendar time
          // is clockOriginMs + t. Survives mid-session reloads (the journal
          // carries the anchor and new events are rebased onto it).
          clockOriginMs: getEvalClockOriginMs(),
        },
        consent: {
          givenAtIso: session?.consentIso ?? '',
          textVersion: session?.consentVersion ?? '',
        },
        // Which task and which experimental condition this session ran under.
        task: evalTask(),
        // Which price table valued the graph: a point total is only
        // interpretable against the table that produced it, and the tables
        // move with each  calibration round.
        costTable: costTableProvenance(),
        device,
        project: collectProject(),
      },
      sus,
      events,
      summary,
      quality,
      shader,
      shot,
    };

    const zipBytes = buildZip(buildEvalPackageEntries(input));
    const fileName = evalZipFileName(trimmedParticipant, submittedIso);
    downloadBytes(fileName, zipBytes);
    // The journal has served its crash-recovery purpose; the data now lives in
    // the downloaded package (and in memory behind the re-download button).
    // Dropping the arm + session record ends eval mode for this tab outright:
    // without it, a post-submit reload would silently restart recording under
    // the finished participant's identity with no consent act.
    clearEvalJournal();
    clearEvalMode();

    // The SUS score deliberately does NOT appear here: the participant reads
    // this draft while attaching the zip, and showing them their score before
    // the debrief is exactly the anchoring the hidden-score rule prevents.
    // The researcher's summary stays English; the one line addressed to the
    // PARTICIPANT is added at render (see the thank-you screen), so it follows
    // a language switch made there.
    const mailSubject = `FastShaders eval — ${trimmedParticipant || 'participant'} — ${submittedIso.slice(0, 10)}`;
    const mailSummary = [
      `FastShaders evaluation session — ${trimmedParticipant || 'participant'}`,
      '',
      `Active time: ${(summary.activeMs / 60_000).toFixed(1)} min of ${(summary.wallMs / 60_000).toFixed(1)} min`,
      `Nodes added: ${Object.values(summary.nodeAddsByType).reduce((a, b) => a + b, 0)} · connections made: ${summary.counts['edge-connect'] ?? 0}`,
      `Events recorded: ${summary.eventCount}`,
      '',
    ];

    // Delivery option B (fire-and-forget): the download above already happened
    // — the upload is IN ADDITION, and every failure mode degrades to the
    // attach-it-yourself instructions the thank-you screen shows anyway. The
    // disabled and too-large states are decided synchronously
    // (precheckEvalUpload), so "Uploading…" never flashes for a package that
    // is not going to be sent.
    const precheck = precheckEvalUpload(zipBytes.length);
    setDone({
      fileName,
      zipBytes,
      mailSubject,
      mailSummary,
      failedChecks: quality.filter((q) => !q.ok),
      upload: precheck ?? 'pending',
    });
    // The thank-you screen is up (same render), so Escape closes it again.
    setBusy(false);
    if (precheck === null) {
      void uploadEvalPackage(fileName, zipBytes).then((result) => {
        setDone((d) => (d && d.fileName === fileName ? { ...d, upload: result } : d));
      });
    }

    // The mailto is OFFERED, never opened automatically. It used to navigate
    // here unconditionally, which meant the participant sent the package from
    // their own mail client and their own address — handing the researcher an
    // identifying email beside a code the consent form promises is
    // pseudonymous. It stays as a button because it is still the delivery
    // floor when the upload fails and the study machine is not the
    // researcher's; the consent text now discloses what pressing it reveals.
  };

  if (!open) return null;

  if (done) {
    const uploadWarn = done.upload === 'failed' || done.upload === 'too-large';
    const mailto = buildMailtoUrl(
      EVAL_STUDY_EMAIL,
      done.mailSubject,
      [
        ...done.mailSummary,
        fillTemplate(t('Please attach the file "{file}" (in your Downloads folder) to this email, then press Send.', language), { file: done.fileName }),
      ].join('\n'),
    );
    return createPortal(
      <div className="csv-import-modal__backdrop">
        <div
          className="csv-import-modal__panel eval-modal__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="eval-done-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="eval-consent__head">
            <div className="csv-import-modal__title" id="eval-done-title">
              {t('Thank you!', language)}
            </div>
            <LangSwitch />
          </div>
          <div className="csv-import-modal__message">
            {t('Your answers, your shader and the session data are packed into one file, saved in your Downloads folder:', language)}
          </div>
          <div className="eval-done__file">{done.fileName}</div>
          {done.failedChecks.length > 0 && (
            <div className="eval-done__warn">
              {t('Some data-quality checks failed. Tell the researcher before you leave:', language)}{' '}
              {done.failedChecks.map((q) => q.id).join(', ')}
            </div>
          )}
          {done.upload === 'ok' ? (
            <div className="csv-import-modal__message">
              {t('The file was uploaded to the study server.', language)}{' '}
              {t('Nothing more is needed. If the researcher also asks for it by email, use “Email to researcher”; that shows them your sender address.', language)}
            </div>
          ) : done.upload === 'pending' ? (
            <div className="csv-import-modal__message">{t('Uploading…', language)}</div>
          ) : (
            // The automatic transfer is the only step that can fail (offline
            // room, no endpoint on this host, server down, or a package over
            // the server's cap), so it says so plainly and points at the copy
            // that always exists: the file downloaded at submit. The
            // no-endpoint configuration lands here too, minus the failure line.
            <>
              <div className={uploadWarn ? 'eval-done__warn' : 'csv-import-modal__message'}>
                {done.upload === 'failed' && <>{t('Upload failed.', language)} </>}
                {done.upload === 'too-large' && (
                  <>
                    {fillTemplate(t('The file is too large for the study server ({size} MB; it accepts up to 64 MB).', language), { size: formatMiB(done.zipBytes.length, language, 'up') })}{' '}
                  </>
                )}
                {t('Give the file to the researcher: it is in your Downloads folder, and “Download” saves another copy.', language)}
              </div>
              <div className="csv-import-modal__message">
                {t('You can also email it with “Email to researcher”; that shows the researcher your sender address.', language)}
              </div>
            </>
          )}
          <div className="csv-import-modal__buttons">
            <button
              type="button"
              className={`csv-import-modal__button${
                uploadWarn ? ' csv-import-modal__button--yes' : ''
              }`}
              onClick={() => downloadBytes(done.fileName, done.zipBytes)}
            >
              {t('Download', language)}
            </button>
            <button type="button" className="csv-import-modal__button" onClick={onClose}>
              {t('Close', language)}
            </button>
            <a className="csv-import-modal__button csv-import-modal__button--primary" href={mailto}>
              {t('Email to researcher', language)}
            </a>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="csv-import-modal__backdrop">
      <div
        className="csv-import-modal__panel eval-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sus-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eval-consent__head">
          <div className="csv-import-modal__title" id="sus-modal-title">
            {t('Before you finish: a short questionnaire', language)}
          </div>
          <LangSwitch disabled={busy} />
        </div>
        <div className="csv-import-modal__message">
          {t('Every scale question is required; the text boxes are optional.', language)}
        </div>

        <div className="sus-modal__meta">
          <div className="eval-consent__code-row">
            <label htmlFor="sus-participant">{t('Participant code:', language)}</label>
            <input
              id="sus-participant"
              type="text"
              value={participant}
              maxLength={40}
              placeholder="P01"
              disabled={busy}
              onChange={(e) => setParticipant(e.target.value)}
            />
          </div>
          <div className="sus-modal__progress">
            {answered}/{SUS_ITEM_COUNT}
          </div>
        </div>

        {/* Experience questions — BEFORE the SUS. Same radio-strip shape as
            the SUS items so the questionnaire reads as one instrument, but on
            its own none→expert scale, with its own anchors. */}
        <div className="sus-modal__section-head">{t('Your experience', language)}</div>
        <div className="sus-modal__anchors" aria-hidden="true">
          <span>{t(EXPERIENCE_LEVELS[0], language)}</span>
          <span>{t(EXPERIENCE_LEVELS[EXPERIENCE_LEVELS.length - 1], language)}</span>
        </div>
        <div className="sus-modal__items">
          {BACKGROUND_ITEMS.map((it) => (
            <div className="sus-modal__item" key={it.id}>
              <span className="sus-modal__statement" id={`bg-item-${it.id}`}>
                {t(it.question, language)}
              </span>
              <span className="sus-modal__scale" role="radiogroup" aria-labelledby={`bg-item-${it.id}`}>
                {EXPERIENCE_LEVELS.map((label, level) => (
                  <label key={label} title={t(label, language)}>
                    <input
                      type="radio"
                      name={`bg-${it.id}`}
                      value={level}
                      checked={background[it.id] === level}
                      disabled={busy}
                      onChange={() => setBackground((prev) => ({ ...prev, [it.id]: level }))}
                    />
                    {level + 1}
                  </label>
                ))}
              </span>
            </div>
          ))}
        </div>

        {proAsked && (
          <>
            <div className="sus-modal__section-head">{t('Your professional work', language)}</div>
            {PRO_ITEMS.map((q) =>
              q.kind === 'text' ? (
                <label className="sus-modal__followup" key={q.id} htmlFor={`pro-${q.id}`}>
                  {t(q.question, language)}
                  <input
                    id={`pro-${q.id}`}
                    type="text"
                    className="sus-modal__followup-input"
                    value={typeof pro[q.id] === 'string' ? (pro[q.id] as string) : ''}
                    maxLength={300}
                    disabled={busy}
                    onChange={(e) => setPro((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  />
                </label>
              ) : (
                <div className="sus-modal__pro-scale" key={q.id}>
                  <span className="sus-modal__statement" id={`pro-item-${q.id}`}>
                    {t(q.question, language)}
                  </span>
                  <span
                    className="sus-modal__scale sus-modal__scale--wide"
                    role="radiogroup"
                    aria-labelledby={`pro-item-${q.id}`}
                  >
                    {q.levels.map((label, level) => (
                      <label key={label} title={t(label, language)}>
                        <input
                          type="radio"
                          name={`pro-${q.id}`}
                          value={level}
                          checked={pro[q.id] === level}
                          disabled={busy}
                          onChange={() => setPro((prev) => ({ ...prev, [q.id]: level }))}
                        />
                        <span className="sus-modal__level-label">{t(label, language)}</span>
                      </label>
                    ))}
                  </span>
                </div>
              ),
            )}
          </>
        )}

        <div className="sus-modal__section-head">{t('Statements about FastShaders', language)}</div>
        {/* Brooke's own instruction, placed on the SUS block it applies to: the
            experience strip above runs none→expert, where "centre point"
            would be meaningless. */}
        <div className="csv-import-modal__message">
          {t('Mark your immediate response to each statement without thinking long. If you cannot respond to one, mark the centre point (3).', language)}
        </div>
        <div className="sus-modal__anchors" aria-hidden="true">
          <span>1 — {anchorLow}</span>
          <span>5 — {anchorHigh}</span>
        </div>

        <div className="sus-modal__items">
          {items.map((text, i) => (
            <div className="sus-modal__item" key={i}>
              <span className="sus-modal__statement" id={`sus-item-${i}`}>
                {i + 1}. {text}
              </span>
              <span
                className="sus-modal__scale"
                role="radiogroup"
                aria-labelledby={`sus-item-${i}`}
              >
                {[1, 2, 3, 4, 5].map((v) => (
                  <label key={v} title={v === 1 ? anchorLow : v === 5 ? anchorHigh : undefined}>
                    <input
                      type="radio"
                      name={`sus-${i}`}
                      value={v}
                      checked={responses[i] === v}
                      disabled={busy}
                      onChange={() => {
                        susAnswerLangRef.current[i] = language;
                        setResponses((prev) => {
                          const next = prev.slice();
                          next[i] = v;
                          return next;
                        });
                      }}
                    />
                    {v}
                  </label>
                ))}
              </span>
            </div>
          ))}
        </div>

        <label className="csv-import-modal__message" htmlFor="sus-comment">
          {t('Comments (optional)', language)}
        </label>
        <textarea
          id="sus-comment"
          className="sus-modal__comment"
          value={comment}
          disabled={busy}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
        />

        {busy && (
          <div className="csv-import-modal__message" role="status">
            {t('Packing your answers and the session data…', language)}
          </div>
        )}
        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" disabled={busy} onClick={onClose}>
            {t('Back to the editor', language)}
          </button>
          <button
            type="button"
            className="csv-import-modal__button csv-import-modal__button--yes"
            disabled={!complete || busy}
            title={complete ? undefined : t('Answer every scale question first', language)}
            onClick={handleSubmit}
          >
            {t('Submit', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
