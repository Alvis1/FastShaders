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
 *     edcore.main re-exports, so language registrations are visible
 *     everywhere (including tslLanguage.ts via the loader)
 *   - the javascript/typescript Monarch tokenizers (javascript's grammar is
 *     defined in terms of typescript's) for syntax highlighting
 *   - the html Monarch tokenizer, for the A-Frame tab's index.html view. Also
 *     tokenizer-only: `basic-languages/html` is the grammar, NOT the html
 *     language client/worker that `editor.main` would drag in.
 *
 * Deliberately NO TypeScript language service: its ts.worker was the single
 * largest dist asset (7MB) and it spun up on every boot only to type-check
 * against an all-`any` TSL declaration file — worthless diagnostics at a
 * 7MB/boot price. Completions come from tslLanguage.ts's registry-fed
 * provider plus Monaco's built-in word-based suggestions; real syntax errors
 * surface through the Apply path's Babel parse.
 */
import 'monaco-editor/esm/vs/editor/edcore.main.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader, type Monaco } from '@monaco-editor/react';

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

// The cast is deliberate: editor.api's own .d.ts doesn't know about the
// basic-language registrations above (their types live in editor.main.d.ts,
// which is what `Monaco` aliases). The runtime object carries everything the
// app touches; the language-service namespaces it lacks are never used.
loader.config({ monaco: monaco as unknown as Monaco });
