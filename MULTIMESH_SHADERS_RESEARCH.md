# Multi-mesh glTF → per-mesh shaders: feasibility research (2026-08-13)

Research only — nothing implemented. Question: user drops a glTF/GLB with multiple meshes;
how do they author SEVERAL shaders and assign each to a sub-mesh (e.g. a mesh selector on the
Output node)? Produced by a 10-agent workflow (5 codebase/prior-art researchers, 3 competing
architectures, adversarial judge + completeness critic), then a 7-agent **verification pass**
(2026-08-13, second workflow) that re-checked every citation adversarially and EXECUTED the doubted
mechanics — see "Verification results" below. One claim was refuted (mesh-name mangling), several
line numbers corrected; the headless two-mesh render PASSED on both backends. Line numbers are
current as of commit `35e3b1b` (0.3.16).

## Verdict

**Feasible and realistic.** Sub-mesh identity already survives the whole pipeline: `FIT_BOUNDS_SCRIPT`
only swaps cloned geometry and zeroes transforms — it never merges, renames, or reparents Mesh
nodes ([tslToPreviewHTML.ts:492-613](src/engine/tslToPreviewHTML.ts)) — so authored glTF names and
hierarchy reach the loader intact on every surface. The single flattening point is
`applyMaterialToMesh` in shaderloader 0.5, which traverses and stamps ONE `MeshPhysicalNodeMaterial`
on every `node.material` (0.5.js:480-486), keeping `originalMaterials` by uuid (0.5.js:473-479).
`graphToCode` keeps only the FIRST Output node (`sorted.find`, [graphToCode.ts:1359](src/engine/graphToCode.ts#L1359));
extra Outputs are silently ignored today — silence is architectural: `GeneratedCode` has no errors
field at all (tsl.types.ts:8-13), so the emitter structurally cannot report a dropped Output.

## Platform facts that shape the design

- **glTF binds materials per PRIMITIVE**, not per mesh/node; GLTFLoader makes one `THREE.Mesh` per
  primitive (multi-primitive mesh → a Group of Meshes). "Target mesh" really means "target
  primitive-level Mesh". Draw calls do NOT increase with N materials — a multi-part model already
  issues one draw per primitive.
- **Names are the fragile key — but less fragile than first reported**: glTF names are optional and
  non-unique; GLTFLoader routes them through `PropertyBinding.sanitizeNodeName` + `_N` dedupe.
  **REFUTED on verification**: the sanitizer does NOT strip non-ASCII — it only replaces whitespace
  with `_` and strips the five reserved chars `[ ] . : /` (PropertyBinding.js:185-189, deliberately
  language-agnostic per its own comment). Executed: `'Ķermenis_āda 2'` → `'Ķermenis_āda_2'` —
  **Latvian names survive intact**. The real hazards are: space→underscore, the `_N` dedupe suffix
  on collisions, instanced nodes cloning meshes with duplicate names (three.js #30090, still open;
  fix pending as PR #30091), and DCC re-exports renaming/reordering (Godot #85850 — closed,
  historical, but the rot mode is real). Stable spec-level addressing exists as
  `parser.associations` (mesh index + primitive index), which is what `KHR_materials_variants`
  uses. Design consequence unchanged: **name-with-all-matches semantics**, traversal index only as
  a session-local disambiguator, ⚠ chips for orphaned bindings.
- **Prior art is unanimous**: every surveyed tool (Blender slots, Unity renderer material lists,
  Godot surface overrides, Houdini/Polygonjs, NodeToy, ShaderFrog, model-viewer variants) puts
  mesh↔shader assignment in a MAPPING LAYER outside the shader graph. No tool puts a mesh selector
  on the shader graph's output node. (That doesn't forbid it here — but the assignment-table UI
  should exist even if the data model is per-Output.)
- **Cost model**: three's WebGPURenderer dedupes programs by generated code string and caches
  pipelines; N distinct graphs = N pipelines. Per-frame switch cost is negligible at model scale on
  Quest 3 budgets; the real unknown is pipeline-COMPILE stutter per 200 ms-debounced rebuild
  (unmeasured — needs a ShaderCarousel entry before N-material activation).
- **A-Frame's canonical per-part pattern** is exactly what shaderloader already does (model-loaded →
  traverse → match by name → replace `node.material`); A-Frame core deliberately won't override glTF
  materials itself (#3420) — this is precisely the layer a-frame-shaderloader occupies.

## Shared Phase-0 infrastructure (identical in ALL designs, ~1.5 d)

1. **`fs:model-meshes`** (iframe→parent): model-loaded listener in the `fs:obj-model` consumer block
   ([tslToPreviewHTML.ts:1450-1505](src/engine/tslToPreviewHTML.ts)) traverses
   `getObject3D('mesh')`, posts `{index, name, materialName, vertexCount}` per `isMesh` node, keyed
   with the same `custom:<id>` the feed already enforces; auto re-sent per rebuild.
2. **Sanitized parent handler** in ShaderPreview's source-guarded switch
   ([ShaderPreview.tsx:744-838](src/components/Preview/ShaderPreview.tsx)) — forgeable-sandbox trust
   class (like `fs:preview-drop`): strings only, ≤64 chars, charset-filtered, ≤256 meshes.
3. **`previewMeshInventory`** session-only store field beside `previewMesh` — NEVER persisted (a
   tampered `fs:graph` must not inject a fake inventory that validates hostile bindings); cleared on
   mesh change. UI-only: feeds pickers and ⚠ chips; codegen never reads it.
4. **`fs:highlight-mesh`** (parent→iframe hot message) in `BRIDGE_SCRIPT_TEMPLATE`'s switch
   ([tslToPreviewHTML.ts:1050-1083](src/engine/tslToPreviewHTML.ts)): swap ONE shared flat-emissive
   material onto name-matches, restore on null/timeout, stash cleared on `shader-applied` so a
   mid-apply highlight can't be captured into `originalMaterials`. Material swaps are the loader's
   normal live path — verified live in the browser pass (a second module re-applied cleanly after
   the per-object-uniform shader). (Corrected on verification: the r184 WebGPU crash is specific to
   MODEL swaps crossing the OBJ↔primitive boundary via setAttribute; primitive↔primitive geometry
   and subdivision changes are deliberately hot-swapped live via `fs:geometry` and are safe —
   [ShaderPreview.tsx:1131-1139](src/components/Preview/ShaderPreview.tsx#L1131-L1139).)

## The three candidate designs

### A — Multiple Output nodes, each with a "Target mesh" selector (the user's sketch) — ~11-13 d
One canvas; exactly one DEFAULT Output (no target = shades every unclaimed mesh = today); extra
Outputs carry `OutputNodeData.meshTarget = { name }` (top-level field, NOT in `values`; rides
history/autosave/project-embed for free; sanitized on both restore paths in the `edgeExtras` mold).
ONE codegen run emits ONE module: shared subgraphs once (single `claimName` namespace keeps
uniform/mic/schema contracts intact), default channels byte-identical to today, targeted Outputs as
an additive `parts: { "<meshName>": {channels…} }` return key that exists ONLY when a binding does.
**shaderloader 0.6** (0.5's bytes untouched — it's live on jsdelivr `@master` for every shipped
export) dispatches parts by `node.name`, all-matches; unmatched → default; no default → keep
authored glTF materials. Old 0.5 pages ignore `parts` → today's behavior. codeToGraph grows a parts
inverse (each entry → an Output with that target) and `mergeMatch` re-keys Output pairing on target
name — **emission + inverse must land atomically** or every Apply deletes/swaps secondary outputs.

Risks: the parser inverse is the single riskiest change (every narrow matcher becomes
per-output-scoped); **~12 find-first-Output call sites** each become a silent wrong-material bug if
missed (`nodeCost.ts:103`, `connectedUniforms.ts:55`, `ShaderSettingsMenu.tsx:32`,
`CodeEditor.tsx:55`, `ShaderPreview.tsx:254/282`, `exportShader.ts:98`, `PreviewLink.tsx:33`,
`useSyncEngine.ts:371`, `useAppStore.ts:1681`, `codeToGraph.ts:359`, `projectImport.ts:206`); the
documented `mergeMatch` materialSettings leak multiplies ×N and must be fixed FIRST; a third loader
version rule; cost = max(per-output) needs calibration; per-part transparency ordering undesigned.

### B — Material documents + assignment table in the preview pane (Blender/Unity-style) — ~16-21 d
Canvas keeps ONE Output; app grows `materials: MaterialDoc[]` (each a full single-Output graph),
`activeMaterialId`, and a persisted `meshAssignments` name→materialId map surfaced as a table in the
preview pane (rows = inventory meshes, hover-highlight, ⚠ orphans never auto-pruned). Switching
materials swaps the canvas via the `applyProjectToStore` recipe. Assembly runs graphToCode once per
doc with a seeded name namespace, emits the same additive `targets` key, same shaderloader 0.6.
Sell: **zero sync-engine changes**. Hidden taxes: uniform rename-maps at assembly (silent-failure
surface in fs:uniform routing/schema/tuning keys), store multiplication (history-by-reference doc
immutability, stash/substitute-at-read, cross-doc image caps, localStorage quota ×N), and **no
cross-material sharing** (a shared noise chain is copy-pasted, double-compiled, double-counted).

### C — Single material, `meshSwitch` node branching on a per-object mesh id — ~6.5-8.5 d
Keep everything: one Output, one module, one material, shaderloader 0.5 AS-IS. A new variadic
`meshSwitch` registry node (logic category, like `append`; bindings in `values.bindN`) routes
sub-graphs per mesh. The id is a per-object TSL uniform resolved from the mesh's own name:
`float(uniform(-1).onObjectUpdate((f) => tbl.has(f.object.name) ? tbl.get(f.object.name) : -1))`
with `tbl = new Map([["Body",0],…])` (Map constructor + JSON.stringify is load-bearing — an
object-literal table would make a hostile binding named `__proto__` a prototype setter in code the
XR popup executes at the real origin; executed: the Map form is inert for `__proto__`, `*/`, and a
raw U+2028 — the U+2028 case is legal via ES2019 string-literal rules, NOT via JSON.stringify
escaping, which passes it through raw). Emitted with function-form nested `select`s.
**The doubted mechanics are now EXECUTED, not just source-read** (see Verification results):
`uniformLineRe` ([tslCodeProcessor.ts:626-627](src/engine/tslCodeProcessor.ts#L626-L627)) is
$-anchored and does not match the emitted line (run verbatim); 0.5's `autoDetectSchema` regex
(0.5.js:550) does not match it either, and the `float()` wrapper is **empirically load-bearing** —
without it the loader mints a spurious `meshswitch1_id` number property; the fallback really arms
for property-less modules (buildShaderModule never emits an empty schema, and the loader
autodetects on absent schema). New constraint discovered: **the `onObjectUpdate` arrow body must
stay on ONE physical line** — `parseBody`'s per-line `/^return\s+(.+);$/` would hijack a multi-line
arrow's inner `return` as the color channel. Also corrected: `values.bind0…bindN` would NOT ride
`chainOperands`' slot compaction automatically (`chainPortIndex('bind0')` is −1) — the binding keys
must use the chain port naming (`a`…`z`) or ship their own compaction on disconnect.

Why it wins near-term: per-mesh looks on ALL FOUR surfaces (preview, XR popup, podest, exported .js
on foreign pages — **including already-shipped 0.5 pages**) with zero loader/podest/XR changes, zero
sync surgery, one pipeline (no compile stutter), structurally byte-stable, honest cost (every branch
really runs per fragment). Hard ceiling, stated honestly: material-level state (transparent/side/
depthWrite/alphaTest/envNode) can NOT vary per mesh — opaque body + transparent visor is
inexpressible; untargeted meshes get the Default branch, never their authored glTF materials; a look
differing on 3 channels needs 3 parallel switches; Phase 1 is ONE-WAY through codeToGraph (Apply
demotes to selects + warning — the mic-node standing) until a Phase-3 `matchMeshSwitch` narrow
matcher (the `matchNoiseUnsignedRemap` mold) restores round-trip.

## Judge ranking and recommended path

Ranking: **C > A > B**. Recommendation — staged hybrid, C-first with A as the committed endgame and
B's UI grafted onto A:

- **Phase 0 (~1.5 d)**: the shared inventory/highlight infrastructure above. Transfers intact to any
  future design. Reserve the `meshTarget` field name + all-matches name vocabulary NOW so C's
  bindings match A's future parts keys (prevents a second migration).
- **Phase 1 (~4-5 d)**: ship `meshSwitch` HIDDEN via `editorVisibility.json` (the checkbox exists
  for exactly this), gated on two hard prerequisites: (1) `meshSwitchTslContract.test.ts` — build
  the emitted chain against real `three/tsl`, assert the line survives `buildShaderModule` verbatim
  AND fails loudly on BOTH detection regexes (comment at `uniformLineRe` naming the dependency);
  (2) a headless two-mesh render proving per-object ids land under the vendored A-Frame bundle on
  BOTH backends. **Prerequisite (2) has now been RUN and PASSED** (see Verification results) —
  what remains for it is only turning the throwaway probe into a repeatable test, plus Safari-proper
  and a real headset. Pin the Apply-demotion shape before unhiding. UI copy from day one:
  "Default = the rest of the model."
- **Phase 2 (when per-mesh MATERIAL state is actually requested — transparent visor, per-mesh env,
  keep-original)**: land Design A's architecture (multi-Output `meshTarget`, single codegen run,
  additive `parts`, shaderloader 0.6) with **B's assignment table in the preview pane as the primary
  UI** (a pure VIEW over per-Output meshTarget fields). Fix the `mergeMatch` materialSettings leak
  FIRST as a standalone prerequisite. `meshSwitch` stays useful post-A for data-variation-within-one-
  material; migration of switch graphs to multi-Output is accepted debt (splitting branches with
  shared upstream nodes is genuinely hard).

## Pre-existing bug found during review (worth fixing regardless)

The one-Output invariant is NOT enforced on copy/paste/duplicate: `pasteNodes`
([NodeEditor.tsx:694-722](src/components/NodeEditor/NodeEditor.tsx)) and the Ctrl+C/V/D handlers
(:748-763, :785-792) clone any selected node with no `registryType === 'output'` filter — a second
Output is creatable TODAY. Verified by execution (the whole paste/duplicate path was searched for a
filter; none exists), with three refinements from the verification pass: (1) deletion is armed only
after a MANUAL code edit — `useSyncEngine.ts:341-342` skips code→graph while
`code === lastSyncedCodeRef.current`, and the graph→code pass right after the paste refreshes that
ref, so the clone survives until the first Apply that follows any hand edit; (2) which duplicate
survives is deterministic — mergeMatch consumes candidates in old-array order, so the ORIGINAL
keeps its id and the pasted clone is dropped, but the clone's upstream feeder remains as a
disconnected node (its dead `const` is still emitted); (3) a fix cannot live in `addNode` —
`pasteNodes` writes via `setNodes` directly, so the filter belongs in pasteNodes/copy or a
setNodes-level normalization.

## Verification results (2026-08-13, second workflow — 7 agents, adversarial + executed)

Every claim in this document was re-checked against source with quoted lines, and the doubted
mechanics were EXECUTED rather than read. Outcome: **1 refuted, ~15 corrected in detail (substance
intact), everything else confirmed; no design-invalidating error found.**

**Executed — the headless two-mesh render (THE Phase-1 gate): PASS on both backends.** A probe
A-Frame scene using the real vendored bundle (`a-frame-180-a-01.min.js`, A-Frame 1.8.0 / three 184)
+ shaderloader 0.5, two boxes named `Body`/`Glass` under one `setObject3D('mesh')` group, shader
module carrying the exact meshSwitch emission shape. Measured pixels: Body = RGB(255,7,7),
Glass = RGB(7,7,255) — distinct per-object ids through ONE shared `MeshPhysicalNodeMaterial`
(same material uuid on both meshes, confirming the per-object uniform, not material duplication).
Ran on real WebGPU (headless Chrome grants a device by default in 2026) AND forced WebGL2
(`navigator.gpu` hidden → GLSLNodeBuilder — the Safari/XR-popup route). Re-applying a second plain
module afterwards worked (no wedge). Not exercised: WebKit/Safari itself, real headsets.

**Executed — node-side (temp vitest file, run green, deleted, tree clean):**
- The meshSwitch lines survive `buildShaderModule` VERBATIM; no schema entry is minted for the id,
  while a sibling `const speed = uniform(0.5);` IS rewritten to `params.speed` + schema (the pass ran).
- An unknown `parts:{…}` return key is silently dropped (`CHANNEL_TO_PROP` miss →
  `if (!prop) continue;` at tslCodeProcessor.ts:688-690; `parseBody` forwards unknown keys
  unfiltered, so the drop is end-to-end and diagnostic-free) — confirming Design A's loader/module
  work must land atomically.
- Two-Output round trip: graphToCode emits only the first Output (no warning anywhere);
  codeToGraph returns exactly ONE output node. Executed, not inferred.
- Both regex dodges run verbatim against the real files: `uniformLineRe` (626-627) and 0.5's
  `autoDetectSchema` (0.5.js:550) both NO-MATCH the emitted line; removing the `float()` wrapper
  makes autoDetect mint a spurious property — the wrapper is empirically load-bearing.
- `__proto__` / `*/` / U+2028 hostile binding names: Map-constructor emission is inert (prototype
  unpolluted); the object-literal alternative really is an Annex-B proto setter. U+2028 legality
  comes from ES2019, not from JSON.stringify (which passes it through raw).

**Refuted:** "GLTFLoader's sanitizer destroys non-ASCII / Latvian names" — see the corrected
platform-facts bullet above. Latvian names survive; only whitespace→`_` and `[ ] . : /` are altered.

**Corrected (substance intact):** graphToCode output-find is at :1359 (not :1353); `uniformLineRe`
at :626-627; the CHANNEL_TO_PROP drop at :688-690; `FIT_BOUNDS_SCRIPT` spans :380-618 (skinned/
instanced models take an Object3D-scaling fallback at :506-516 — still no merge/rename/reparent);
podest's loader URLs are built at :1861 and :2043 (script tags :1907/:2125); the find-first site in
useAppStore is at :1692; `snapshotOf` is defined at :402 and called from NINE sites (not four);
WoodNodeMaterial's callbacks read `frame.material`, not `frame.object` (the per-OBJECT variant is
demonstrated by the bundle's internal uniforms and by our own render); the vendored bundle has 10
`onObjectUpdate` occurrences (not 4); A-Frame #3420 is an acknowledged limitation, not an explicit
design refusal; Godot #85850 is closed (historical); WGSL `select()` evaluates both operands via the
general function-call rule (only `&&`/`||` short-circuit; argument order is `select(f, t, cond)` —
false FIRST), and Quest 3's stated GPU frame budget is ~13.8 ms at 72 Hz with <200 recommended draw
calls — which strengthens, not weakens, the "extra pipelines are negligible" argument.

**New constraints discovered:** the `onObjectUpdate` arrow body must stay on one physical line
(parseBody's `/^return\s+(.+);$/` per-line scan); `values.bind0…bindN` needs its own disconnect
compaction (chainOperands only handles `chainPortId` names); `buildShaderModule` never emits an
empty schema, so the loader's autoDetect fallback arms exactly on property-less modules — the
dodge is exercised on every property-less export; the callback's identifiers survive
`autoInjectTSLImports`, but emission should prefer non-colliding local names anyway.

## Open questions before implementation

- Pipeline-compile stutter for N NodeMaterials per rebuild/XR-entry on Quest — unmeasured; gates
  A/B activation; needs a ShaderCarousel calibration entry (the bench pages currently have no
  multi-mesh/multi-material vocabulary at all — check the bench CAN measure it first).
- ~~Per-object uniform under forced WebGL2~~ **RESOLVED** — rendered end-to-end on this machine on
  real WebGPU and forced WebGL2 (see Verification results). Remaining for Phase 1: turn the probe
  into a repeatable test, and exercise Safari-proper + a real headset.
- Shared TSL node DAG referenced by N materials in one scene (decisive for A/B's single-module
  format; if sharing fails, per-part node cloning is needed and the shared-subgraph advantage
  collapses). Never executed — only matters for Phase 2.
- Whether `fs:model-meshes` should ALSO carry material names as a second targeting vocabulary —
  cheap in Phase 0, hard to retrofit into persisted bindings later. (Do it.)
- Per-part transparency ordering (opaque + transparent parts on one model) vs the auto-managed
  opacity/transparent coupling — needs a spike before A's Phase 2.
- WGSL `select()` superset-execution register pressure with 8-case chains on Quest tiled GPUs —
  needs a calibration k-sweep before `complexity.json` can price `meshSwitch`.

## Product-layer gaps the critic flagged (unaddressed by all three designs)

- **Touch/iPad**: highlight is designed on picker HOVER, which doesn't exist on touch — needs
  tap-to-highlight or the feature is authoring-dead on iPad.
- **i18n**: every new UI string needs lv.json coverage; untranslatable authored mesh names mixed
  into translated chrome unconsidered.
- **First-run discoverability**: nothing announces "this model has N meshes — you can target them"
  (the imageConvert top-centre one-liner + "?" panel is the precedent).
- **"Keep original glTF material"** as an explicit picker option (loader retains
  `originalMaterials`; podest already ships a shader-vs-original toggle) — only used as implicit
  fallback in A/B; impossible in C.
- **Seeding a starting shader from the mesh's authored PBR material** (baseColor/metallic/roughness
  → property nodes) — the unexplored "create shaders FOR the objects" half of the question.
- **Raycast click-the-mesh-in-the-preview assignment** — arguably the most direct UX; deferred with
  zero analysis (plausible via existing fs:camera/fs:preview-drag precedents).
- One-look-per-node surfaces (OutputCardContent, GraphModal, NODE_DESIGN_REQUIREMENTS checklist for
  any on-node target chip), Monaco completions for the new return keys, layoutEngine with multiple
  sinks, feedbackReport's technical block, .gltf-with-external-buffers enumeration, undo tracing for
  B's material switch.

Full agent output (200 KB, all file:line evidence): workflow run `wf_5bbf8559-75e`, 2026-08-13
(session-scoped; this document is the durable distillation).
