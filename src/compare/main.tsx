/**
 * Entry point for compare/index.html — the device-comparison page, served at
 * `<base>compare/` (fs.sferas.lv/compare/, Pages /FastShaders/compare/,
 * alvismisjuns /fastshaders/compare/). A real Vite entry (rollupOptions.input
 * in vite.config.ts), NOT an app page: it never imports the store, so nothing
 * here can autosave over the editor's graph or move its selected device, and
 * it needs no `nodeEditorBootstrap` guard. bootWave.test.ts walks this file's
 * static imports and fails on any path to the store or to @babel/*.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
// The app's own faces, tokens and reset — the page wears the editor's look.
import '../styles/fonts';
import '../styles/tokens.css';
import '../styles/reset.css';
import { ComparePage } from './ComparePage';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ComparePage />
  </React.StrictMode>,
);
