/**
 * Bundle Monaco locally instead of letting @monaco-editor/loader pull it from
 * cdn.jsdelivr.net at runtime. Offline use (and the desktop build) must not
 * depend on a CDN: `loader.config({ monaco })` short-circuits the AMD/CDN
 * loader entirely, and Vite's `?worker` imports emit the worker bundles as
 * same-origin assets.
 *
 * Only the editor core + TS/JS worker are wired — the app edits JavaScript
 * (TSL) exclusively, so the css/html/json language workers would be dead
 * weight.
 */
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { loader } from '@monaco-editor/react';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
