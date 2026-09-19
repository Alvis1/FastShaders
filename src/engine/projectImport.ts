/**
 * Shared shader/project import — one code path for every import surface: the
 * Load Script picker, the code panel's drop zone, the canvas drop, the 3D
 * preview drop and the desktop Work folder. `reportZipImportError` is the ONE
 * catch-side mapping all five call first, so a zip the reader refuses says why
 * on every surface instead of "no shader".
 *
 * Accepts a shader script — `.js`/`.mjs`/`.tsl`, with or without an embedded
 * FASTSHADERS_PROJECT_V1 block; raw editor-style TSL passes through
 * scriptToTSLWithSettings unchanged — or a FastShaders `.zip` export (the shader `.js` +
 * its images; the images ride inside the .js as data: URLs, so importing the
 * .js restores everything — the loose files exist for reuse/editing) — or,
 * restored only from the GLB import dialog, the shader stored inside a
 * FastShaders single-GLB export (`importShaderGlb`).
 */

import { useAppStore } from '@/store/useAppStore';
import { sanitizeImageNodes } from '@/utils/imageNode';
import { resolveImageRefs, newRefBudget } from '@/utils/imagePayloadRefs';
import { sanitizeDataNodes } from '@/utils/dataNode';
import { sanitizeDataRangeNodes } from '@/utils/dataRangeFormula';
import { sanitizeDrawings } from '@/utils/drawings';
import { sanitizePalettes } from '@/utils/palettes';
import { sanitizeEdgeExtras } from '@/utils/edgeExtras';
import {
  sanitizeOutputMaterialsReport,
  unfoldOutputMaterials,
  moduleSettingsOutput,
  pruneOrphanMaterialEdges,
} from '@/utils/outputMaterials';
import { normalizeActiveOutput } from '@/utils/sdfPartition';
import { migrateLegacyNodeTypes } from '@/registry/legacyNodeTypes';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { generateId } from '@/utils/idGenerator';
import {
  readZip,
  isZipLimitError,
  ZipLimitError,
  READ_MAX_ARCHIVE_BYTES,
  READ_MAX_TOTAL_UNCOMPRESSED,
  type ZipReadEntry,
} from '@/utils/zipReader';
import {
  createPreviewMesh,
  detectMeshKind,
  sanitizeMeshFileName,
  type MeshRefusal,
  type PreviewMesh,
} from '@/utils/previewMesh';
import { assetLiteralText, readGlbFsExtras } from '@/utils/glbShaderExtras';
import { readGltfModel } from '@/utils/gltfReader';
import { planTextureStrip, stripGltfTextures } from '@/utils/gltfStrip';
import { contributingOutputs, gltfIndexOf, outputMaterials, sanitizeOutputMaterials } from '@/utils/outputMaterials';
import type { ImportNoteLine } from '@/utils/importNote';
import { extractProjectState, type FastShadersProject } from './fastShadersProject';
import { moduleImageLiterals, resolveProjectImageRefs, splitImageLosses } from './projectImageRefs';
import type { AppNode, MaterialSettings } from '@/types';

/**
 * Apply a FastShaders project snapshot to the store. Graph state is restored
 * reactively; preview/iframe settings are written to localStorage and a
 * `fs:project-imported` event lets ShaderPreview re-read its in-memory state
 * from those keys.
 *
 * `moduleText` is the file WITHOUT its block (extractProjectState's
 * `stripped`): the module whose `data:` literals a block's `imageRefs` may
 * name. It is only scanned when the block has a ref to resolve.
 */
function applyProjectToStore(project: FastShadersProject, moduleText = ''): void {
  const store = useAppStore.getState();
  store.pushHistory();

  if (project.shaderName) store.setShaderName(project.shaderName);
  if (project.selectedHeadsetId) store.setSelectedHeadsetId(project.selectedHeadsetId);
  // Theme BEFORE canvas color: the canvas backdrop is now stored per-theme, so
  // setNodeEditorBgColor writes into the active theme's slot — set the theme
  // first, then the color lands where the project expects it.
  if (project.ui?.codeEditorTheme === 'vs' || project.ui?.codeEditorTheme === 'vs-dark') {
    store.setCodeEditorTheme(project.ui.codeEditorTheme);
  }
  if (project.ui?.nodeEditorBgColor) store.setNodeEditorBgColor(project.ui.nodeEditorBgColor);
  if (project.ui?.costColorLow) store.setCostColorLow(project.ui.costColorLow);
  if (project.ui?.costColorHigh) store.setCostColorHigh(project.ui.costColorHigh);

  const writeLs = (key: string, value: string | undefined | null) => {
    if (value === undefined || value === null) return;
    try { localStorage.setItem(key, value); } catch { /* quota / private mode */ }
  };
  const p = project.preview ?? {};
  if (p.geometry) writeLs('fs:previewGeometry', p.geometry);
  if (p.lighting) writeLs('fs:previewLighting', p.lighting);
  if (typeof p.subdivision === 'number') writeLs('fs:previewSubdivision', String(p.subdivision));
  if (p.bgColor) writeLs('fs:previewBgColor', p.bgColor);
  if (typeof p.playing === 'boolean') writeLs('fs:previewPlaying', String(p.playing));
  // Clearing when the block is ABSENT is the point: with no else-branch, a
  // shader that ships no tuning silently inherited the PREVIOUS shader's for
  // every same-named property — and `property1` / `color1` are the
  // auto-generated names, so a collision is the norm, not the exception. An
  // import replaces the graph; it must replace the tuning that belongs to it.
  writeLs('fs:previewUniformValues', JSON.stringify(p.uniformValues ?? {}));
  writeLs('fs:previewUniformBounds', JSON.stringify(p.uniformBounds ?? {}));
  if (p.cameraPos) writeLs('fs:previewCameraPos', JSON.stringify(p.cameraPos));
  if (p.rotation) writeLs('fs:previewRotation', JSON.stringify(p.rotation));

  // Every exposedPorts node (noise/Image/Output) auto-exposes param ports that
  // arrive with edges (see NODE_DESIGN_REQUIREMENTS.md), so files written
  // before the opt-in change keep their sockets rendering. Shared with the
  // localStorage-load and code-sync paths.
  // Folded node types (registry/legacyNodeTypes.ts) — before anything reads the def.
  project.graph.nodes = migrateLegacyNodeTypes(project.graph.nodes);
  autoExposeConnectedParamPorts(project.graph.nodes, project.graph.edges);

  // Imported files are adversarial input — bound image payloads before they
  // enter the store (soft caps skipped when the user opted out via the
  // ignore-limits checkbox; hard ceilings always apply). Stripped payloads
  // surface a notice with the re-import path spelled out.
  //
  // Stored image refs (utils/imagePayloadRefs.ts) resolve first, against the
  // file's OWN inline copies. An export made by 0.3.33 from a new-format
  // autosave carries them (0.3.33 keeps `imageRef` in memory and embeds it),
  // so those pixels come back; a ref can only ever point inside this file. One
  // that cannot be resolved is counted with the stripped images.
  //
  // Before that, a block's top-level `imageRefs` (engine/projectImageRefs.ts)
  // resolves against the module's own `data:` literals. Nothing writes that
  // field yet (EXPORT_IMAGE_REFS is off), so this reader lands ahead of the
  // writer. Both passes share ONE budget per document, so a small file cannot
  // expand to thousands of copies of one literal. A node left without pixels
  // is reported ONCE: `images-missing` if it carried a top-level ref,
  // otherwise `images-stripped`.
  const budget = newRefBudget();
  const fileRefs = resolveProjectImageRefs(project, moduleImageLiterals(moduleText), budget);
  const refs = resolveImageRefs(fileRefs.project.graph.nodes, undefined, budget);
  const losses = splitImageLosses(fileRefs.project.graph.nodes, refs.nodes, fileRefs.unresolvedIds);
  // Soft caps follow the platform through imageNode's constants (web 600K/3M,
  // desktop 6M/32M — utils/platformCaps.ts), so no argument is needed here.
  const sanitized = sanitizeImageNodes(refs.nodes, !store.ignoreImageLimits);
  const stripped = sanitized.strippedCount + refs.dangling - losses.alsoDangling;
  if (stripped > 0) {
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'images-stripped',
      detail: String(stripped),
    });
  }
  if (losses.missing > 0) {
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'images-missing',
      detail: String(losses.missing),
    });
  }

  // Data-node CSV blobs are adversarial too, and this is the path that matters:
  // a shared `.js`/`.zip` has no localStorage quota standing in front of it.
  // The cap is the construction bound, so a file this app wrote is untouched.
  const dataSanitized = sanitizeDataNodes(sanitized.nodes);

  // A Data Range formula is a user-authored string riding the same shared file.
  // Bounded here for size; the grammar gate that stops it becoming code lives at
  // the emitter, which every import path reaches by construction.
  dataSanitized.nodes = sanitizeDataRangeNodes(dataSanitized.nodes);

  // A per-mesh binding is a plain string riding the same shared file, and it
  // reaches GENERATED CODE — which the XR popup executes at the app's real
  // origin. Emission re-validates every name, so this bounds what the STORE
  // carries (history clones, the autosave, the next export) and de-dupes two
  // Outputs claiming one mesh.
  // The sanitizer COUNTS what it drops (sections past the caps, invalid
  // entries, names past a section's cap), announced below as
  // `output-sections-trimmed` once the graph has landed.
  const secs = sanitizeOutputMaterialsReport(dataSanitized.nodes);
  dataSanitized.nodes = secs.nodes;

  // Board drawings are adversarial too — bound them before they enter the store.
  const drawings = sanitizeDrawings(project.drawings);

  // Palettes likewise — names are RENDERED and ids become React keys / object
  // lookups, so a shared `.js` gets the same trust boundary a dropped palette
  // file gets.
  //
  // The ABSENT case is the point, and it mirrors the uniform-values reasoning
  // above: an absent block sanitizes to [], which REPLACES the current shader's
  // palettes rather than leaving them. Without that, opening someone else's
  // shader would silently adopt the palettes of whatever was open before — and
  // the very next export would ship them inside their file as if they belonged
  // to it.
  const palettes = sanitizePalettes(project.palettes);

  // Edge `data` likewise: `buildProjectState` embeds `state.edges` verbatim and
  // the block's element gate stops at source/target, so routing waypoints
  // arrive unchecked — and TypedEdge maps them during render with no error
  // boundary to catch it.
  const edges = sanitizeEdgeExtras(project.graph.edges);

  // ONE Output NODE per material: an Output carrying `data.materials` is split
  // into siblings on the BARE channel handles, with the edges that fed its
  // `m<k>:` handles re-pointed and re-ided. Runs on the SANITIZED nodes (so the
  // materials are validated before they are split) and the SANITIZED edges
  // (it re-points and re-ids some of them).
  //
  // This REPLACED `foldExtraOutputs`, which collapsed a one-Output-per-mesh
  // graph into one node: that legacy shape IS the target shape now — each extra
  // is a targeted Output on bare handles — so such a document loads natively
  // instead of being migrated, and `contributingOutputs` emits its parts.
  const split = unfoldOutputMaterials(dataSanitized.nodes, edges);
  // Exactly one active sink (utils/sdfPartition.ts) — normalised AFTER the
  // split, so the election runs over the node set that actually exists.
  const nodes = normalizeActiveOutput(split.nodes);
  // An `m<k>:` handle on a node that has no material k must not leave its wires
  // behind (never drawn, emitting nothing, an unscoped 008 every frame). After
  // the split a node has exactly one material, so this is every `m<k>:` handle
  // a hand-edited or foreign file left on an Output the split did not touch.
  const prunedEdges = pruneOrphanMaterialEdges(nodes, split.edges).edges;
  if (secs.trimmed > 0) {
    // No slot: the words say "in the opened file".
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'output-sections-trimmed',
      detail: String(secs.trimmed),
    });
  }

  // Restore graph last — switching syncSource to 'graph' will trigger
  // graphToCode in useSyncEngine, regenerating the editor code to match.
  useAppStore.setState({
    nodes,
    edges: prunedEdges,
    drawings,
    shaderPalettes: palettes,
    syncSource: 'graph',
    isUndoRedo: false,
  });

  // typeof guard: this module is also exercised by node-env unit tests — the
  // same guard announceGraphImport and showCustomMesh already carry. Without it
  // applyProjectToStore throws `ReferenceError: window is not defined` and the
  // whole project branch is untestable.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('fs:project-imported'));
  }
  announceGraphImport();
}

/**
 * Tell the canvas an import just REPLACED the graph, so it can frame the
 * result (NodeEditor listens; see its import-fit effect). Deliberately not
 * `fs:project-imported`: that one also fires for a model-only zip, where the
 * graph never changed and re-framing would throw away the user's viewport.
 *
 * typeof guard: this module is also exercised by node-env unit tests.
 */
function announceGraphImport(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('fs:graph-imported'));
}

/**
 * Commit a shader BUILT from a dropped model's materials (the GLB import
 * builder, `engine/gltfImport.ts`; the dialog of Phase 5 Step 9 is its only
 * caller). ONE undo entry (`applyProjectToStore`'s pushHistory), the same
 * restore-path sanitizers as any shared file, `fs:project-imported` then
 * `fs:graph-imported` — each once, since `applyProjectToStore` already ends
 * with `announceGraphImport` (a second call here would arm the canvas's
 * import auto-fit twice and log a second eval `import`).
 *
 * The texture-stripped mesh is set FIRST (`importShaderZip`'s order), so the
 * prefs re-read `applyProjectToStore` fires synchronously already describes
 * the document it is about. The geometry no longer DEPENDS on that order —
 * `shownGeometry` (components/Preview/previewGeometryPref.ts) derives the
 * no-mesh fallback from the live mesh at render, rather than the validator
 * downgrading a stored 'custom' — but the mesh-then-project order stays the
 * one every import path uses. `preview.geometry` is forced to 'custom'
 * whatever the builder wrote, so the model the sections were built for is what
 * the 3D view shows. "Model only" never comes here and fires nothing.
 */
export function commitGlbImport(project: FastShadersProject, mesh: PreviewMesh): void {
  useAppStore.getState().setPreviewMesh(mesh);
  applyProjectToStore({ ...project, preview: { ...(project.preview ?? {}), geometry: 'custom' } });
}

/**
 * `scriptToTSL` is the ONE thing on this path that needs @babel/* (its
 * `hoistParamUniforms` pass), and this module is imported by four boot-path
 * components — so a static import pinned the 805 KB / 202 KB gzip vendor-babel
 * chunk into the entry wave for a conversion that only runs when the user
 * actually opens a shaderloader `.js`. Loaded on demand instead.
 *
 * A failed load clears the in-flight promise so a later import retries rather
 * than the session being permanently unable to open a script.
 */
type ScriptToTSLModule = typeof import('./scriptToTSL');
let scriptToTSL: ScriptToTSLModule | null = null;
let scriptToTSLLoad: Promise<ScriptToTSLModule | null> | null = null;

/**
 * Fetch the converter chunk. Exported so a caller that is ALREADY on an async
 * boundary — every import surface is — can pay for it up front and keep
 * importShaderText's bare-script branch fully synchronous; `importShaderZip`
 * does exactly that. Idempotent, and resolves `null` when the chunk cannot be
 * fetched at all.
 */
export function preloadShaderImport(): Promise<ScriptToTSLModule | null> {
  if (scriptToTSL) return Promise.resolve(scriptToTSL);
  if (!scriptToTSLLoad) {
    scriptToTSLLoad = import('./scriptToTSL')
      .then((m) => { scriptToTSL = m; return m; })
      .catch(() => { scriptToTSLLoad = null; return null; });
  }
  return scriptToTSLLoad;
}

/**
 * Monotonic import token. The converter chunk can be in flight when a SECOND
 * import starts, and the first one's continuation must not then overwrite the
 * document the second one produced — last import wins, as it does today.
 */
let scriptImportSeq = 0;

/**
 * Import shader source text: a FASTSHADERS_PROJECT_V1 block restores the full
 * project; a bare shaderloader script is parsed back to TSL and re-synced.
 *
 * A text import carries no model, so it CLEARS any session preview mesh —
 * otherwise a stale mesh would silently satisfy the incoming project's
 * 'custom' geometry pref and get bundled into the next export's zip. The zip
 * path passes `keepPreviewMesh` because it decides mesh presence from the
 * archive itself (and must set the mesh BEFORE the prefs re-read fires).
 *
 * SYNCHRONY. Everything up to and including the return value is synchronous:
 * the project-block parse, the mesh clear, the whole project branch, and the
 * `fs:graph-imported` announcement on both branches. Only the bare-script
 * branch's CONVERSION can be deferred, and only on the very first one of a
 * session, while the on-demand converter chunk is fetched — `await
 * preloadShaderImport()` first if a caller needs that branch settled on return.
 */
export function importShaderText(
  text: string,
  opts?: { keepPreviewMesh?: boolean },
): 'project' | 'script' {
  const projectResult = extractProjectState(text);
  // Clear AFTER the parse — an import that dies in extractProjectState (the
  // throw propagates to the caller's error surface) must not wipe the mesh.
  if (!opts?.keepPreviewMesh) useAppStore.getState().setPreviewMesh(null);
  if (projectResult) {
    applyProjectToStore(projectResult.project, projectResult.stripped);
    return 'project';
  }
  // A bare script's graph doesn't exist yet — useSyncEngine's code→graph pass
  // builds it a commit or two from now. The canvas arms the fit on this event
  // and fires it on the graph it actually renders next, so announcing early is
  // correct here.
  //
  // It is announced BEFORE the conversion now rather than after it, because the
  // converter chunk is loaded on demand (preloadShaderImport) and the rest of
  // this branch may therefore land a tick later. Listeners that read "the graph
  // is being replaced" inside their own synchronous bracket would miss a
  // deferred dispatch — the desktop Work folder drops its tracked file exactly
  // that way, guarded by a loadingRef it clears when its own promise settles.
  // Nothing here reads store state those listeners write, so the move is inert
  // on the synchronous path.
  announceGraphImport();
  // Last import wins: a second one started while the chunk was in flight owns
  // the document, and this one's continuation must not overwrite it.
  const seq = ++scriptImportSeq;
  if (scriptToTSL) {
    applyConvertedScript(scriptToTSL.scriptToTSLWithSettings(text));
  } else {
    void preloadShaderImport().then((m) => {
      if (!m || seq !== scriptImportSeq) return;
      applyConvertedScript(m.scriptToTSLWithSettings(text));
    });
  }
  return 'script';
}

/**
 * Commit a converted bare script to the store. Split out of importShaderText
 * only so it can also run from the converter chunk's continuation; the body is
 * unchanged.
 */
function applyConvertedScript(
  converted: { code: string; materialSettings?: MaterialSettings },
): void {
  const store = useAppStore.getState();
  // A bare script carries its OWN material settings (transparency / side /
  // alpha clip) in its return object. scriptToTSL strips them out of the TSL —
  // graphToCode can't emit them — and useSyncEngine's mergeMatch then copied
  // the PREVIOUS graph's onto the matched Output node, so the import was wrong
  // in both directions: the file's settings vanished and a stale transparency
  // rode onto a shader that never asked for it.
  //
  // Stamp the file's settings — or, when it ships none, `undefined`, which is
  // what CLEARS the stale ones — onto the CURRENT Output node BEFORE the
  // code→graph pass. mergeMatch carries the OLD node's settings onto the new
  // one, so whatever sits on the node when that pass runs is what the imported
  // graph gets; no new mechanism, just correct input to the existing one.
  //
  // The value is a FRESH object (or undefined) and the node/data are rebuilt by
  // spread, never mutated: ShaderPreview, CodeEditor and mergeMatch all
  // subscribe to `materialSettings` BY REFERENCE and bail on Object.is, so an
  // in-place update would leave the preview and the A-Frame tab on the old
  // settings with no error.
  //
  // A raw setState, not updateNodeData: that would push a history entry (the
  // pass pushes its own) and set syncSource:'graph'. `syncSource: 'code'` is
  // LOAD-BEARING — the nodes array changes here, and with syncSource still
  // 'graph' the graph→code effect (declared before the code→graph one, so it
  // runs first) would see a non-inert change (sameGraphSemantics compares
  // `data` by reference) and overwrite the freshly-imported `code` with a
  // regeneration of the OLD graph.
  //
  // `mergeVertices` IS recovered now: it used to be preview-only and never
  // emitted, so an import reset it to its default; shaderloader 0.6 needs it at
  // runtime, so an explicit `false` is emitted into the module and read back
  // here. Absent still means true, which is what keeps a module that never
  // carried the key indistinguishable from a default one.
  // `displacementMode` IS recovered — but only because
  // scriptToTSLWithSettings distinguishes the two positionNode forms; without
  // that, importing an offset-displacement module would silently switch it to
  // normal mode. A raw editor-TSL file (the pass-through branch) carries no
  // settings at all, so importing one likewise clears them: editor TSL cannot
  // express them, and "the file is silent" is read as "the file says none".
  useAppStore.setState((s) => ({
    // ONE Output only: another keeps its own settings, exactly as it keeps its
    // wiring across the resync (useSyncEngine's carry). Which one is
    // `moduleSettingsOutput` — the same node the module READS these four keys
    // off (D1), so the settings an import recovers land where the next export
    // will look for them.
    nodes: ((active) => s.nodes.map((n) =>
      n.id === active
        ? { ...n, data: { ...n.data, materialSettings: converted.materialSettings } }
        : n,
    ))(moduleSettingsOutput(s.nodes)?.id) as AppNode[],
    // A bare script carries no palettes, so the previous shader's must go —
    // the same rule the preview mesh and materialSettings already follow on
    // this branch, and the one `applyProjectToStore` applies to a project
    // block that ships none. Without it the old palettes ride onto an
    // unrelated shader and are re-exported with it as if authored there.
    shaderPalettes: [],
    syncSource: 'code',
    // Mirrors setNodes — every nodes-writing path clears this. Load-bearing
    // HERE because of the line above: with syncSource !== 'graph' the
    // graph→code effect early-returns BEFORE the `finally` that clears the
    // flag — and pushHistory hard-bails while it is set, so doCodeSync's
    // snapshot would silently become a no-op and the import would be
    // unrecoverable by undo.
    isUndoRedo: false,
  }));
  store.setCode(converted.code, 'code');
  store.requestCodeSync();
}

export function isZipFile(file: File): boolean {
  return (
    /\.zip$/i.test(file.name) ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
  );
}

/**
 * A model-ONLY zip whose one model was refused: nothing was imported, and
 * "no shader" would be the wrong sentence. `refusal` is the same structured
 * refusal a preview drop of that model gets.
 */
export class ZipModelSkippedError extends Error {
  readonly refusal: MeshRefusal;
  readonly bytes: number;
  constructor(refusal: MeshRefusal, bytes: number) {
    super(`3D model skipped: ${refusal.reason}`);
    this.name = 'ZipModelSkippedError';
    this.refusal = refusal;
    this.bytes = bytes;
  }
}

const SKIP_REASONS: ReadonlySet<unknown> = new Set(['empty', 'too-large', 'bad-glb', 'compressed', 'unsupported']);

/** Name-based as well as `instanceof`, for the reason `isZipLimitError` gives
 *  (a second module instance is possible under `isolate: false`). */
export function isZipModelSkippedError(e: unknown): e is ZipModelSkippedError {
  if (e instanceof ZipModelSkippedError) return true;
  if (!(e instanceof Error) || e.name !== 'ZipModelSkippedError') return false;
  const r = (e as { refusal?: unknown }).refusal;
  if (!r || typeof r !== 'object') return false;
  const { reason, key } = r as { reason?: unknown; key?: unknown };
  return SKIP_REASONS.has(reason) && typeof key === 'string'
    && Number.isFinite((e as { bytes?: unknown }).bytes);
}

/**
 * The ONE mapping every import surface's catch calls FIRST. A typed zip
 * outcome is announced here — a reader cap as LimitModal's `zip-limit` notice
 * (a refusal with no checkbox: Ignore-limits cannot lift a reader cap), a
 * refused model in a model-only zip as the canvas import-note line — and the
 * function returns true, meaning the caller must show nothing else. Anything
 * else returns false and touches nothing, so the surface keeps its own text.
 */
export function reportZipImportError(e: unknown, fileName: string): boolean {
  const store = useAppStore.getState();
  if (isZipLimitError(e)) {
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'zip-limit',
      fileName,
      zipLimit: { kind: e.kind, limit: e.limit, value: e.value },
    });
    return true;
  }
  if (isZipModelSkippedError(e)) {
    store.showImportNote([{ kind: 'zip-model-skipped', shaderLoaded: false, fileName, refusal: e.refusal }]);
    return true;
  }
  return false;
}

/**
 * A shader import that ships a model always SHOWS it (podest's shader+model
 * pairing semantics): a script-only import never touches prefs, and an older
 * project block predating the mesh feature would otherwise leave the model
 * invisible. Writes the pref and (re-)fires the prefs re-read. Shared by the
 * zip import and the GLB restore.
 */
function showCustomMesh(): void {
  try { localStorage.setItem('fs:previewGeometry', 'custom'); } catch { /* quota / private mode */ }
  // typeof guard: this module is also exercised by node-env unit tests.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('fs:project-imported'));
  }
}

/** Zip housekeeping entries that must never win a file-pick (same as podest). */
function isJunkEntry(name: string): boolean {
  return name.includes('__MACOSX') || (name.split('/').pop() ?? '').startsWith('.');
}

/**
 * Import a FastShaders `.zip` export: locate the shader script inside
 * (`.js`/`.mjs`/`.tsl`; the one carrying the project block wins, otherwise the
 * first script) and run it through the normal text import.
 *
 * - Resolves null when the archive is unreadable/corrupt, or holds neither a
 *   script nor a model — the caller owns that "no shader" message.
 * - THROWS `ZipLimitError` when a reader cap is crossed, including this
 *   function's own pre-read gate (`READ_MAX_ARCHIVE_BYTES` — this build's
 *   reader cap plus header slack — checked before the
 *   file is read into memory).
 * - THROWS `ZipModelSkippedError` for a model-only zip whose model is refused.
 * Both throws happen before any store write, so "nothing was changed" holds.
 * A refused model beside a script is not a refusal: the shader loads and the
 * canvas import note says the model was skipped and why.
 */
export async function importShaderZip(file: File): Promise<'project' | 'script' | 'model' | null> {
  // Before `arrayBuffer()`: a gigabyte drop must not be allocated just to be
  // refused (the ShaderPreview model gate's pattern).
  if (file.size > READ_MAX_ARCHIVE_BYTES) {
    throw new ZipLimitError('total-size', READ_MAX_TOTAL_UNCOMPRESSED, file.size, 'archive too large');
  }
  let entries: ZipReadEntry[];
  try {
    entries = await readZip(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    // A cap is actionable and every surface announces it; corruption keeps
    // the historical null ("no shader").
    if (isZipLimitError(e)) throw e;
    return null;
  }

  // A model in the archive becomes the custom preview mesh (the mesh-carrying
  // export writes one under models/). Entry names are attacker-controlled;
  // createPreviewMesh validates and sanitizes at this boundary.
  const modelEntry = entries.find((e) => !isJunkEntry(e.name) && detectMeshKind(e.name) !== null);
  let mesh: PreviewMesh | null = null;
  // A refused model no longer vanishes. 'unsupported' cannot happen here (the
  // entry was picked BY its extension), so it is not reported.
  let skipped: { refusal: MeshRefusal; bytes: number } | null = null;
  if (modelEntry) {
    const result = createPreviewMesh(modelEntry.name.split('/').pop() ?? modelEntry.name, modelEntry.data);
    if ('mesh' in result) mesh = result.mesh;
    else if (result.refusal.reason !== 'unsupported') {
      skipped = { refusal: result.refusal, bytes: modelEntry.data.length };
    }
  }

  const dec = new TextDecoder();
  const scripts = entries.filter((e) => /\.(js|mjs|tsl)$/i.test(e.name)).map((e) => dec.decode(e.data));
  if (scripts.length === 0) {
    // Model-only zip: still a meaningful drop — load the mesh instead of
    // rejecting the archive outright (the caller treats 'model' as success).
    if (!mesh) {
      // Thrown before any store write: the surface says "the model was
      // skipped: <why>" rather than "no shader".
      if (skipped) throw new ZipModelSkippedError(skipped.refusal, skipped.bytes);
      return null;
    }
    useAppStore.getState().setPreviewMesh(mesh);
    showCustomMesh();
    return 'model';
  }
  const withProject = scripts.find((t) => t.includes('FASTSHADERS_PROJECT_V1'));

  // This path is already async, so pay for the on-demand converter chunk HERE
  // rather than letting importShaderText defer its bare-script branch: the mesh
  // handshake below is ordered around that branch having already run. A zip
  // carrying a project block never reaches the converter, so it never loads it.
  if (!withProject) await preloadShaderImport();

  // Set — or, when the archive has none, CLEAR — the mesh BEFORE the text
  // import: applyProjectToStore dispatches the prefs re-read synchronously, so
  // this is what makes that re-read describe the archive's own model. (The
  // geometry itself is derived from the live mesh now — previewGeometryPref.ts
  // — so the order is a clarity rule here, not a correctness one.)
  useAppStore.getState().setPreviewMesh(mesh);
  const imported = importShaderText(withProject ?? scripts[0], { keepPreviewMesh: true });
  if (mesh) showCustomMesh();
  // Only once the shader has loaded — an import that threw above must not
  // claim "the shader loaded".
  if (skipped) {
    useAppStore.getState().showImportNote([
      { kind: 'zip-model-skipped', shaderLoaded: true, fileName: file.name, refusal: skipped.refusal },
    ]);
  }
  return imported;
}

/* ── the GLB restore (Phase 7) ───────────────────────────────────────────── */

export type GlbRestoreResult =
  | { ok: true; imported: 'project' | 'script'; notes: ImportNoteLine[] }
  | { ok: false; reason: 'no-shader' | 'damaged' | 'aborted' }
  | { ok: false; reason: 'mesh-refused'; refusal: MeshRefusal };

/**
 * The glTF material indices the restored project CONTRIBUTES index sections
 * for, through the same sanitize → unfold chain `applyProjectToStore` runs, so
 * the texture strip matches what the store will hold. Never throws.
 *
 * The CONTRIBUTING SET, never `findDefaultOutput`. A stored project is the
 * split shape when a current build wrote it and the folded one when an older
 * build did, so the unfold runs first (with no edges: it only re-points them,
 * and this reads node data alone) and then every Output that emits is asked.
 * Reading the first Output instead answered [] for every split document —
 * conservative, so no texture was wrongly dropped, but the preview copy then
 * kept every texture the shader had already baked in.
 */
function indexSectionMaterialsOf(nodes: AppNode[]): number[] {
  try {
    const clean = sanitizeOutputMaterials(migrateLegacyNodeTypes([...nodes]));
    const set = new Set<number>();
    for (const out of contributingOutputs(unfoldOutputMaterials(clean, []).nodes)) {
      for (const m of outputMaterials(out)) {
        const i = gltfIndexOf(m);
        if (i !== null) set.add(i);
      }
    }
    return [...set].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * RESTORE the shader a FastShaders single-GLB export stores inside the model —
 * the ONE restore commit, reached only from the GLB import dialog's Restore
 * button (never in a study session, never for a model dropped with a shader).
 *
 * THE DISAGREEMENT RULE. When the project view parses, the PROJECT wins: its
 * block goes through extractProjectState and every applyProjectToStore
 * sanitizer, exactly as a `.js` with a block, and the stored module text is
 * never parsed (the graph regenerates it). The block's image refs resolve
 * against the GLB's own images, offered as scan-only `data:` literals
 * (`assetLiteralText`). With no usable project, the MODULE — its placeholders
 * inlined to canonical `data:` URLs by the reader — takes the bare-script
 * path, as a `.js` without a block. Podest, A-Frame pages and plain three run
 * the module; that asymmetry is the rule.
 *
 * THE MESH. The preview copy is the Phase 5 strip of the model for the
 * materials the restored project's index sections claim, which also reclaims
 * the payload views and the images only the module used; createPreviewMesh
 * then refuses anything over the model gate and drops any payload left.
 *
 * ORDER. Everything that can refuse runs BEFORE the store is touched, and the
 * abort signal is checked after every await; the commit is importShaderZip's
 * model-plus-script tail (mesh, text import, show the model), so it is ONE
 * undo entry and one `fs:graph-imported`. The mesh swap is not undoable (the
 * zip and NEW precedent).
 */
export async function importShaderGlb(
  fileName: string,
  bytes: Uint8Array<ArrayBuffer>,
  opts?: { signal?: AbortSignal },
): Promise<GlbRestoreResult> {
  const read = readGlbFsExtras(bytes);
  if (read.state !== 'ok') return { ok: false, reason: read.state === 'refused' ? 'damaged' : 'no-shader' };
  const sh = read.shader;
  const literals = assetLiteralText(sh.assets);
  const projectText = sh.projectText !== null ? `${literals}\n${sh.projectText}` : null;
  const projectResult = projectText !== null ? extractProjectState(projectText) : null;
  if (!projectResult && sh.moduleText === null) return { ok: false, reason: 'damaged' };
  const text = projectResult ? (projectText as string) : (sh.moduleText as string);

  if (!projectResult) await preloadShaderImport();
  if (opts?.signal?.aborted) return { ok: false, reason: 'aborted' };

  let meshBytes: Uint8Array<ArrayBuffer> = bytes;
  const model = readGltfModel(bytes, 'glb');
  if (model.ok) {
    try {
      const claimed = projectResult ? indexSectionMaterialsOf(projectResult.project.graph.nodes) : [];
      const plan = planTextureStrip(model.model, claimed);
      if (plan) meshBytes = stripGltfTextures(model.model, plan).bytes;
    } catch {
      // Keep the bytes: createPreviewMesh still drops the payload in place.
    }
  }
  const created = createPreviewMesh(fileName, meshBytes);
  if ('error' in created) return { ok: false, reason: 'mesh-refused', refusal: created.refusal };
  if (opts?.signal?.aborted) return { ok: false, reason: 'aborted' };

  useAppStore.getState().setPreviewMesh(created.mesh);
  const imported = importShaderText(text, { keepPreviewMesh: true });
  showCustomMesh();
  return {
    ok: true,
    imported,
    notes: [{ kind: 'glb-restored', fileName: sanitizeMeshFileName(fileName, 'glb'), imported }],
  };
}
