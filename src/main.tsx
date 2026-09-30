import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/fonts';
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
