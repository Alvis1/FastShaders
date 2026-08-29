import { useEffect, useMemo, useState } from 'react';
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
  const complete = answered === SUS_ITEM_COUNT;

  const handleSubmit = () => {
    if (!complete || done) return;
    const filled = responses.map((r) => r ?? 3);
    const score = computeSusScore(filled);
    const submittedIso = new Date().toISOString();
    const session = readEvalSession();
    const trimmedParticipant = participant.trim() || session?.participant || '';

    // Order matters: the sus-submit + session-end events must be IN the log
    // the package carries, so log first, end the session, then read events.
    evalLog('sus-submit', { language });
    endEvalSession();
    const events = getEvalEvents();
    const summary = deriveSummary(events, { idleThresholdMs: IDLE_THRESHOLD_MS });
    const quality = runQualityChecks(events, summary);

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
        project: collectProject(),
      },
      sus,
      events,
      summary,
      quality,
      shader,
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

    // Submit MEANS submit: open the addressed message straight away rather
    // than leaving it behind a button the participant has to notice. This is
    // a navigation, so it is CSP-exempt and does not unload the page — the
    // thank-you screen stays up behind the mail client, and its "Open email"
    // button remains for the case where no handler is registered. The one
    // step no platform allows us to skip is the attachment: `mailto:` cannot
    // carry files, which is why the download runs first and the body names
    // the file to attach.
    try {
      window.location.href = mailto;
    } catch {
      /* no mail handler — the thank-you screen's button covers it */
    }
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
            {t('Your answers, the shader you made, and the session data were packaged into one file, which has just been downloaded:', language)}
          </div>
          <div className="eval-done__file">{done.fileName}</div>
          {done.failedChecks.length > 0 && (
            <div className="eval-done__warn">
              {t('Some data-quality checks did not pass — please tell the researcher before leaving:', language)}{' '}
              {done.failedChecks.map((q) => q.id).join(', ')}
            </div>
          )}
          {done.upload === 'ok' ? (
            <div className="csv-import-modal__message">
              {t('The package was also sent to the researcher automatically — the email step below is only a backup.', language)}
            </div>
          ) : done.upload === 'pending' ? (
            <div className="csv-import-modal__message">{t('Sending to the researcher…', language)}</div>
          ) : done.upload === 'failed' ? (
            // The automatic transfer is the only step that can fail silently
            // (offline room, server down), so it says so plainly and points at
            // the copy that always exists: the file downloaded at submit.
            <div className="eval-done__warn">
              {t('The package could not be sent automatically. Please make sure the researcher receives the file — it is already in your Downloads folder, and the “Download” button below gives you another copy.', language)}
            </div>
          ) : null}
          <div className="csv-import-modal__message">
            {t('Your email app should have opened with the message ready. Attach the file named above and press Send. If it did not open, use “Open email” below — or simply tell the researcher, the file is in the Downloads folder.', language)}
          </div>
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
              {t('Open email', language)}
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
          {t('Before you finish — 10 quick statements', language)}
        </div>
        <div className="csv-import-modal__message">
          {t('For each statement, mark how much you agree or disagree. Record your immediate response rather than thinking about it for long; if you cannot respond to one, mark the centre point (3).', language)}
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
          {t('Anything else you want to say? (optional)', language)}
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
            title={complete ? undefined : t('Please answer all 10 statements first', language)}
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
