import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Self-hosted fonts (were Google Fonts <link>s in index.html) — the app must
// render identically offline and in the desktop build, with no CDN reachable.
// The vendor CSS is used as-is; the fs-fontsource-woff2-only plugin in
// vite.config.ts strips the legacy .woff fallback src at build so only the
// woff2 subsets reach dist.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/reset.css';
import '@xyflow/react/dist/style.css';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
