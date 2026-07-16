/**
 * Entry point for node-editor.html — the localhost-only node & texture overview /
 * description editor.
 *
 * CORE SAFETY INVARIANT: `./nodeEditorBootstrap` MUST stay the first import — it
 * disables the store's graph autosave, without which this page could overwrite
 * the user's real graph in localStorage. Read that file before touching the
 * import order here; "first statement in the body" would NOT be good enough,
 * because imports evaluate before any statement runs.
 */
import './nodeEditorBootstrap';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { GraphsPage } from './components/Graphs/GraphsPage';

// Mirrors main.tsx's CSS bootstrap exactly — without tokens.css the whole page
// renders token-less (no colors, no spacing, no fonts).
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/reset.css';
import '@xyflow/react/dist/style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GraphsPage />
  </React.StrictMode>
);
