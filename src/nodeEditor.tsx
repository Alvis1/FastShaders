/**
 * Entry point for node-editor.html — the localhost-only node & texture overview /
 * description editor. `./nodeEditorBootstrap` must stay the FIRST import — see that file.
 */
import './nodeEditorBootstrap';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { GraphsPage } from './components/Graphs/GraphsPage';

// Mirrors main.tsx's CSS bootstrap — without tokens.css the page renders token-less.
import './styles/fonts';
import './styles/tokens.css';
import './styles/reset.css';
import '@xyflow/react/dist/style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GraphsPage />
  </React.StrictMode>
);
