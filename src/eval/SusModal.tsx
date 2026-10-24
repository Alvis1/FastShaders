import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  BACKGROUND_HEADING,
  BACKGROUND_ITEMS,
  backgroundMissing,
  buildBackgroundRecord,
  type BackgroundAnswers,
} from './background';
import { PRO_GROUP_HEADINGS, PRO_GROUP_NOTES, PRO_ITEMS, buildProRecord, proMissing } from './proQuestions';
import { CANT_JUDGE, gridKey, otherKey, type QAnswers, type QItem, type QLang, type QText } from './questionItems';
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
  // Asked BEFORE the SUS, in every arm, since the first study packages — kept
  // there for comparability with them and with the pilot, which asked them
  // first too. That order makes them the SUS's immediate context (it protects
  // the self-ratings from the SUS answers, not the reverse), so a context
  // effect on the SUS cannot be ruled out; the paper says so.
  const [background, setBackground] = useState<BackgroundAnswers>({});
  // The professional block — only in the /evalpro arm, AFTER SUS item 10, so
  // every arm reaches the SUS the same way (proQuestions.ts).
  const [pro, setPro] = useState<QAnswers>({});
  // The UI language each experience / professional answer was given in,
  // keyed like the answers (answerLanguage.ts says why Submit's is not enough).
  const backgroundLangRef = useRef<Record<string, QLang>>({});
  const proAnswerLangRef = useRef<Record<string, QLang>>({});
  // Set by a Submit press on an incomplete form: every unanswered question is
  // then marked, and the first one is scrolled into view.
  const [showMissing, setShowMissing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
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
  // Every required answer still missing, as the `data-q` keys the form's rows
  // carry, in screen order: experience, SUS, then the professional block.
  const missing = useMemo(() => [
    ...backgroundMissing(background).map((k) => `bg-${k}`),
    ...responses.flatMap((r, i) => (r == null ? [`sus-${i}`] : [])),
    ...(proAsked ? proMissing(pro).map((k) => `pro-${k}`) : []),
  ], [background, responses, pro, proAsked]);
  const complete = missing.length === 0;
  const missingSet = useMemo(() => new Set(missing), [missing]);
  const isMissing = (key: string) => showMissing && missingSet.has(key);
  // One block = its answers, their languages and the name prefix its radios
  // share; the renderer below draws either block from it.
  interface Block { prefix: string; answers: QAnswers; set: (key: string, value: QAnswers[string]) => void }
  const bgBlock: Block = {
    prefix: 'bg',
    answers: background,
    set: (key, value) => {
      backgroundLangRef.current[key] = language;
      setBackground((prev) => ({ ...prev, [key]: value }));
    },
  };
  const proBlock: Block = {
    prefix: 'pro',
    answers: pro,
    set: (key, value) => {
      proAnswerLangRef.current[key] = language;
      setPro((prev) => ({ ...prev, [key]: value }));
    },
  };

  // A press on Submit while answers are missing: mark them all and take the
  // participant to the first one. Submit is aria-disabled then, not disabled,
  // so the press arrives and can explain itself (a disabled button's only
  // explanation was a hover tooltip, which touch never shows).
  const showFirstMissing = () => {
    setShowMissing(true);
    const first = missing[0];
    if (!first) return;
    const row = panelRef.current?.querySelector<HTMLElement>(`[data-q="${first}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
  };

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
    const proLangs = { ...proAnswerLangRef.current };
    const bgLangs = { ...backgroundLangRef.current };
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
      background: buildBackgroundRecord(background, bgLangs),
      ...(proAsked ? { professional: buildProRecord(pro, proLangs) } : {}),
      itemsVersion: 'brooke-1996-item8-awkward',
      items: filled.map((response, i) => {
        const itemLanguage = answeredIn.perItem[i];
        const statements = itemLanguage === 'lv' ? SUS_ITEMS_LV : SUS_ITEMS_EN;
        return { n: i + 1, item: statements[i], language: itemLanguage, response };
      }),
      score,
      // ALWAYS present ('' when left empty), so an empty answer is told apart
      // from a package made before the box existed.
      comment: comment.trim(),
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
          // Present only where the consent asked (every arm but /evalpro).
          ...(session?.ageConfirmed ? { ageConfirmed: true } : {}),
          // The code given at Agree. The questionnaire's field stays editable
          // (a mistyped code can be fixed), so the package keeps both and
          // says when they differ (consent-12).
          participantAtConsent: session?.participant ?? '',
          ...(session && trimmedParticipant !== session.participant ? { participantEdited: true } : {}),
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

  const lang: QLang = language === 'lv' ? 'lv' : 'en';
  const qStr = (text: QText) => text[lang];
  // The data-q / aria-invalid pair every required row wears.
  const rowMarks = (key: string) => ({ 'data-q': key, 'aria-invalid': isMissing(key) || undefined });

  const agreeStrip = (b: Block, key: string, labelId: string, cantJudge?: boolean) => (
    <span className="sus-modal__scale" role="radiogroup" aria-labelledby={labelId}>
      {[1, 2, 3, 4, 5].map((v) => (
        <label key={v} title={v === 1 ? anchorLow : v === 5 ? anchorHigh : undefined}>
          <input
            type="radio"
            name={`${b.prefix}-${key}`}
            value={v}
            checked={b.answers[key] === v}
            disabled={busy}
            onChange={() => b.set(key, v)}
          />
          {v}
        </label>
      ))}
      {cantJudge && (
        <label className="sus-modal__na">
          <input
            type="radio"
            name={`${b.prefix}-${key}`}
            value="na"
            checked={b.answers[key] === 'na'}
            disabled={busy}
            onChange={() => b.set(key, 'na')}
          />
          {qStr(CANT_JUDGE)}
        </label>
      )}
    </span>
  );

  const optionStrip = (b: Block, key: string, labelId: string, options: readonly { id: string; en: string; lv: string }[]) => (
    <span className="sus-modal__scale sus-modal__scale--wide" role="radiogroup" aria-labelledby={labelId}>
      {options.map((o) => (
        <label key={o.id}>
          <input
            type="radio"
            name={`${b.prefix}-${key}`}
            value={o.id}
            checked={b.answers[key] === o.id}
            disabled={busy}
            onChange={() => b.set(key, o.id)}
          />
          <span className="sus-modal__level-label">{qStr(o)}</span>
        </label>
      ))}
    </span>
  );

  // One renderer for both blocks (questionItems.ts): the experience block
  // before the SUS and the professional block after item 10.
  const renderBlock = (
    items: readonly QItem[],
    b: Block,
    headings: Record<string, QText>,
    notes: Partial<Record<string, QText>> = {},
  ) => {
    let group: string | null = null;
    return items.map((q) => {
      const head: ReactNode[] = [];
      if (q.group !== group) {
        group = q.group;
        const note = notes[q.group];
        head.push(
          <div className="sus-modal__section-head" key={`h-${q.group}`}>{qStr(headings[q.group])}</div>,
        );
        if (note) head.push(<div className="csv-import-modal__message" key={`n-${q.group}`}>{qStr(note)}</div>);
        if (q.kind === 'agree') {
          head.push(
            <div className="sus-modal__anchors" aria-hidden="true" key={`a-${q.group}`}>
              <span>1 — {anchorLow}</span>
              <span>5 — {anchorHigh}</span>
            </div>,
          );
        }
      }
      const labelId = `${b.prefix}-item-${q.id}`;
      let body: ReactNode;
      if (q.kind === 'agree') {
        body = (
          <div className="sus-modal__item" {...rowMarks(`${b.prefix}-${q.id}`)}>
            <span className="sus-modal__statement" id={labelId}>{qStr(q.question)}</span>
            {agreeStrip(b, q.id, labelId, q.cantJudge)}
          </div>
        );
      } else if (q.kind === 'choice') {
        const otherOn = q.otherId != null && b.answers[q.id] === q.otherId;
        body = (
          <div className="sus-modal__pro-scale" {...rowMarks(`${b.prefix}-${q.id}`)}>
            <span className="sus-modal__statement" id={labelId}>{qStr(q.question)}</span>
            {optionStrip(b, q.id, labelId, q.options)}
            {otherOn && (
              <input
                type="text"
                className="sus-modal__followup-input"
                aria-label={q.otherHint ? qStr(q.otherHint) : undefined}
                placeholder={q.otherHint ? qStr(q.otherHint) : undefined}
                value={typeof b.answers[otherKey(q)] === 'string' ? (b.answers[otherKey(q)] as string) : ''}
                maxLength={120}
                disabled={busy}
                onChange={(e) => b.set(otherKey(q), e.target.value)}
              />
            )}
          </div>
        );
      } else if (q.kind === 'grid') {
        body = (
          <div className="sus-modal__pro-scale">
            <span className="sus-modal__statement">{qStr(q.question)}</span>
            {q.rows.map((r) => {
              const key = gridKey(q, r);
              const rowId = `${b.prefix}-item-${q.id}-${r.id}`;
              const writeIn = q.otherRowId === r.id && b.answers[key] === 'yes';
              return (
                <div className="sus-modal__pro-row" key={r.id} {...rowMarks(`${b.prefix}-${key}`)}>
                  <span className="sus-modal__pro-row-label" id={rowId}>{qStr(r)}</span>
                  {optionStrip(b, key, rowId, q.columns)}
                  {writeIn && (
                    <input
                      type="text"
                      className="sus-modal__followup-input"
                      aria-label={q.otherHint ? qStr(q.otherHint) : undefined}
                      placeholder={q.otherHint ? qStr(q.otherHint) : undefined}
                      value={typeof b.answers[otherKey(q)] === 'string' ? (b.answers[otherKey(q)] as string) : ''}
                      maxLength={120}
                      disabled={busy}
                      onChange={(e) => b.set(otherKey(q), e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        );
      } else {
        body = (
          <div className="sus-modal__pro-scale">
            <label className="sus-modal__statement" htmlFor={`${b.prefix}-${q.id}`}>{qStr(q.question)}</label>
            <input
              id={`${b.prefix}-${q.id}`}
              type="text"
              className="sus-modal__followup-input"
              value={typeof b.answers[q.id] === 'string' ? (b.answers[q.id] as string) : ''}
              maxLength={300}
              disabled={busy}
              onChange={(e) => b.set(q.id, e.target.value)}
            />
          </div>
        );
      }
      return [...head, <div key={q.id}>{body}</div>];
    });
  };

  return createPortal(
    <div className="csv-import-modal__backdrop">
      <div
        ref={panelRef}
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
          {t('Every question with answer options is required; the text boxes are optional.', language)}
        </div>

        <div className="sus-modal__meta">
          <div className="eval-consent__code-row">
            <label htmlFor="sus-participant">{t('Participant code (from the researcher):', language)}</label>
            <input
              id="sus-participant"
              type="text"
              value={participant}
              maxLength={40}
              placeholder="P01"
              aria-describedby="sus-participant-hint"
              disabled={busy}
              onChange={(e) => setParticipant(e.target.value)}
            />
          </div>
          <div className="sus-modal__progress">
            {answered}/{SUS_ITEM_COUNT}
          </div>
        </div>
        <div className="sus-modal__hint" id="sus-participant-hint">
          {t('Type the code the researcher gave you, not your name.', language)}
        </div>

        {/* The experience block — BEFORE the SUS in every arm, as it has been
            since the first packages (background.ts says what that order does
            and does not protect). */}
        {renderBlock(BACKGROUND_ITEMS, bgBlock, { experience: BACKGROUND_HEADING })}

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
            <div className="sus-modal__item" key={i} {...rowMarks(`sus-${i}`)}>
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

        {proAsked && renderBlock(PRO_ITEMS, proBlock, PRO_GROUP_HEADINGS, PRO_GROUP_NOTES)}

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
        {!busy && !complete && (
          <div className={`sus-modal__unanswered${showMissing ? ' sus-modal__unanswered--shown' : ''}`} role="status">
            {fillTemplate(t('Unanswered questions: {n}', language), { n: String(missing.length) })}
          </div>
        )}
        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" disabled={busy} onClick={onClose}>
            {t('Back to the editor', language)}
          </button>
          {/* aria-disabled, not disabled, while answers are missing: the press
              must arrive so it can take the participant to the first gap. */}
          <button
            type="button"
            className="csv-import-modal__button csv-import-modal__button--yes"
            disabled={busy}
            aria-disabled={!complete || undefined}
            onClick={complete ? handleSubmit : showFirstMissing}
          >
            {t('Submit', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
