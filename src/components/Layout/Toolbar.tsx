import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useDismiss } from '@/hooks/useDismiss';
import { useLongPress } from '@/hooks/useLongPress';
import { hardReload } from '@/utils/hardReload';
import { downloadShader } from '@/engine/exportShader';
import { FeedbackModal } from '@/components/Modals/FeedbackModal';
import { PalettesModal } from '@/components/Modals/PalettesModal';
import { isEvalMode } from '@/eval/evalMode';
import { SusModal } from '@/eval/SusModal';
import { EvalFinishModal } from '@/eval/EvalFinishModal';
import { WorkFolder } from './WorkFolder';
import { formatCategoryLabel, t } from '@/i18n';
import { CATEGORIES } from '@/registry/nodeCategories';
import { OPTIONAL_CATEGORIES, type OptionalCategory } from '@/registry/optionalCategories';
import { foldOverflow, OVERFLOW_INITIAL } from './toolbarOverflow';
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
 * these FIXED names (see .github/workflows/release.yml); keep this list in
 * sync with the workflow's upload names. Plain anchors: GitHub serves release
 * assets with Content-Disposition: attachment, and CSP doesn't gate navigation.
 */
const RELEASE_DOWNLOAD_BASE = 'https://github.com/Alvis1/FastShaders/releases/latest/download';
const DESKTOP_DOWNLOADS = [
  { key: 'win', os: 'Windows', detail: 'installer (.exe)', file: 'FastShaders-Windows-Setup.exe' },
  { key: 'win-portable', os: 'Windows', detail: 'portable (.zip, no install)', file: 'FastShaders-Windows-Portable.zip' },
  { key: 'mac', os: 'macOS', detail: 'disk image (.dmg)', file: 'FastShaders-macOS.dmg' },
];

/** Width of the right-click preferences popover — kept in step with its CSS
 *  `width` so the on-screen clamp below matches the box actually painted. */
const PREFS_W = 200;
/** Its height, for the same clamp: the CSS padding (2 × `--space-3`) plus one
 *  checkbox row per setting and a `--space-2` gap between rows. Derived from
 *  the row count so adding a setting cannot leave the box hanging off the
 *  bottom of a short window. */
const PREFS_ROWS = 1 + OPTIONAL_CATEGORIES.length;
const PREFS_H = 24 + PREFS_ROWS * 20 + (PREFS_ROWS - 1) * 8;

/**
 * The right-click list's LIBRARY rows — the palette's optional categories
 * (registry/optionalCategories.ts), labelled exactly as their content-browser
 * tabs are, so the switch and the thing it shows share a name. Each hint is
 * the row's `title`, the "one line you scan, the detail on hover" rule.
 */
const OPTIONAL_CATEGORY_HINTS: Readonly<Record<OptionalCategory, string>> = {
  texture: 'Show the Textures tab in the asset browser, and its textures in search.',
  sdf: 'Show the Distance fields tab, and its nodes in the Add-node menu and search.',
};

/**
 * True when a press at `el` must NOT open the preferences list — shared by
 * the right-click and the touch long-press, so the two gestures can never
 * disagree about who owns a spot on the bar. The name field needs its native
 * cut/copy/paste menu (a text input's context menu is the one place users
 * genuinely rely on the OS one), and EXPORT / the reload button / the ☰ menu
 * own their gesture for their own popovers — EXPORT's handler preventDefaults
 * but does NOT stopPropagation, so without this both would open at once.
 * `.toolbar__reload-wrap` is redundant with `.toolbar__local` (the reload
 * wrapper carries both) and is named anyway, so the reason it is excluded is
 * legible from here. APPEND only: trackpadScroll.test.ts pins these strings
 * with regexes anchored at the opening quote.
 */
function prefsClaimedElsewhere(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.closest('input, textarea, select, [contenteditable="true"]')) return true;
  return !!el.closest('.toolbar__export-wrap, .toolbar__local, .toolbar__overflow, .toolbar__reload-wrap');
}

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

  // Eval mode only: EXPORT asks "finished or continuing?" before it ends the
  // study session (see eval/EvalFinishModal). Inert in the normal app.
  const [evalFinishOpen, setEvalFinishOpen] = useState(false);

  // Palette manager — same precedent as the feedback composer above, and for
  // the same two reasons. The store-queue pattern (CsvImportModal,
  // LimitModal) exists because those dialogs are raised by non-UI code and can
  // stack; this one has a single button and no queue.
  const [palettesOpen, setPalettesOpen] = useState(false);

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
  const closeEvalFinish = useCallback(() => setEvalFinishOpen(false), []);
  /** Finish → the questionnaire; the package is built when it is submitted. */
  const finishEvalSession = useCallback(() => {
    setEvalFinishOpen(false);
    setFeedbackOpen(true);
  }, []);
  const closePalettes = useCallback(() => setPalettesOpen(false), []);

  // ── Right-click preferences popup ─────────────────────────────────────────
  // The toolbar's own context menu. It exists for `trackpadScroll`, which has
  // to be a setting rather than a device sniff (see the store field and
  // NodeEditor's wheel handler for why guessing was tried and reverted), and is
  // the natural home for any later app-wide input preference.
  const [prefsAt, setPrefsAt] = useState<{ x: number; y: number } | null>(null);
  const prefsRef = useRef<HTMLDivElement>(null);
  const trackpadScroll = useAppStore((s) => s.trackpadScroll);
  const setTrackpadScroll = useAppStore((s) => s.setTrackpadScroll);
  const optionalCategories = useAppStore((s) => s.optionalCategories);
  const setOptionalCategory = useAppStore((s) => s.setOptionalCategory);
  const closePrefs = useCallback(() => setPrefsAt(null), []);
  useDismiss(prefsAt != null, closePrefs, [prefsRef]);

  const openPrefs = useCallback((e: React.MouseEvent) => {
    // Never steal a right-click that already means something else (see
    // prefsClaimedElsewhere for the list and why).
    if (prefsClaimedElsewhere(e.target as HTMLElement | null)) return;
    e.preventDefault();
    setPrefsAt({ x: e.clientX, y: e.clientY });
  }, []);

  // ── Narrow-window overflow ────────────────────────────────────────────────
  // Below a certain width the right cluster stops fitting and the toolbar
  // simply overflows (the centre's name field is the only flexible child and
  // it bottoms out at its min-width). Rather than pick a breakpoint, MEASURE:
  // the needed width differs between the web and desktop builds (SC + Download
  // app vs VR) and between languages, so a media query would be wrong for
  // three of those four combinations. `foldOverflow` owns the hysteresis —
  // collapsing removes the very overflow that triggered it, so the expand
  // threshold has to be captured while the bar is still expanded.
  const barRef = useRef<HTMLDivElement>(null);
  // Touch has no second button, and this list is the ONLY way to switch the
  // optional categories on — so a sustained press anywhere on the bar opens
  // it, the EXPORT and reload precedents. Same guard as the right-click, so a
  // hold on the name field or on EXPORT still belongs to them. A plain ref is
  // fine here (the reload button needs its element in STATE because React
  // re-parents it into the ☰ menu; the bar itself never moves). Mouse presses
  // are ignored by the hook, so a desktop left-button hold never opens it.
  useLongPress(barRef, (target, x, y) => {
    if (prefsClaimedElsewhere(target)) return;
    setPrefsAt({ x, y });
  });
  const [overflow, setOverflow] = useState(OVERFLOW_INITIAL);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuOpen, setMenuOpen, [menuRef]);

  // ── Reload, and its right-click menu ──────────────────────────────────────
  // The menu is the only place a HARD reload is offered: the desktop shell has
  // no browser chrome at all, and an iPad's has no hard-reload gesture.
  const [reloadOpen, setReloadOpen] = useState(false);
  const reloadRef = useRef<HTMLDivElement>(null);
  const suppressReloadClickRef = useRef(false);
  // The BUTTON is held in STATE, not a ref: React unmounts it from the bar and
  // remounts it inside the ☰ menu when the toolbar collapses, and useLongPress
  // keys its listeners on the target's identity — a ref object's identity never
  // changes, so the first collapse would leave the gesture bound to a detached
  // node and silently dead (see the hook).
  const [reloadBtn, setReloadBtn] = useState<HTMLButtonElement | null>(null);
  useDismiss(reloadOpen, setReloadOpen, [reloadRef]);
  useLongPress(reloadBtn, () => {
    suppressReloadClickRef.current = true;
    // Same latch the EXPORT long-press uses: if the finger lifts outside the
    // button no click consumes it, so clear it at the next pointerdown.
    document.addEventListener(
      'pointerdown',
      () => { suppressReloadClickRef.current = false; },
      { once: true, capture: true },
    );
    setReloadOpen(true);
  });
  // A popover opened on the bar and then collapsed away (window resize, or a
  // language switch relabelling the chips) would otherwise still be open, so
  // the ☰ would render it with no gesture — worse here than for the other
  // popovers, because one of these rows takes the page down.
  useEffect(() => {
    setReloadOpen(false);
  }, [overflow.collapsed]);

  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () =>
      setOverflow((s) => foldOverflow(s, { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // `language` is a dependency because switching it relabels several chips
    // (and the EXPORT/name row), which changes the natural width without
    // changing the element's own box — so no resize is observed.
  }, [language]);

  // Re-measure after a collapse/expand commits: the observer fires on the
  // toolbar's own box, which does NOT change when its children do, so the
  // expanded-again bar would never learn that it overflows.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    setOverflow((s) => foldOverflow(s, { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
  }, [overflow.collapsed, language]);

  // Nothing to keep open once the buttons are back on the bar.
  useEffect(() => {
    if (!overflow.collapsed) setMenuOpen(false);
  }, [overflow.collapsed]);

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
    <div className="toolbar" ref={barRef} onContextMenu={openPrefs}>
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
                src={`${import.meta.env.BASE_URL}images/logo-eu-cofunded.svg`}
                alt="Co-funded by the European Union"
                title="Co-funded by the European Union (European Regional Development Fund)"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
              <img
                className="toolbar__contact-logo toolbar__contact-logo--nap"
                src={`${import.meta.env.BASE_URL}images/logo-nap2027.svg`}
                alt="National Development Plan 2027 (Nacionālais attīstības plāns 2027)"
                title="National Development Plan 2027 (Nacionālais attīstības plāns 2027)"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
              <img
                className="toolbar__contact-logo"
                src={`${import.meta.env.BASE_URL}images/logo-via.svg`}
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
              // In a study session EXPORT is the natural "I'm done" button, so
              // it opens the finish dialog instead of quietly downloading a
              // bare shader — the participant's package is assembled at the
              // end of the questionnaire and carries this shader inside it.
              if (isEvalMode()) {
                setEvalFinishOpen(true);
                return;
              }
              downloadShader();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setExportOpen((o) => !o);
            }}
            title={
              isEvalMode()
                ? t('Finish the session — answer a short questionnaire, then submit your shader and session data to the researcher', language)
                : `${t('Download the shader — .js with the FastShaders project embedded (drag it back in to continue); becomes a .zip with the image and 3D-model files alongside when the graph embeds images or a custom preview mesh is loaded', language)}. ${
                    previewMesh && !exportIncludeMesh
                      ? t('The 3D model is currently excluded from the export — right-click to change.', language)
                      : t('Right-click for export settings.', language)
                  }`
            }
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
        {/* …but the web build still SHOWS it, inert, so the capability is
            discoverable instead of invisible — otherwise nothing on the site
            hints that the desktop app can keep a folder of shaders.

            Inlined here rather than as a branch inside WorkFolder.tsx on
            purpose: `__FS_DESKTOP__ && <WorkFolder />` is what keeps that whole
            module (and its Tauri bridge calls) out of the web bundle, and
            importing it for the disabled case would undo the tree-shake.

            aria-disabled, NOT the `disabled` attribute: a genuinely disabled
            control doesn't reliably surface its native `title` (WebKit skips
            the tooltip entirely), and here the tooltip is the whole point of
            rendering the button at all. No onClick, so it stays inert. */}
        {!__FS_DESKTOP__ && (
          <button
            type="button"
            className="toolbar__sc-link toolbar__wf-link toolbar__wf-link--unavailable"
            aria-disabled="true"
            title={t('Only in the desktop app: keep your shaders in a folder on your computer — Save writes the current one there, and the list reopens any of them.', language)}
          >
            {t('Work folder', language)}
          </button>
        )}
        {/* Palettes sit in the CENTRE cluster, beside the name and Export,
            because a palette is part of the shader — it saves with it, rides
            the project block and travels inside the exported file. The right
            cluster is app chrome (reload, theme, language, downloads), which
            is a different kind of thing.

            The dialog exists at all because the colour-picker popover cannot
            host management: it only renders on an Output channel that is both
            exposed and unwired, so on a finished shader it is frequently not
            on screen. */}
        <button
          type="button"
          className="toolbar__sc-link"
          onClick={() => setPalettesOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={palettesOpen}
          title={t('Colour palettes for this shader — duplicate a built-in one, save the colours you are using, import or export them', language)}
        >
          {t('Palettes', language)}
        </button>
      </div>
      <div className="toolbar__right">
        {/* Everything from the reload button through the theme toggle is
            COLLAPSIBLE: below the measured width these move into the ☰ menu
            below, rendered from this same fragment so the two states cannot
            drift. Deliberately NOT collapsible, and therefore outside it: the
            EVAL badge (visible by design — covert recording is what the
            study's ethics posture forbids) and the feedback "!" (the one loud
            control in the chrome, and in eval mode the FINISH button the
            consent screen told the participant to press). Hiding either behind
            a menu on a small window would defeat the reason each exists. */}
        {(() => {
          const collapsible = (
            <>
        {/* Reload. Left-click reloads; right-click — or a sustained press on
            touch, where there is no second button — opens the two-item menu,
            which is the only place a HARD reload is offered.

            Safe to offer without a confirm: the graph autosaves to fs:graph
            (and every UI pref to its own key), and the dropped preview mesh is
            mirrored to IndexedDB (previewMeshCache.ts), so a reload restores
            the session rather than discarding it. The tooltip used to warn
            that the model was lost; that stopped being true when the mesh
            cache landed.

            The wrapper carries `.toolbar__local` — the app's generic anchored-
            popover class — which buys three things at once: `position:
            relative` for the popover, the `.toolbar__overflow-menu
            .toolbar__local-popover` re-anchoring that keeps it from opening on
            top of its own trigger inside the ☰, and the dark-theme shadow rule
            (an explicit selector list, so a bespoke class would render a flat
            patch on dark chrome — invisible in the light theme it is built
            in). It is also already in openPrefs' right-click guard. */}
        <div className="toolbar__local toolbar__reload-wrap" ref={reloadRef}>
          <button
            type="button"
            ref={setReloadBtn}
            className="toolbar__sc-link toolbar__refresh"
            onClick={() => {
              if (suppressReloadClickRef.current) {
                suppressReloadClickRef.current = false;
                return;
              }
              window.location.reload();
            }}
            onContextMenu={(e) => {
              // preventDefault only, like EXPORT's: the bar-root handler is
              // kept off this subtree by the `.toolbar__local` guard, so there
              // is nothing to stopPropagation for.
              e.preventDefault();
              setReloadOpen((o) => !o);
            }}
            title={`${t('Reload the page', language)}. ${t('Right-click for a hard reload.', language)}`}
            aria-label={t('Reload the page', language)}
            aria-haspopup="menu"
            aria-expanded={reloadOpen}
          >
            {/* Inline SVG, not a glyph: the app self-hosts a woff2 SUBSET of
                Inter, so ↻/⟳ are not guaranteed to be in the font offline. */}
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
          </button>
          {reloadOpen && (
            <div
              className="toolbar__local-popover toolbar__reload-popover"
              role="menu"
              aria-label={t('Reload', language)}
            >
              <div className="toolbar__local-header">
                <span className="toolbar__contact-label">{t('Reload', language)}</span>
              </div>
              {/* One line each, explanation on hover via the app-wide
                  TooltipLayer — the rule the Add-node menu and the input-
                  settings popup follow. */}
              <button
                type="button"
                role="menuitem"
                className="toolbar__local-row toolbar__reload-row"
                onClick={() => {
                  setReloadOpen(false);
                  window.location.reload();
                }}
                title={t('The same as clicking the button.', language)}
              >
                <span>{t('Reload', language)}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="toolbar__local-row toolbar__reload-row"
                onClick={() => {
                  setReloadOpen(false);
                  hardReload();
                }}
                title={t('Fetch the page again instead of reusing the browser\u2019s cached copy — use this after an update if the app looks stale. Files loaded alongside the page may still come from the cache.', language)}
              >
                <span>{t('Hard reload', language)}</span>
              </button>
              <div className="toolbar__local-note">
                {t('Your shader, its settings and a dropped model are all saved — either option restores them.', language)}
              </div>
            </div>
          )}
        </div>
        {/* Desktop opens Podest as a REAL second app window (a Rust command —
            see src-tauri/src/podest_window.rs); the web build keeps the plain
            new-tab anchor. `target="_blank"` is meaningless inside a Tauri
            webview — neither WKWebView nor WebView2 honours it without a host
            handler — so the shared anchor was simply inert on desktop. Branch
            on the whole ELEMENT rather than just the handler: an <a href> with
            a click-preventing onClick still shows a bogus status-bar URL and
            still offers "Open in new window" on right-click. */}
        {__FS_DESKTOP__ ? (
          <button
            type="button"
            className="toolbar__sc-link"
            onClick={() => {
              benchInvoke<void>('podest_open').catch((e) =>
                // No toast surface up here, and a silent no-op is exactly the
                // failure this replaces — the console line is at least a thread
                // to pull. A second click re-focuses rather than erroring.
                console.error('Could not open the Podest window:', errorText(e)),
              );
            }}
            title="Open Podest in a separate window — full-screen shader player (drop .js/.tsl shaders, .glb models, .zip)"
            aria-label="Open Podest"
          >
            P
          </button>
        ) : (
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
        )}
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
        {/* Language switch (Latvian ⇄ English). Latvian is a display-only
            overlay — see src/i18n — and the app's DEFAULT, so the button
            labels the language it switches TO ("EN" while Latvian is on).
            That makes it an action, not a state: no `aria-pressed`, which
            beside a flipping label reads as a contradiction in a screen
            reader (the WGSL/GLSL toggle documents the same trap). */}
        <button
          type="button"
          className="toolbar__sc-link toolbar__lang"
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
            </>
          );
          if (!overflow.collapsed) return collapsible;
          return (
            <div className="toolbar__overflow" ref={menuRef}>
              <button
                type="button"
                className="toolbar__sc-link toolbar__overflow-btn"
                onClick={() => setMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title={t('More tools', language)}
                aria-label={t('More tools', language)}
              >
                {/* Inline SVG for the same reason the reload icon is one: the
                    app self-hosts a woff2 SUBSET of Inter, so ☰ is not
                    guaranteed to be in the font offline. */}
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M3 5h18v2.4H3zm0 5.8h18v2.4H3zm0 5.8h18V19H3z" />
                </svg>
              </button>
              {menuOpen && (
                <div
                  className="toolbar__overflow-menu"
                  role="menu"
                  aria-label={t('More tools', language)}
                >
                  {collapsible}
                </div>
              )}
            </div>
          );
        })()}
        {/* Eval mode is VISIBLE by design: covert recording is what the study's
            ethics posture forbids, so the badge stays for the whole session. */}
        {isEvalMode() && (
          <span
            className="toolbar__eval-badge"
            title={t('Evaluation session — interactions are being recorded for the study', language)}
          >
            EVAL
          </span>
        )}
        {/* Feedback — the one deliberately loud control in the chrome. Sits in
            the far corner and is the only red thing in the toolbar, so a user
            who hit a wall can find it without hunting. Composes a report and
            hands it to the user's mail client; nothing is uploaded (see
            utils/feedbackReport.ts for why a hosted form is not an option).
            In EVAL mode the same button ends the study session instead: it
            opens the SUS questionnaire (see src/eval/) — the consent screen
            told the participant this is the finish control. */}
        <button
          type="button"
          className="toolbar__sc-link toolbar__feedback"
          onClick={() => setFeedbackOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={feedbackOpen}
          title={
            isEvalMode()
              ? t('Finish the session and answer the questionnaire', language)
              : t('Send feedback — report a problem or suggest an improvement', language)
          }
          aria-label={
            isEvalMode() ? t('Finish and answer the questionnaire', language) : t('Send feedback', language)
          }
        >
          !
        </button>
      </div>
      {isEvalMode() && (
        <EvalFinishModal
          open={evalFinishOpen}
          onContinue={closeEvalFinish}
          onFinish={finishEvalSession}
        />
      )}
      {isEvalMode() ? (
        <SusModal open={feedbackOpen} onClose={closeFeedback} />
      ) : (
        <FeedbackModal open={feedbackOpen} onClose={closeFeedback} />
      )}
      <PalettesModal open={palettesOpen} onClose={closePalettes} />
      {prefsAt && (
        <div
          ref={prefsRef}
          className="toolbar__prefs-popover"
          role="menu"
          // "Settings", not the "Input settings" the removed heading said: the
          // list now holds the two library switches beside the trackpad one,
          // and an accessible name that only fits its first row misnames the
          // other two to a screen reader.
          aria-label={t('Settings', language)}
          // Positioned at the pointer, so it reads as that click's menu. Fixed,
          // not absolute: the toolbar is the containing block and clamping
          // against it would fight the bar's own horizontal scroll-free layout.
          // The right/bottom clamps keep it on screen near the far corner,
          // where the right cluster lives.
          style={{
            left: Math.min(prefsAt.x, window.innerWidth - PREFS_W - 8),
            top: Math.min(prefsAt.y, window.innerHeight - PREFS_H - 8),
          }}
        >
          {/* A plain LIST of settings — no heading (it went 2026-09-04: the
              popover is the toolbar's own context menu, and a title over three
              checkboxes was a row that did nothing). Each explanation is the
              row's `title`, picked up by the app-wide TooltipLayer — the same
              "one line you scan, the detail arrives on hover" rule the Add-node
              menu follows. It sits on the LABEL, which wraps both the box and
              the text, so either half raises it (TooltipLayer resolves its
              host with closest('[title]')). */}
          <label
            className="toolbar__prefs-row"
            title={
              trackpadScroll
                ? t('Two fingers pan the node canvas; pinch to zoom.', language)
                : t('The mouse wheel zooms the node canvas. Turn this on for a trackpad, where two fingers should pan instead.', language)
            }
          >
            <input
              type="checkbox"
              checked={trackpadScroll}
              onChange={(e) => setTrackpadScroll(e.target.checked)}
            />
            <span className="toolbar__prefs-label">{t('Trackpad scrolling', language)}</span>
          </label>
          {/* The optional palette categories (Textures, Distance fields) — OFF
              by default, on for good once ticked. Labelled with the category's
              own tab name (formatCategoryLabel, Latvian-aware), so the switch
              and the tab it summons read as one thing. */}
          {OPTIONAL_CATEGORIES.map((id) => {
            const cat = CATEGORIES.find((c) => c.id === id)!;
            return (
              <label
                key={id}
                className="toolbar__prefs-row"
                title={t(OPTIONAL_CATEGORY_HINTS[id], language)}
              >
                <input
                  type="checkbox"
                  checked={optionalCategories[id]}
                  onChange={(e) => setOptionalCategory(id, e.target.checked)}
                />
                <span className="toolbar__prefs-label">
                  {formatCategoryLabel(cat.label, id, language)}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
