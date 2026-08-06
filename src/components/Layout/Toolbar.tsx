import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useDismiss } from '@/hooks/useDismiss';
import { useLongPress } from '@/hooks/useLongPress';
import { downloadShader } from '@/engine/exportShader';
import { FeedbackModal } from '@/components/Modals/FeedbackModal';
import { WorkFolder } from './WorkFolder';
import { t } from '@/i18n';
import './Toolbar.css';

const CONTACT = {
  name: 'Alvis Misjuns',
  email: 'alvis.misjuns@va.lv',
  website: 'alvismisjuns.lv',
  websiteUrl: 'https://alvismisjuns.lv',
};

/**
 * Desktop-build downloads for the "Download app" dropdown. The `/releases/latest/
 * download/` URLs are permanent GitHub redirects to the newest release, so
 * the app always offers the current build with no per-release code change —
 * but that only works because the release workflow uploads the assets under
 * these FIXED names (see .github/workflows/release.yml); keep the two lists
 * in sync. Plain anchors: GitHub serves release assets with
 * Content-Disposition: attachment, and CSP doesn't gate navigation.
 */
const RELEASE_DOWNLOAD_BASE = 'https://github.com/Alvis1/FastShaders/releases/latest/download';
const DESKTOP_DOWNLOADS = [
  { key: 'win', os: 'Windows', detail: 'installer (.exe)', file: 'FastShaders-Windows-Setup.exe' },
  { key: 'win-portable', os: 'Windows', detail: 'portable (.zip, no install)', file: 'FastShaders-Windows-Portable.zip' },
  { key: 'mac', os: 'macOS', detail: 'disk image (.dmg)', file: 'FastShaders-macOS.dmg' },
];

/** Result shape of the desktop bench-server commands (src-tauri/src/bench_server.rs). */
type BenchServerInfo = { url: string; ip: string; port: number };

/**
 * Invoke a Tauri command through the `withGlobalTauri` bridge. Only called
 * from `__FS_DESKTOP__` code paths, where the wrapper injects the global;
 * the rejection covers a plain-browser run of a desktop bundle.
 */
function benchInvoke<T>(cmd: string): Promise<T> {
  const bridge = window.__TAURI__;
  if (!bridge) return Promise.reject(new Error('Desktop bridge unavailable'));
  return bridge.core.invoke<T>(cmd);
}

/** Tauri command failures reject with a plain string (Result<_, String>). */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Toolbar() {
  const shaderName = useAppStore((s) => s.shaderName);
  const setShaderName = useAppStore((s) => s.setShaderName);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const codeEditorTheme = useAppStore((s) => s.codeEditorTheme);
  const setCodeEditorTheme = useAppStore((s) => s.setCodeEditorTheme);
  const previewMesh = useAppStore((s) => s.previewMesh);
  const exportIncludeMesh = useAppStore((s) => s.exportIncludeMesh);
  const setExportIncludeMesh = useAppStore((s) => s.setExportIncludeMesh);
  const isDark = codeEditorTheme === 'vs-dark';

  const [contactOpen, setContactOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLButtonElement>(null);

  const [localOpen, setLocalOpen] = useState(false);
  const localRef = useRef<HTMLDivElement>(null);

  // EXPORT settings popover, opened by right-click on the EXPORT button.
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  // Touch/pen can't right-click, so a long-press opens the same popover. The
  // finger lift then still fires the button's click — which is the DOWNLOAD —
  // so the long-press latches a flag that swallows exactly that one click.
  const suppressExportClickRef = useRef(false);

  // Feedback composer. Local state rather than a store field: it is transient
  // UI opened from exactly one place, and the modal portals itself to
  // document.body so nothing here constrains where it paints.
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // VR bench popover (desktop builds only — the button is behind
  // __FS_DESKTOP__, so this state is inert on the web).
  const [vrOpen, setVrOpen] = useState(false);
  const [vrInfo, setVrInfo] = useState<BenchServerInfo | null>(null);
  const [vrBusy, setVrBusy] = useState(false);
  const [vrError, setVrError] = useState<string | null>(null);
  const vrRef = useRef<HTMLDivElement>(null);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setShaderName(e.target.value);
    },
    [setShaderName]
  );

  // Close the contact popover on outside click or Escape
  useDismiss(contactOpen, setContactOpen, [popoverRef, brandRef]);

  // Close the Local (desktop download) dropdown on outside click or Escape.
  // One wrapper ref covers both the trigger and the popover.
  useDismiss(localOpen, setLocalOpen, [localRef]);

  // Close the export-settings popover on outside click or Escape.
  useDismiss(exportOpen, setExportOpen, [exportRef]);

  useLongPress(exportBtnRef, () => {
    suppressExportClickRef.current = true;
    // If the finger lifts outside the button, no click ever consumes the
    // latch — clear it at the next pointerdown so a later real tap isn't
    // swallowed (that pointerdown precedes its own click).
    document.addEventListener(
      'pointerdown',
      () => { suppressExportClickRef.current = false; },
      { once: true, capture: true },
    );
    setExportOpen(true);
  });

  // Close the VR bench popover on outside click or Escape (the server keeps
  // running — closing the panel must not interrupt a bench on the headset).
  useDismiss(vrOpen, setVrOpen, [vrRef]);

  // Re-sync with the actual server state each time the panel opens — the
  // Rust side owns the truth (e.g. after a failed start or an app reload).
  useEffect(() => {
    if (!vrOpen || !__FS_DESKTOP__) return;
    benchInvoke<BenchServerInfo | null>('bench_server_status')
      .then(setVrInfo)
      .catch(() => {
        /* bridge unavailable — keep whatever we last knew */
      });
  }, [vrOpen]);

  const startVrServer = useCallback(() => {
    setVrBusy(true);
    setVrError(null);
    benchInvoke<BenchServerInfo>('bench_server_start')
      .then(setVrInfo)
      .catch((e) => setVrError(errorText(e)))
      .finally(() => setVrBusy(false));
  }, []);

  const stopVrServer = useCallback(() => {
    setVrBusy(true);
    setVrError(null);
    benchInvoke<void>('bench_server_stop')
      .then(() => setVrInfo(null))
      .catch((e) => setVrError(errorText(e)))
      .finally(() => setVrBusy(false));
  }, []);

  // Stable identity: the modal binds its Escape listener against this.
  const closeFeedback = useCallback(() => setFeedbackOpen(false), []);

  const handleCopy = useCallback(async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      // Auto-revert the "Copied" label so the next copy still gives feedback
      window.setTimeout(() => {
        setCopiedKey((k) => (k === key ? null : k));
      }, 1500);
    } catch {
      // Clipboard API can fail in insecure contexts; silent fallback is fine here
    }
  }, []);

  return (
    <div className="toolbar">
      <div className="toolbar__left">
        <button
          ref={brandRef}
          type="button"
          className="toolbar__brand"
          onClick={() => setContactOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={contactOpen}
          title={t('About / Contact', language)}
        >
          FastShaders
        </button>
        <span className="toolbar__version">v{__APP_VERSION__}</span>
        {contactOpen && (
          <div
            ref={popoverRef}
            className="toolbar__contact-popover"
            role="dialog"
            aria-label={t('Contact', language)}
          >
            <div className="toolbar__contact-label">{t('Author', language)}</div>
            <div className="toolbar__contact-name">{CONTACT.name}</div>
            <div className="toolbar__contact-row">
              <a
                className="toolbar__contact-link"
                href={`mailto:${CONTACT.email}`}
              >
                {CONTACT.email}
              </a>
              <button
                type="button"
                className="toolbar__contact-copy"
                onClick={() => handleCopy('email', CONTACT.email)}
              >
                {copiedKey === 'email' ? t('Copied', language) : t('Copy', language)}
              </button>
            </div>
            <div className="toolbar__contact-row">
              <a
                className="toolbar__contact-link"
                href={CONTACT.websiteUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {CONTACT.website}
              </a>
              <button
                type="button"
                className="toolbar__contact-copy"
                onClick={() => handleCopy('web', CONTACT.websiteUrl)}
              >
                {copiedKey === 'web' ? t('Copied', language) : t('Copy', language)}
              </button>
            </div>
            <div className="toolbar__contact-funding">
              {t(
                'This research was supported by the project No. 1.1.1.8/1/24/I/001 VeA and ViA Doctoral Grants, co-funded by the European Union (European Regional Development Fund) and the Latvian state budget within the European Union Cohesion Policy Programme 2021–2027.',
                language,
              )}
            </div>
            <div className="toolbar__contact-logos">
              <img
                className="toolbar__contact-logo toolbar__contact-logo--eu"
                src={`${import.meta.env.BASE_URL}logos/eu-cofunded.svg`}
                alt="Co-funded by the European Union"
                title="Co-funded by the European Union (European Regional Development Fund)"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
              <img
                className="toolbar__contact-logo toolbar__contact-logo--nap"
                src={`${import.meta.env.BASE_URL}logos/nap2027.svg`}
                alt="National Development Plan 2027 (Nacionālais attīstības plāns 2027)"
                title="National Development Plan 2027 (Nacionālais attīstības plāns 2027)"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
              <img
                className="toolbar__contact-logo"
                src={`${import.meta.env.BASE_URL}logos/via.svg`}
                alt="Vidzeme University of Applied Sciences (ViA)"
                title="Vidzeme University of Applied Sciences (ViA)"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </div>
          </div>
        )}
      </div>
      <div className="toolbar__center">
        <span className="toolbar__name-label">{t('Name:', language)}</span>
        <input
          className="toolbar__name-input"
          type="text"
          value={shaderName}
          onChange={handleNameChange}
          placeholder={t('Shader name...', language)}
          spellCheck={false}
        />
        <div className="toolbar__export-wrap" ref={exportRef}>
          {/* No aria-haspopup here: the button's ACTIVATION is the download —
              announcing a popup that Enter/Space never opens would send a
              screen-reader user into an unexpected file download. */}
          <button
            ref={exportBtnRef}
            type="button"
            className="toolbar__export"
            onClick={() => {
              if (suppressExportClickRef.current) {
                suppressExportClickRef.current = false;
                return;
              }
              downloadShader();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setExportOpen((o) => !o);
            }}
            title={`${t('Download the shader — .js with the FastShaders project embedded (drag it back in to continue); becomes a .zip with the image and 3D-model files alongside when the graph embeds images or a custom preview mesh is loaded', language)}. ${
              previewMesh && !exportIncludeMesh
                ? t('The 3D model is currently excluded from the export — right-click to change.', language)
                : t('Right-click for export settings.', language)
            }`}
          >
            {t('Export', language)}
          </button>
          {exportOpen && (
            <div
              className="toolbar__local-popover toolbar__export-popover"
              role="dialog"
              aria-label={t('Export settings', language)}
            >
              <div className="toolbar__local-header">
                <span className="toolbar__contact-label">{t('Export settings', language)}</span>
              </div>
              <label
                className={`toolbar__export-check${previewMesh ? '' : ' toolbar__export-check--off'}`}
              >
                <input
                  type="checkbox"
                  checked={exportIncludeMesh}
                  disabled={!previewMesh}
                  onChange={(e) => setExportIncludeMesh(e.target.checked)}
                />
                <span>
                  {t('Include the preview 3D model', language)}
                  {previewMesh ? ` (${previewMesh.name})` : ''}
                </span>
              </label>
              <div className="toolbar__local-note">
                {previewMesh
                  ? t('The model ships inside the export .zip under models/ — untick to export the shader alone.', language)
                  : t('No custom 3D model is loaded — drop a .obj/.glb/.gltf onto the 3D preview first.', language)}
              </div>
            </div>
          )}
        </div>
        {/* Desktop-only: the native-folder Save/load control. The web build
            can't offer it — see work_folder.rs for why the webview FS APIs
            don't cover this. */}
        {__FS_DESKTOP__ && <WorkFolder />}
      </div>
      <div className="toolbar__right">
        {/* Hard reload of the tab. Safe to offer without a confirm: the graph
            autosaves to fs:graph (plus every UI pref to its own key), so a
            reload restores the session rather than discarding it. The one
            exception is the session-only preview mesh, which is deliberately
            never persisted — hence the warning in the tooltip. */}
        <button
          type="button"
          className="toolbar__sc-link toolbar__refresh"
          onClick={() => window.location.reload()}
          title={t('Reload the page (a dropped preview model is not kept)', language)}
          aria-label={t('Reload the page', language)}
        >
          {/* Inline SVG, not a glyph: the app self-hosts a woff2 SUBSET of
              Inter, so ↻/⟳ are not guaranteed to be in the font offline. */}
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
          </svg>
        </button>
        <a
          className="toolbar__sc-link"
          href={`${import.meta.env.BASE_URL}podest.html`}
          target="_blank"
          rel="noreferrer noopener"
          title="Open Podest — full-screen shader player (drop .js/.tsl shaders, .glb models, .zip)"
          aria-label="Open Podest"
        >
          P
        </a>
        {/* ShaderCarousel is WebGPU-only and excluded from the FS_DESKTOP
            webview bundle — the link would 404 there. The desktop build
            instead ships it as a Tauri resource and serves it over LAN for
            headsets: the VR popover below. */}
        {!__FS_DESKTOP__ && (
          <a
            className="toolbar__sc-link"
            href={`${import.meta.env.BASE_URL}ShaderCarousel/`}
            target="_blank"
            rel="noreferrer noopener"
            title="Open ShaderCarousel — viewer & benchmark suite"
            aria-label="Open ShaderCarousel"
          >
            SC
          </a>
        )}
        {/* Language toggle (English ⇄ Latvian). Latvian is a display-only
            overlay — see src/i18n. Shows "LV" and pressed-highlights when
            Latvian is active. */}
        <button
          type="button"
          className={`toolbar__sc-link${language === 'lv' ? ' toolbar__sc-link--active' : ''}`}
          onClick={() => setLanguage(language === 'lv' ? 'en' : 'lv')}
          aria-pressed={language === 'lv'}
          title={
            language === 'lv'
              ? 'Pārslēgt uz angļu valodu (Switch to English)'
              : 'Pārslēgt uz latviešu valodu (Switch to Latvian)'
          }
          aria-label={t('Switch language', language)}
        >
          LV
        </button>
        {/* Inside the desktop app, offering a download of itself makes no
            sense — __FS_DESKTOP__ builds hide the button. */}
        {!__FS_DESKTOP__ && (
          <div className="toolbar__local" ref={localRef}>
            <button
              type="button"
              className="toolbar__sc-link"
              onClick={() => setLocalOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={localOpen}
              title={t('Download the offline desktop app (Windows / macOS)', language)}
            >
              {t('Download app', language)}
            </button>
            {localOpen && (
              <div
                className="toolbar__local-popover"
                role="menu"
                aria-label={t('Download desktop app', language)}
              >
                <div className="toolbar__local-header">
                  <span className="toolbar__contact-label">{t('Desktop app', language)}</span>
                  <span className="toolbar__version">v{__APP_VERSION__}</span>
                </div>
                {DESKTOP_DOWNLOADS.map((d) => (
                  <a
                    key={d.key}
                    className="toolbar__local-row"
                    href={`${RELEASE_DOWNLOAD_BASE}/${d.file}`}
                    role="menuitem"
                    onClick={() => setLocalOpen(false)}
                  >
                    <span className="toolbar__local-os">{d.os}</span>
                    <span className="toolbar__local-detail">{d.detail}</span>
                  </a>
                ))}
                <div className="toolbar__local-note">
                  {t('Runs fully offline. Rebuilt automatically with every release.', language)}
                </div>
              </div>
            )}
          </div>
        )}
        {__FS_DESKTOP__ && (
          <div className="toolbar__local" ref={vrRef}>
            <button
              type="button"
              className="toolbar__sc-link"
              onClick={() => setVrOpen((o) => !o)}
              aria-haspopup="dialog"
              aria-expanded={vrOpen}
              title="Benchmark on a VR headset — serve ShaderCarousel over your local network"
            >
              VR
            </button>
            {vrOpen && (
              <div
                className="toolbar__local-popover toolbar__vr-popover"
                role="dialog"
                aria-label="Headset benchmark server"
              >
                <div className="toolbar__local-header">
                  <span className="toolbar__contact-label">Headset benchmark</span>
                  {vrInfo && <span className="toolbar__vr-live">serving</span>}
                </div>
                {!vrInfo ? (
                  <>
                    <div className="toolbar__local-note toolbar__vr-note">
                      Serves the bundled ShaderCarousel benchmark suite to
                      devices on your Wi-Fi (e.g. a Quest headset). Read-only;
                      nothing else on this machine is exposed.
                    </div>
                    <button
                      type="button"
                      className="toolbar__vr-action"
                      onClick={startVrServer}
                      disabled={vrBusy}
                    >
                      {vrBusy ? 'Starting…' : 'Start LAN server'}
                    </button>
                    <div className="toolbar__local-note toolbar__vr-note">
                      Your OS may ask to allow incoming network connections on
                      the first start.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="toolbar__local-note toolbar__vr-note">
                      Open on the headset (same network):
                    </div>
                    <div className="toolbar__vr-url-row">
                      <code className="toolbar__vr-url">{vrInfo.url}</code>
                      <button
                        type="button"
                        className="toolbar__contact-copy"
                        onClick={() => handleCopy('vr-url', vrInfo.url)}
                      >
                        {copiedKey === 'vr-url' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div className="toolbar__vr-hint">
                      <strong>Benches won’t start / can’t enter VR?</strong>{' '}
                      Browsers enable WebXR and WebGPU only on secure origins,
                      and a plain LAN address isn’t one. One-time fix per
                      headset — either:
                      <ol>
                        <li>
                          In the headset browser open <code>chrome://flags</code>,
                          search “Insecure origins treated as secure”, add{' '}
                          <code>
                            http://{vrInfo.ip}:{vrInfo.port}
                          </code>
                          , then relaunch the browser.
                        </li>
                        <li>
                          Or with USB developer mode:{' '}
                          <code>
                            adb reverse tcp:{vrInfo.port} tcp:{vrInfo.port}
                          </code>{' '}
                          and open{' '}
                          <code>http://localhost:{vrInfo.port}/</code> on the
                          headset instead.
                        </li>
                      </ol>
                    </div>
                    <button
                      type="button"
                      className="toolbar__vr-action"
                      onClick={stopVrServer}
                      disabled={vrBusy}
                    >
                      {vrBusy ? 'Stopping…' : 'Stop server'}
                    </button>
                  </>
                )}
                {vrError && <div className="toolbar__vr-error">{vrError}</div>}
              </div>
            )}
          </div>
        )}
        {/* App-wide dark/light toggle (moved here from the code panel's tab
            bar) — still the ONE dark-mode control: themes Monaco AND stamps
            data-theme on <html> via setCodeEditorTheme. */}
        <button
          type="button"
          className="toolbar__sc-link toolbar__theme-toggle"
          onClick={() => setCodeEditorTheme(isDark ? 'vs' : 'vs-dark')}
          title={isDark ? t('Switch to light mode', language) : t('Switch to dark mode', language)}
          aria-label={t('Toggle dark mode', language)}
        >
          {isDark ? '☼' : '☾'}
        </button>
        {/* Feedback — the one deliberately loud control in the chrome. Sits in
            the far corner and is the only red thing in the toolbar, so a user
            who hit a wall can find it without hunting. Composes a report and
            hands it to the user's mail client; nothing is uploaded (see
            utils/feedbackReport.ts for why a hosted form is not an option). */}
        <button
          type="button"
          className="toolbar__sc-link toolbar__feedback"
          onClick={() => setFeedbackOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={feedbackOpen}
          title={t('Send feedback — report a problem or suggest an improvement', language)}
          aria-label={t('Send feedback', language)}
        >
          !
        </button>
      </div>
      <FeedbackModal open={feedbackOpen} onClose={closeFeedback} />
    </div>
  );
}
