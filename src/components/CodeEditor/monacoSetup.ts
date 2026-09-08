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
 *
 * The cherry-pick is at LANGUAGE granularity and deliberately stops there.
 * Two things that ride along have been measured and left alone — recorded here
 * so the next audit does not re-derive them:
 *
 *   · DIFF-EDITOR CSS. `edcore.main` imports
 *     `browser/widget/diffEditor/diffEditor.contribution.js`, so ~10-15 KB of
 *     the 142 KB monaco stylesheet (≈2 KB gzipped) styles a DiffEditor this app
 *     never mounts — it renders only `<Editor>`. It cannot be dropped by
 *     omitting an import; it would take a build-time CSS filter over the monaco
 *     chunk, which is more machinery than 2 KB is worth.
 *
 *   · EDITOR CONTRIBUTIONS with no provider. `edcore.main` is a flat list of
 *     ~74 side-effect imports, and the app registers exactly two providers
 *     (tslLanguage.ts: completion + color), so inlineCompletions, gotoSymbol,
 *     codeAction, rename and dropOrPasteInto have nothing to serve. Hand-copying
 *     that list here to drop those five lines was considered and REJECTED: the
 *     directories are not independently reachable — `contrib/suggest/browser/
 *     suggestModel.js` and `contrib/hover/browser/contentHoverController.js`
 *     import `contrib/inlineCompletions/`, `contrib/hover/browser/
 *     markerHoverParticipant.js` imports `contrib/codeAction/`, and both
 *     `gotoSymbol/browser/link/goToDefinitionAtPosition.js` and
 *     `standalone/browser/referenceSearch/standaloneReferenceSearch.js` import
 *     back into `gotoSymbol/` — so the directory sizes are an upper bound the
 *     cut would not realise, while a 74-line copy of a monaco-internal entry
 *     goes stale SILENTLY under the `^0.55.1` caret range (a new contribution
 *     simply stops being registered, with no error anywhere). All of it rides
 *     the lazily-imported CodeEditor chunk, off the first-paint path.
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
