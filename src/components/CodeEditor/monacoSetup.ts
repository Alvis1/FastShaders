/**
 * Bundle Monaco locally instead of letting @monaco-editor/loader pull it from
 * cdn.jsdelivr.net at runtime. Offline use (and the desktop build) must not
 * depend on a CDN: `loader.config({ monaco })` short-circuits the AMD/CDN
 * loader entirely, and Vite's `?worker` imports emit the worker bundles as
 * same-origin assets.
 *
 * Cherry-picked build: the app edits JavaScript (TSL) exclusively, so instead
 * of the `monaco-editor` entry (editor.main — which drags the css/html/json
 * language clients + workers and ~79 basic-language tokenizers into dist) we
 * compose exactly what runs:
 *   - edcore.main.js — editor core + every editor feature, ZERO languages
 *   - editor.api.js  — the typed API namespace; same module instances
 *     edcore.main re-exports, so mutating `languages` below is visible
 *     everywhere (including tslLanguage.ts via the loader)
 *   - the TypeScript language client + the javascript/typescript tokenizers
 *     (javascript's Monarch grammar is defined in terms of typescript's)
 */
import 'monaco-editor/esm/vs/editor/edcore.main.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import * as tsContribution from 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { loader, type Monaco } from '@monaco-editor/react';

// editor.main.js normally installs the `monaco.languages.typescript` namespace
// (javascriptDefaults & co) on the API object; with the cherry-picked build we
// attach it ourselves — tslLanguage.ts reads
// `monaco.languages.typescript.javascriptDefaults` at editor mount.
Object.assign(monaco.languages, { typescript: tsContribution });

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// The cast is deliberate: editor.api's own .d.ts doesn't know about the
// language namespaces attached above (their types live in editor.main.d.ts,
// which is what `Monaco` aliases). The runtime object carries everything the
// app touches; the css/html/json namespaces it lacks are never used.
loader.config({ monaco: monaco as unknown as Monaco });
