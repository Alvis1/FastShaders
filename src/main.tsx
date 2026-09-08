import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Self-hosted fonts (were Google Fonts <link>s in index.html) — the app must
// render identically offline and in the desktop build, with no CDN reachable.
// The vendor CSS is used as-is; the fs-fontsource-woff2-only plugin in
// vite.config.ts strips the legacy .woff fallback src at build so only the
// woff2 subsets reach dist.
//
// LATIN SUBSETS ONLY, and it must stay that way on all three entry points
// (this file, nodeEditor.tsx, nodeDesigner/main.ts). The bare `@fontsource/
// inter/400.css` entry point declares all SEVEN Google subsets — cyrillic,
// cyrillic-ext, greek, greek-ext, latin, latin-ext, vietnamese — which put 24
// woff2 files / 162 KB into dist that no user ever downloads: every @font-face
// keeps its unicode-range, and the two shipped UI languages are covered by
// latin + latin-ext (Latvian ā/ē/ī/ū/ķ/ļ/ņ/ģ/š/ž/č are U+0100-U+017F, inside
// latin-ext's U+0100-02BA). So the cost was pure deploy weight: uploaded by
// psftp on every deploy, committed to the gh-pages tree on every release, and
// bundled into the .dmg and the Windows installer. The trade accepted here is
// that a Cyrillic or Greek mesh name / note falls back to a system font.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-ext-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-ext-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-ext-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-ext-500.css';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/controls.css';
import '@xyflow/react/dist/style.css';
import { applyEvalTaskFlags } from './eval/evalTask';
import { stripHardReloadMarker } from './utils/hardReload';

// Renderer-triage switches (e.g. the Safari zoom-blur hunt): ?fsdbg=a,b,...
// injects coarse CSS overrides so a browser-specific compositing culprit can
// be bisected on the DEPLOYED site without rebuilds. Inert without the param.
const fsdbg = new URLSearchParams(window.location.search).get('fsdbg');
if (fsdbg) {
  const rules: Record<string, string> = {
    // Stop the marching-ants dash animation (continuous repaint inside the
    // scaled viewport) — dashes stay, they just don't move.
    noanim: '.react-flow__edge path { animation: none !important; }',
    // Remove <canvas> thumbnails/previews (accelerated layers).
    nocanvas: '.react-flow__viewport canvas { display: none !important; }',
    // Remove shadows.
    noshadow: '.react-flow__viewport * { box-shadow: none !important; }',
    // Collapse z-index games (multi-channel card stacks).
    flatz: '.react-flow__viewport * { z-index: auto !important; }',
  };
  const style = document.createElement('style');
  style.textContent = fsdbg
    .split(',')
    .map((k) => rules[k.trim()] ?? '')
    .join('\n');
  document.head.appendChild(style);
}

// Study conditions that change what the UI SHOWS (see eval/evalTask.ts).
applyEvalTaskFlags();

// Tidy the cache-busting marker the toolbar's Hard reload navigated with out
// of the address bar. The fresh fetch has already happened, so this undoes
// nothing — it just stops the parameter being carried into every bookmark and
// shared link made from this page. Runs AFTER the ?fsdbg read above, which
// looks at a different parameter and is unaffected either way.
stripHardReloadMarker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
