import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, VR_HEADSETS } from '@/store/useAppStore';
import { t } from '@/i18n';
import { countMeshVertices } from '@/utils/previewMesh';
import {
  FEEDBACK_EMAIL,
  buildMailtoUrl,
  buildReportText,
  buildSubject,
  countProject,
  envLines,
  mailtoTooLong,
  previewBackend,
  type FeedbackEnv,
  type FeedbackKind,
  type FeedbackProject,
} from '@/utils/feedbackReport';
import './CsvImportModal.css';
import './FeedbackModal.css';

const KINDS: { id: FeedbackKind; label: string; hint: string }[] = [
  { id: 'bug', label: 'Something is broken', hint: 'What did you do, and what happened instead?' },
  { id: 'idea', label: 'I have an idea', hint: 'What would you like FastShaders to do?' },
  { id: 'comment', label: 'Just a comment', hint: 'Anything you want to say about the tool.' },
];

/**
 * Snapshot the environment facts the report may include. Read once per opening
 * (not per keystroke) so the timestamp doesn't crawl while the user types, and
 * so the details block the user reviews is exactly the text that gets sent.
 *
 * `uiLanguage` is deliberately NOT read here — it can change while the dialog
 * is open, and re-snapshotting on that would restamp the timestamp and yank
 * focus back to the textarea mid-sentence. It is merged in at report time.
 */
function collectEnv(): Omit<FeedbackEnv, 'uiLanguage'> {
  const ua = navigator.userAgent || '';
  // `navigator.platform` is deprecated but universally present, and it is the
  // signal the preview's own force-WebGL2 rule keys on for iPadOS desktop mode.
  const platform = navigator.platform || '';
  const touch = navigator.maxTouchPoints || 0;
  const gpuExposed = (navigator as Navigator & { gpu?: unknown }).gpu != null;
  return {
    version: __APP_VERSION__,
    build: __FS_DESKTOP__ ? 'desktop' : 'web',
    address: `${window.location.origin}${window.location.pathname}`,
    userAgent: ua,
    platform,
    gpuExposed,
    previewBackend: previewBackend(ua, platform, touch, gpuExposed),
    display:
      `${window.screen.width}×${window.screen.height}` +
      ` · window ${window.innerWidth}×${window.innerHeight}` +
      ` · DPR ${window.devicePixelRatio}`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Snapshot the project counts, alongside the environment. Read imperatively
 * from the store rather than through selectors: this runs once per opening,
 * and subscribing the dialog to `nodes`/`edges` would re-render (and re-count,
 * and re-derive the mesh vertex count) on every graph edit behind it.
 *
 * NOTE the vertex count is deliberately computed here and not memoized in the
 * store: it is only ever wanted at this one moment, and a 64 MB model would
 * otherwise be scanned on load for a number nothing else reads.
 */
function collectProject(): FeedbackProject {
  const s = useAppStore.getState();
  const headset = VR_HEADSETS.find((h) => h.id === s.selectedHeadsetId) ?? VR_HEADSETS[0];
  const mesh = s.previewMesh;
  // The preview geometry lives in localStorage (usePersistedState in
  // ShaderPreview), not the store — read the persisted value, which is the
  // same source that survives a reload.
  let geometry = 'sphere';
  try {
    geometry = localStorage.getItem('fs:previewGeometry') || 'sphere';
  } catch {
    /* private mode — the default label is close enough for a report */
  }
  return {
    ...countProject(s.nodes, s.edges),
    totalCost: s.totalCost,
    headset: headset.label,
    budget: headset.maxPoints,
    geometry,
    mesh: mesh
      ? { name: mesh.name, bytes: mesh.bytes.length, vertices: countMeshVertices(mesh) }
      : null,
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Feedback composer. Assembles a plain-text report and hands it off two ways —
 * a `mailto:` link (primary) and the clipboard (fallback). Nothing is uploaded:
 * see `utils/feedbackReport.ts` for why a hosted form is not an option here
 * (the build CSP forbids the POST, and the desktop build has no network).
 *
 * Portalled to `document.body` rather than mounted in `AppLayout` beside the
 * other modals, because the trigger lives in the Toolbar and this keeps the
 * feature self-contained — no store field for what is transient UI state.
 */
export function FeedbackModal({ open, onClose }: Props) {
  const language = useAppStore((s) => s.language);

  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [includeEnv, setIncludeEnv] = useState(true);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  /** Set when the clipboard API is unavailable — reveals a select-all textarea. */
  const [copyFailed, setCopyFailed] = useState(false);
  const [snapshot, setSnapshot] = useState<Omit<FeedbackEnv, 'uiLanguage'> | null>(null);
  const [project, setProject] = useState<FeedbackProject | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const rawRef = useRef<HTMLTextAreaElement>(null);

  // Fresh state each opening: a stale "Copied"/"Opening…" badge from last time
  // would read as confirmation of a report the user hasn't written yet.
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setSent(false);
    setCopyFailed(false);
    setSnapshot(collectEnv());
    setProject(collectProject());
    messageRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const active = KINDS.find((k) => k.id === kind) ?? KINDS[0];
  const trimmed = message.trim();

  const env = useMemo<FeedbackEnv | null>(
    () => (snapshot ? { ...snapshot, uiLanguage: language } : null),
    [snapshot, language],
  );
  const report = useMemo(
    () => (env ? buildReportText({ kind, message, includeEnv, env, project }) : ''),
    [kind, message, includeEnv, env, project],
  );
  const mailto = useMemo(
    () => (env ? buildMailtoUrl(FEEDBACK_EMAIL, buildSubject(kind, env.version), report) : ''),
    [kind, report, env],
  );
  const tooLong = !!mailto && mailtoTooLong(mailto);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Insecure context / denied permission — fall back to letting the user
      // copy by hand rather than failing silently.
      setCopyFailed(true);
      window.setTimeout(() => rawRef.current?.select(), 0);
    }
  };

  if (!open || !env) return null;

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel feedback-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="feedback-modal-title">
          {t('Send feedback', language)}
        </div>
        <div className="csv-import-modal__message">
          {t('This opens your email app with the report ready to send — nothing leaves this computer until you press send there. No mail app? Use “Copy report” and paste it wherever you like.', language)}
        </div>

        <div className="feedback-modal__kinds" role="radiogroup" aria-label={t('Feedback type', language)}>
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={kind === k.id}
              className={`feedback-modal__kind${kind === k.id ? ' feedback-modal__kind--on' : ''}`}
              onClick={() => setKind(k.id)}
            >
              {t(k.label, language)}
            </button>
          ))}
        </div>

        <label className="feedback-modal__field">
          <span className="feedback-modal__label">{t(active.hint, language)}</span>
          <textarea
            ref={messageRef}
            className="feedback-modal__textarea"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={6}
            spellCheck
          />
        </label>

        <label className="feedback-modal__check">
          <input
            type="checkbox"
            checked={includeEnv}
            onChange={(e) => setIncludeEnv(e.target.checked)}
          />
          {t('Include technical details (version, browser, renderer, graph size and cost) — they make problems far easier to track down', language)}
        </label>

        {includeEnv && (
          <details className="feedback-modal__details">
            <summary>{t('Show exactly what is included', language)}</summary>
            <pre className="feedback-modal__env">{envLines(env, project).join('\n')}</pre>
          </details>
        )}

        {tooLong && (
          <div className="feedback-modal__warn">
            {t('This report is too long for an email link — some mail apps would cut it short. Use “Copy report” and paste it into a new message instead.', language)}
          </div>
        )}

        {copyFailed && (
          <>
            <textarea
              ref={rawRef}
              className="feedback-modal__textarea feedback-modal__raw"
              readOnly
              rows={5}
              value={report}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="feedback-modal__warn">
              {t('Copying automatically was blocked — the report is selected above, copy it by hand.', language)}
            </div>
          </>
        )}

        {sent && (
          <div className="feedback-modal__hint">
            {t('Your email app should have opened with the report. If nothing happened, use “Copy report” instead.', language)}
          </div>
        )}

        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" onClick={onClose}>
            {t('Close', language)}
          </button>
          <button
            type="button"
            className="csv-import-modal__button"
            onClick={handleCopy}
            disabled={!trimmed}
          >
            {copied ? t('Copied', language) : t('Copy report', language)}
          </button>
          {/* A real anchor, not a scripted navigation: mail-client handoff is a
              navigation (CSP `form-action` does not gate it), and an <a> is the
              shape every platform's handler registration expects. */}
          <a
            className={`csv-import-modal__button csv-import-modal__button--primary feedback-modal__send${
              trimmed ? '' : ' feedback-modal__send--off'
            }`}
            href={trimmed ? mailto : undefined}
            aria-disabled={!trimmed}
            onClick={(e) => {
              if (!trimmed) {
                e.preventDefault();
                return;
              }
              setSent(true);
            }}
          >
            {t('Open email', language)}
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
