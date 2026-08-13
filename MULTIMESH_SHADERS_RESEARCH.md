# Multi-mesh glTF → per-mesh shaders: feasibility research (2026-08-13)

Research only — nothing implemented. Question: user drops a glTF/GLB with multiple meshes;
how do they author SEVERAL shaders and assign each to a sub-mesh (e.g. a mesh selector on the
Output node)? Produced by a 10-agent workflow (5 codebase/prior-art researchers, 3 competing
architectures, adversarial judge + completeness critic). All file:line refs verified at research time.

## Verdict

**Feasible and realistic.** Sub-mesh identity already survives the whole pipeline: `FIT_BOUNDS_SCRIPT`
only swaps cloned geometry and zeroes transforms — it never merges, renames, or reparents Mesh
nodes ([tslToPreviewHTML.ts:492-613](src/engine/tslToPreviewHTML.ts)) — so authored glTF names and
hierarchy reach the loader intact on every surface. The single flattening point is
`applyMaterialToMesh` in shaderloader 0.5, which traverses and stamps ONE `MeshPhysicalNodeMaterial`
on every `node.material` (0.5.js:480-486), keeping `originalMaterials` by uuid (0.5.js:473-479).
`graphToCode` keeps only the FIRST Output node (`sorted.find`, [graphToCode.ts:1353](src/engine/graphToCode.ts));
extra Outputs are silently ignored today.

## Platform facts that shape the design

- **glTF binds materials per PRIMITIVE**, not per mesh/node; GLTFLoader makes one `THREE.Mesh` per
  primitive (multi-primitive mesh → a Group of Meshes). "Target mesh" really means "target
  primitive-level Mesh". Draw calls do NOT increase with N materials — a multi-part model already
  issues one draw per primitive.
- **Names are the fragile key**: glTF names are optional and non-unique; GLTFLoader rewrites them
  (`PropertyBinding.sanitizeNodeName` strips non-ASCII — **Latvian mesh names arrive mangled** — plus
  `_N` dedupe), and instanced nodes still produce duplicate child names (three.js #30090). Stable
  spec-level addressing exists as `parser.associations` (mesh index + primitive index) and is what
  `KHR_materials_variants` uses. Design consequence: **name-with-all-matches semantics**, traversal
  index only as a session-local disambiguator, ⚠ chips for orphaned bindings (Godot #85850 is the
  documented rot mode for index-keyed assignment on re-export).
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
   normal live path (geometry swaps are what crash the live r184 WebGPU scene).

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
XR popup executes at the real origin). Emitted with function-form nested `select`s.
**All three doubted platform claims were CONFIRMED by the judge's source reads**: `uniformLineRe`
(tslCodeProcessor.ts:623-624) is $-anchored and won't rewrite the line; 0.5's `autoDetectSchema`
regex requires `= uniform(` immediately after the assignment so the `float()` wrapper dodges it
(and the dodge IS exercised — 0.5.js:118 falls back to autoDetect on absent OR empty schema);
`onObjectUpdate`/per-object `objectGroup`/`NodeFrame.object` all exist in the vendored r184 bundle,
and three's own WoodNodeMaterial uses the identical shared-material per-object-uniform pattern.

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
  BOTH backends (WebGPU AND forced-WebGL2 — the one thing repo reads could not confirm). Pin the
  Apply-demotion shape before unhiding. UI copy from day one: "Default = the rest of the model."
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
Output is creatable TODAY, and the next code-panel Apply silently deletes it.

## Open questions before implementation

- Pipeline-compile stutter for N NodeMaterials per rebuild/XR-entry on Quest — unmeasured; gates
  A/B activation; needs a ShaderCarousel calibration entry (the bench pages currently have no
  multi-mesh/multi-material vocabulary at all — check the bench CAN measure it first).
- Per-object uniform under forced WebGL2 (GLSLNodeBuilder — Safari/XR-popup route): verified in
  source, never rendered end-to-end. Hard prerequisite for C.
- Shared TSL node DAG referenced by N materials in one scene (decisive for A/B's single-module
  format; if sharing fails, per-part node cloning is needed and the shared-subgraph advantage
  collapses). Never executed.
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
