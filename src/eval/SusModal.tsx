import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
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
import { collectDevice, costTableProvenance } from './evalContext';
import { capturePreviewShot } from './previewShot';
import { buildEvalPackageEntries, evalZipFileName } from './evalPackage';
import { EVAL_UPLOAD_URL, uploadEvalPackage, type EvalUploadResult } from './evalUpload';
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
 * telemetry + the shader + session metadata) downloads, and a prefilled
 * mailto opens — `mailto:` cannot carry attachments and the CSP blocks
 * uploads, so the mail body carries the headline numbers and asks the
 * participant to attach the just-downloaded file. The researcher can always
 * collect the downloaded zip from the machine instead.
 *
 * Cancel (Close/Escape/backdrop) returns to the session — nothing ends until
 * Submit.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

interface DoneState {
  fileName: string;
  zipBytes: Uint8Array;
  mailto: string;
  failedChecks: QualityCheck[];
  /** Delivery option B: 'pending' while in flight; 'disabled' = not configured. */
  upload: EvalUploadResult | 'pending';
}

function downloadBytes(fileName: string, bytes: Uint8Array): void {
  const buf = new Uint8Array(bytes).buffer;
  const blob = new Blob([buf], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
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
  const [otherEditors, setOtherEditors] = useState('');
  // The professional block — only in the /evalpro arm.
  const [pro, setPro] = useState<ProAnswers>({});
  const submittingRef = useRef(false);
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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
    submittingRef.current = true;
    const filled = responses.map((r) => r ?? 3);
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

    let timezone = '';
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    } catch {
      /* keep '' */
    }

    const env = collectEnv();
    const sus = {
      participant: trimmedParticipant,
      language,
      background: buildBackgroundRecord(background, otherEditors),
      ...(proAsked ? { professional: buildProRecord(pro) } : {}),
      itemsVersion: 'brooke-1996-item8-awkward',
      items: items.map((text, i) => ({ n: i + 1, item: text, response: filled[i] })),
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
          timezone,
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
        device: collectDevice(),
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
    const subject = `FastShaders eval — ${trimmedParticipant || 'participant'} — ${submittedIso.slice(0, 10)}`;
    const bodyLines = [
      `FastShaders evaluation session — ${trimmedParticipant || 'participant'}`,
      '',
      `Active time: ${(summary.activeMs / 60_000).toFixed(1)} min of ${(summary.wallMs / 60_000).toFixed(1)} min`,
      `Nodes added: ${Object.values(summary.nodeAddsByType).reduce((a, b) => a + b, 0)} · connections made: ${summary.counts['edge-connect'] ?? 0}`,
      `Events recorded: ${summary.eventCount}`,
      '',
      `Please attach the file "${fileName}" (in your Downloads folder) to this email, then press Send.`,
    ];
    const mailto = buildMailtoUrl(EVAL_STUDY_EMAIL, subject, bodyLines.join('\n'));

    // Delivery option B (fire-and-forget): the download above already happened
    // — the upload is IN ADDITION, and every failure mode degrades to the
    // attach-it-yourself instructions the thank-you screen shows anyway. The
    // disabled state is decided synchronously so "Sending…" never flashes on
    // the default (no-endpoint) configuration.
    setDone({
      fileName,
      zipBytes,
      mailto,
      failedChecks: quality.filter((q) => !q.ok),
      upload: EVAL_UPLOAD_URL ? 'pending' : 'disabled',
    });
    if (EVAL_UPLOAD_URL) {
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
    return createPortal(
      <div className="csv-import-modal__backdrop" onClick={onClose}>
        <div
          className="csv-import-modal__panel eval-modal__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="eval-done-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="csv-import-modal__title" id="eval-done-title">
            {t('Thank you!', language)}
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
            // The automatic transfer is the only step that can fail silently
            // (offline room, server down), so it says so plainly and points at
            // the copy that always exists: the file downloaded at submit. The
            // no-endpoint configuration lands here too, minus the failure line.
            <>
              <div className={done.upload === 'failed' ? 'eval-done__warn' : 'csv-import-modal__message'}>
                {done.upload === 'failed' && <>{t('Upload failed.', language)} </>}
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
                done.upload === 'failed' ? ' csv-import-modal__button--yes' : ''
              }`}
              onClick={() => downloadBytes(done.fileName, done.zipBytes)}
            >
              {t('Download', language)}
            </button>
            <button type="button" className="csv-import-modal__button" onClick={onClose}>
              {t('Close', language)}
            </button>
            <a className="csv-import-modal__button csv-import-modal__button--primary" href={done.mailto}>
              {t('Email to researcher', language)}
            </a>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={onClose}>
      <div
        className="csv-import-modal__panel eval-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sus-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="sus-modal-title">
          {t('Before you finish: a short questionnaire', language)}
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
                      onChange={() => setBackground((prev) => ({ ...prev, [it.id]: level }))}
                    />
                    {level + 1}
                  </label>
                ))}
              </span>
            </div>
          ))}
        </div>
        {/* The one question that asks WHICH software. Optional: a participant
            with no such experience has nothing to name. */}
        <label className="sus-modal__followup" htmlFor="bg-other-text">
          {t('Which software? (optional)', language)}
        </label>
        <input
          id="bg-other-text"
          type="text"
          className="sus-modal__followup-input"
          value={otherEditors}
          maxLength={300}
          onChange={(e) => setOtherEditors(e.target.value)}
        />

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
                      onChange={() =>
                        setResponses((prev) => {
                          const next = prev.slice();
                          next[i] = v;
                          return next;
                        })
                      }
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
          onChange={(e) => setComment(e.target.value)}
          rows={3}
        />

        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" onClick={onClose}>
            {t('Back to the editor', language)}
          </button>
          <button
            type="button"
            className="csv-import-modal__button csv-import-modal__button--yes"
            disabled={!complete}
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
