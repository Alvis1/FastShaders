import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useAppStore } from '@/store/useAppStore';
import './Toolbar.css';

const CONTACT = {
  name: 'Alvis Misjuns',
  email: 'alvis.misjuns@va.lv',
  website: 'alvismisjuns.lv',
  websiteUrl: 'https://alvismisjuns.lv',
};

/**
 * Desktop-build downloads for the "Local" dropdown. The `/releases/latest/
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

/**
 * While open, close on a click outside every exempt ref or on Escape.
 * The handlers read the live `refs` array through a render-updated ref, so
 * callers may pass a fresh array literal each render without stale capture.
 */
function useDismiss(
  open: boolean,
  setOpen: (open: boolean) => void,
  refs: RefObject<HTMLElement | null>[]
) {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (refsRef.current.some((r) => r.current?.contains(t))) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
}

export function Toolbar() {
  const shaderName = useAppStore((s) => s.shaderName);
  const setShaderName = useAppStore((s) => s.setShaderName);
  const canUndo = useAppStore((s) => s.past.length > 0);
  const canRedo = useAppStore((s) => s.future.length > 0);

  const [contactOpen, setContactOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLButtonElement>(null);

  const [localOpen, setLocalOpen] = useState(false);
  const localRef = useRef<HTMLDivElement>(null);

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
          title="About / Contact"
        >
          FastShaders
        </button>
        <span className="toolbar__version">v{__APP_VERSION__}</span>
        {contactOpen && (
          <div
            ref={popoverRef}
            className="toolbar__contact-popover"
            role="dialog"
            aria-label="Contact"
          >
            <div className="toolbar__contact-label">Author</div>
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
                {copiedKey === 'email' ? 'Copied' : 'Copy'}
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
                {copiedKey === 'web' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="toolbar__contact-funding">
              This research was supported by the project No. 1.1.1.8/1/24/I/001
              VeA and ViA Doctoral Grants, co-funded by the European Union
              (European Regional Development Fund) and the Latvian state budget
              within the European Union Cohesion Policy Programme 2021–2027.
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
      {/* Undo / redo were keyboard-only with no UI at all — the sole recovery
          path from a destructive action (dropping a project replaces the whole
          graph) was a shortcut users had no way to discover. */}
      <div className="toolbar__history">
        <button
          type="button"
          className="toolbar__history-btn"
          onClick={() => useAppStore.getState().undo()}
          disabled={!canUndo}
          title="Undo (Ctrl+Z / ⌘Z)"
          aria-label="Undo"
        >
          ↶
        </button>
        <button
          type="button"
          className="toolbar__history-btn"
          onClick={() => useAppStore.getState().redo()}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z / ⇧⌘Z)"
          aria-label="Redo"
        >
          ↷
        </button>
      </div>
      <div className="toolbar__center">
        <span className="toolbar__name-label">Shader name:</span>
        <input
          className="toolbar__name-input"
          type="text"
          value={shaderName}
          onChange={handleNameChange}
          placeholder="Shader name..."
          spellCheck={false}
        />
      </div>
      <div className="toolbar__right">
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
              title="Download the offline desktop app (Windows / macOS)"
            >
              Local
            </button>
            {localOpen && (
              <div
                className="toolbar__local-popover"
                role="menu"
                aria-label="Download desktop app"
              >
                <div className="toolbar__local-header">
                  <span className="toolbar__contact-label">Desktop app</span>
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
                  Runs fully offline. Rebuilt automatically with every release.
                </div>
              </div>
            )}
          </div>
        )}
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
      </div>
    </div>
  );
}
