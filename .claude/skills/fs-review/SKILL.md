---
name: fs-review
description: FastShaders-specific review checklist — the bug classes this repo has actually shipped (adversarial file input, ingest paths that must agree and announce, codegen byte-stability, history, stale docs). Load it whenever reviewing a diff, a PR or your own finished change in this repo, alongside /code-review or on its own.
---

# FastShaders review checklist

Use this on top of a general correctness review. Every item below is a bug that has shipped at least once.
For each touched area, open its `docs/dev/*.md` file (table in CLAUDE.md) before judging it.
Report a finding only with a concrete failure scenario: the input, the steps, and the wrong result.

## 1. Adversarial input: `.fastshader`, pasted code, dropped models, `fs:*` localStorage
- **Coercing a `values` entry can THROW.** `String(v)`, `Number(v)` and template literals all run ToPrimitive and die on
  `{"toString":1}`. A render-path read must go through `getNodeValues` / `rawNodeValues` or
  `valueStr` / `valueNum` / `plainStr` (`utils/valueCoerce.ts`). Grep the diff for `String(data.values`,
  `Number(data.values` and `` `${…values…}` ``. There is no error boundary, and autosave writes the poisoned graph back.
- Any new field read from a project block (`shaderName`, `ui.*`, `preview.*`) is unvalidated JSON, so type-check it
  before calling a method on it. A name from a file goes through `sanitizeDroppedName`.
- `edge.data`, board drawings, image payloads (`validImageDataUrl`), mesh names (REJECT-list, `Map` or
  null-prototype) and `in` checks on a possibly-primitive `values` are all the same class of bug.
- Model bytes are never parsed on the trusted side except in the documented readers.

## 2. Ingest paths must agree, and every loss must announce itself
- Open, Add, zip import, GLB "Mesh with Materials", saved-group instantiate and the Work folder must run the SAME
  sanitizers in the same order (sanitize, then unfold, then normalize). Compare the new path line by line against
  `applyProjectToStore`.
- Image refs: both passes, top-level `imageRefs` with the REAL project, plus `resolveImageRefs`. Then
  `images-stripped` and `images-missing` notices from `splitImageLosses`. A path that ADDS payloads checks the
  budget before `pushHistory`.
- A success note or report must fire only after the commit really happened, including a deferred
  `proceed` from a limit notice.
- Event choice: `fs:graph-imported` means a different document (the Work folder forgets the file).
  `fs:graph-merged` means the same document with nodes added or replaced.
- Singletons (Sound) redirect onto the live node. Wires INTO a folded singleton must not land on the live node.

## 3. Codegen and byte-stability
- An ABSENT key must emit byte-identical output (noise `signed`, `activeOutput`, `emitRank`, helper `mode`).
- `mix(a,b,t)` is the free function, never `a.mix()`. `smoothstep`/`step` displace their receiver too.
- A module-scope helper goes in `moduleHelpers.ts` and its name is RESERVED. Never emit an async IIFE.
- Emission and the parse (`codeToGraph`) change in ONE commit. A round trip must not grow nodes.
- A memo key that folds `e.source` must also fold `e.sourceHandle`.
- A zero-input node's `defaultValues` key order is a positional contract.

## 4. Store, history, React
- A continuous gesture is bracketed with `beginInteraction`/`endInteraction`. Never bracket a PREFERENCE site or a
  write that may be a no-op, because it wipes redo.
- `setCode(code, 'code')` writes `code` only. `previewCode` moves on a sync or Apply.
- Deleting a node goes through `bridgeEdgesAcrossDeletedNodes`.
- A component that mounts handles calls `useUpdateNodeInternals`.
- An always-mounted component's selector runs on EVERY store notify (once per drag frame). No `.filter`/`.map`
  allocation there, and gate it on the state that makes it relevant.
- A `useMemo` keyed on a value that becomes '' on close throws away its expensive result on every reopen.

## 5. Keyboard, modals, the canvas
- A modal swallows keys in the capture phase (`stopPropagation`, except Tab) for as long as it is mounted, INCLUDING
  while busy, because the canvas binds Delete/⌘Z/⌘G on `window`. Busy may gate the ANSWER, never the swallow.
- New floating chrome over the canvas needs `.nowheel`. A canvas gesture across the preview iframe needs `fs-canvas-busy`.
- Styling: square corners, zero-blur offset shadows, tokens only. Dark mode never flips `--type-*`/`--cost-*`/`--cat-*`.

## 6. Copy and docs
- A comment, JSDoc or tooltip that names a file, function or button must still be TRUE. Grep for the
  names the diff removed (`git diff | grep '^-' | grep -o 'engine/[A-Za-z]*\.ts'`) and for claims like
  "undo brings it all back" (check `HistoryEntry`).
- A new import goes at the top of the module, never between a JSDoc and its declaration.
- A user-visible English string needs its `src/i18n/lv.json` entry (Latvian is a display-only overlay).
- A retracted claim must not survive in CLAUDE.md or `docs/dev/`, because suites pin claims via `src/projectDocs.ts`.

## 7. Tests
- Pure logic only (`node` env, `isolate: false`). A `vi.stubGlobal` needs `vi.unstubAllGlobals()`. Use the
  factories in `src/test-utils.ts`. A source-pin test (`toMatch` on file text) must be updated WITH the behaviour,
  never deleted to go green.
- The suite must stay green with nodes hidden (`editorVisibility`) and with both `ACTIVE_LOADERS`.
