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
import { exceedsImageBudget, sanitizeImageNodes } from '@/utils/imageNode';
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
  isSplatKind,
  sanitizeMeshFileName,
  splatEvalRefusal,
  type MeshRefusal,
  type MeshRejectReason,
  type PreviewMesh,
} from '@/utils/previewMesh';
import { isEvalMode } from '@/eval/evalMode';
import { assetLiteralText, readGlbFsExtras } from '@/utils/glbShaderExtras';
import { readGltfModel } from '@/utils/gltfReader';
import { planTextureStrip, stripGltfTextures } from '@/utils/gltfStrip';
import { contributingOutputs, gltfIndexOf, outputMaterials, sanitizeOutputMaterials } from '@/utils/outputMaterials';
import type { ImportNoteLine } from '@/utils/importNote';
import { extractProjectState, type FastShadersProject } from './fastShadersProject';
import { moduleImageLiterals, resolveProjectImageRefs, splitImageLosses } from './projectImageRefs';
import { droppedGroupLabel, sanitizeDroppedName, shaderDropStem } from '@/utils/shaderDropName';
import { planShaderGroup } from './shaderGroupImport';
import { splatStarterNode } from '@/utils/splatGraphStart';
import type { AppEdge, AppNode, MaterialSettings } from '@/types';

/** Queue a counted limit notice; a zero count queues nothing. */
function enqueueCount(
  kind: 'images-stripped' | 'images-missing' | 'output-sections-trimmed',
  count: number,
): void {
  if (count <= 0) return;
  useAppStore.getState().enqueueLimitNotice({ id: generateId(), kind, detail: String(count) });
}

/**
 * An arriving graph's image payloads: a block's refs resolve against the file's
 * OWN copies (both passes, ONE budget per document), then the caps are applied.
 * `project` null is a bare script: no refs, `nodes` are bounded as they are.
 * A node left without pixels is counted ONCE, as `missing` when it carried a
 * top-level ref, otherwise as `stripped`. See docs/dev/images-and-textures.md.
 */
function ingestImages(
  project: FastShadersProject | null,
  moduleText: string,
  nodes: AppNode[],
  ignoreLimits: boolean,
): { nodes: AppNode[]; stripped: number; missing: number } {
  let dangling = 0;
  let losses = { missing: 0, alsoDangling: 0 };
  if (project) {
    const budget = newRefBudget();
    const fileRefs = resolveProjectImageRefs(project, moduleImageLiterals(moduleText), budget);
    const refs = resolveImageRefs(fileRefs.project.graph.nodes, undefined, budget);
    losses = splitImageLosses(fileRefs.project.graph.nodes, refs.nodes, fileRefs.unresolvedIds);
    dangling = refs.dangling;
    nodes = refs.nodes;
  }
  // Soft caps follow the platform (utils/platformCaps.ts); hard ceilings always apply.
  const images = sanitizeImageNodes(nodes, !ignoreLimits);
  return {
    nodes: images.nodes,
    stripped: images.strippedCount + dangling - losses.alsoDangling,
    missing: losses.missing,
  };
}

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
function applyProjectToStore(
  project: FastShadersProject,
  moduleText = '',
  nameFallback = '',
): void {
  const store = useAppStore.getState();
  store.pushHistory();

  // The AUTHORED name wins, the dropped file's stem is the fallback, and with
  // neither the name is not touched (utils/shaderDropName.ts). The block is
  // unvalidated JSON: a non-string name must not throw after `pushHistory`.
  const authored = typeof project.shaderName === 'string' ? project.shaderName : '';
  const adopted = sanitizeDroppedName(authored) || nameFallback;
  if (adopted) store.setShaderName(adopted);
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
  // Written even when ABSENT: an import replaces the graph, so it replaces the
  // tuning too (`property1` / `color1` collide across shaders by default).
  writeLs('fs:previewUniformValues', JSON.stringify(p.uniformValues ?? {}));
  writeLs('fs:previewUniformBounds', JSON.stringify(p.uniformBounds ?? {}));
  if (p.cameraPos) writeLs('fs:previewCameraPos', JSON.stringify(p.cameraPos));
  if (p.rotation) writeLs('fs:previewRotation', JSON.stringify(p.rotation));

  // Folded node types first (registry/legacyNodeTypes.ts), before anything
  // reads a def; then param ports that arrive with edges are exposed.
  project.graph.nodes = migrateLegacyNodeTypes(project.graph.nodes);
  autoExposeConnectedParamPorts(project.graph.nodes, project.graph.edges);

  // Imported files are adversarial input: image payloads are bounded before
  // they enter the store, and every picture that does not come back is announced.
  const images = ingestImages(project, moduleText, project.graph.nodes, store.ignoreImageLimits);
  enqueueCount('images-stripped', images.stripped);
  enqueueCount('images-missing', images.missing);

  // Data-node CSV blobs and Data Range formulas are bounded for SIZE here; the
  // grammar gate that stops a formula becoming code lives at the emitter.
  const dataSanitized = sanitizeDataNodes(images.nodes);
  dataSanitized.nodes = sanitizeDataRangeNodes(dataSanitized.nodes);

  // Per-mesh bindings reach GENERATED CODE. Emission re-validates every name;
  // this bounds what the STORE carries and COUNTS what it drops.
  const secs = sanitizeOutputMaterialsReport(dataSanitized.nodes);
  dataSanitized.nodes = secs.nodes;

  // Board drawings and palettes are adversarial too. An ABSENT palette block
  // sanitizes to [], which REPLACES the previous shader's palettes: they must
  // not ride onto an unrelated shader and into its next export.
  const drawings = sanitizeDrawings(project.drawings);
  const palettes = sanitizePalettes(project.palettes);

  // Edge `data` likewise: waypoints arrive unchecked, and TypedEdge maps them
  // during render (docs/dev/canvas-interaction.md).
  const edges = sanitizeEdgeExtras(project.graph.edges);

  // The restore chain: sanitize → unfold → normalize, then prune the `m<k>:`
  // wires no material owns (docs/dev/outputs-and-materials.md).
  const split = unfoldOutputMaterials(dataSanitized.nodes, edges);
  const nodes = normalizeActiveOutput(split.nodes);
  const prunedEdges = pruneOrphanMaterialEdges(nodes, split.edges).edges;
  // No slot: the words say "in the opened file".
  enqueueCount('output-sections-trimmed', secs.trimmed);

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

  // typeof guard: this module is also exercised by node-env unit tests.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('fs:project-imported'));
  }
  announceGraphImport();
}

/**
 * Tell the canvas an import just REPLACED the graph, so it frames the result.
 * Not `fs:project-imported`, which also fires for a model-only zip.
 */
function announceGraphImport(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('fs:graph-imported'));
}

/**
 * "Mesh with Materials": the model's materials BECOME the shader. It replaces
 * the GRAPH (nodes, wires, board drawings, the name) and keeps the DOCUMENT
 * (palettes, tuned uniforms, the Work-folder file), so it is not
 * `applyProjectToStore` and fires `fs:graph-merged`, never `fs:graph-imported`.
 * The budget counts an EMPTY graph and refuses BEFORE `pushHistory`; `proceed`
 * re-runs the commit, and `onCommitted` runs only once the graph changed.
 * Rule in CLAUDE.md (Dropped models); pinned by glbImportCommit.test.ts.
 */
export function commitGlbImport(
  project: FastShadersProject,
  mesh: PreviewMesh,
  opts?: { overBudgetOk?: boolean; onCommitted?: () => void },
): void {
  const store = useAppStore.getState();
  const built = project.graph;

  if (!opts?.overBudgetOk && exceedsImageBudget([], built.nodes, store.ignoreImageLimits)) {
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'image-total-cap',
      fileName: project.shaderName ?? '',
      proceed: () => commitGlbImport(project, mesh, { ...opts, overBudgetOk: true }),
    });
    return;
  }

  useAppStore.getState().setPreviewMesh(mesh);

  // The same ingestion passes every other path runs on arriving nodes: folded
  // node types before anything reads a def, param ports exposed for the edges
  // that land on them, and `edge.data` sanitized as adversarial input.
  built.nodes = migrateLegacyNodeTypes(built.nodes);
  autoExposeConnectedParamPorts(built.nodes, built.edges);
  const arrivingEdges = sanitizeEdgeExtras(built.edges);

  // The image BACKSTOP: the builder already encodes under the caps, and the
  // store boundary re-asserts them, like every path that brings payloads in.
  const images = sanitizeImageNodes(built.nodes, !store.ignoreImageLimits);
  built.nodes = images.nodes;
  enqueueCount('images-stripped', images.strippedCount);

  useAppStore.getState().pushHistory();

  // The restore chain, in the order every restore path uses.
  const secs = sanitizeOutputMaterialsReport(built.nodes);
  const split = unfoldOutputMaterials(secs.nodes, arrivingEdges);
  const nodes = normalizeActiveOutput(split.nodes);
  useAppStore.setState({
    nodes,
    edges: pruneOrphanMaterialEdges(nodes, split.edges).edges,
    drawings: [],
    syncSource: 'graph',
    isUndoRedo: false,
  });
  enqueueCount('output-sections-trimmed', secs.trimmed);

  // The document carries the MODEL's name now (the next EXPORT is written
  // under it), bounded like every dropped name.
  const name = typeof project.shaderName === 'string' ? sanitizeDroppedName(project.shaderName) : '';
  if (name) useAppStore.getState().setShaderName(name);

  showCustomMesh();
  announceGraphMerged();
  opts?.onCommitted?.();
}

/**
 * "Clear graph" on a dropped Gaussian splat (`SplatGraphModal`): the nodes,
 * wires and board drawings are replaced by ONE active Splat Output
 * (`utils/splatGraphStart.ts`), and the DOCUMENT stays — name, palettes, tuned
 * uniforms, the Work-folder file — so, like `commitGlbImport`, it fires
 * `fs:graph-merged`, never `fs:graph-imported`. One undo entry. The preview
 * model is not touched: the caller loads the splat right after, in the same
 * tick, so the pane never sees the cleared graph without it.
 */
export function startSplatGraph(): void {
  useAppStore.getState().pushHistory();
  useAppStore.setState({
    nodes: [splatStarterNode()],
    edges: [],
    drawings: [],
    syncSource: 'graph',
    isUndoRedo: false,
  });
  announceGraphMerged();
}

/**
 * "The graph was replaced, but the DOCUMENT was not." The canvas frames the
 * result and ends Preview mode; the Work folder and the study telemetry,
 * which answer `fs:graph-imported`, deliberately do not hear this one.
 */
export const GRAPH_MERGED_EVENT = 'fs:graph-merged';

/** Announce `GRAPH_MERGED_EVENT`: `commitGlbImport`, `startSplatGraph` and `addDroppedShader`. */
function announceGraphMerged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(GRAPH_MERGED_EVENT));
}

/**
 * The converter is loaded on demand: `scriptToTSL` is the one thing on this
 * path that needs @babel/*. A failed load clears the in-flight promise, so a
 * later import retries.
 */
type ScriptToTSLModule = typeof import('./scriptToTSL');
let scriptToTSL: ScriptToTSLModule | null = null;
let scriptToTSLLoad: Promise<ScriptToTSLModule | null> | null = null;

/**
 * Fetch the converter chunk. A caller already on an async boundary pays for it
 * up front, which keeps importShaderText's bare-script branch synchronous.
 * Idempotent; resolves `null` when the chunk cannot be fetched.
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
 * A text import carries no model, so it CLEARS the session preview mesh (a
 * stale one would be bundled into the next export). The zip path passes
 * `keepPreviewMesh`: it has already set the archive's own mesh.
 *
 * Synchronous up to the return, the announcement included. Only the
 * bare-script CONVERSION can land later, on the first one of a session:
 * `await preloadShaderImport()` first to have it settled on return.
 */
export function importShaderText(
  text: string,
  opts?: {
    keepPreviewMesh?: boolean;
    nameFallback?: string;
    /** `extractProjectState(text)`, when the caller already ran it — a block
     *  with embedded images is megabytes of JSON, parsed once, not twice. */
    parsed?: ReturnType<typeof extractProjectState>;
  },
): 'project' | 'script' {
  const projectResult = opts?.parsed !== undefined ? opts.parsed : extractProjectState(text);
  // Clear AFTER the parse — an import that dies in extractProjectState (the
  // throw propagates to the caller's error surface) must not wipe the mesh.
  if (!opts?.keepPreviewMesh) useAppStore.getState().setPreviewMesh(null);
  if (projectResult) {
    applyProjectToStore(projectResult.project, projectResult.stripped, opts?.nameFallback ?? '');
    return 'project';
  }
  // A bare script's graph does not exist yet; the canvas ARMS its fit on this
  // event. Announced BEFORE the conversion, which may land a tick later: a
  // listener reading it inside its own synchronous bracket (the Work folder's
  // loadingRef) would miss a deferred dispatch.
  announceGraphImport();
  // A bare script carries no name, so the fallback is the only answer here.
  if (opts?.nameFallback) useAppStore.getState().setShaderName(opts.nameFallback);
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

/** Commit a converted bare script; also runs from the converter chunk's continuation. */
function applyConvertedScript(
  converted: { code: string; materialSettings?: MaterialSettings },
): void {
  const store = useAppStore.getState();
  // Stamp the file's OWN material settings (or `undefined`, which CLEARS the
  // previous shader's) on the Output BEFORE the code→graph pass: mergeMatch
  // carries whatever sits on the old node. See docs/dev/codegen.md § Alpha.
  //
  // A raw setState, not updateNodeData (that pushes history and sets
  // syncSource 'graph'). `syncSource: 'code'` is LOAD-BEARING: with 'graph' the
  // graph→code effect runs first and overwrites the imported `code` with a
  // regeneration of the OLD graph. Nodes are rebuilt by spread, never mutated:
  // subscribers compare `materialSettings` BY REFERENCE.
  useAppStore.setState((s) => ({
    // ONE Output only, the one the module READS these keys off
    // (`moduleSettingsOutput`), so they land where the next export looks.
    nodes: ((active) => s.nodes.map((n) =>
      n.id === active
        ? { ...n, data: { ...n.data, materialSettings: converted.materialSettings } }
        : n,
    ))(moduleSettingsOutput(s.nodes)?.id) as AppNode[],
    // A bare script carries no palettes, so the previous shader's must go.
    shaderPalettes: [],
    syncSource: 'code',
    // Every nodes-writing path clears this. Load-bearing HERE: with
    // syncSource 'code' the graph→code effect never reaches the `finally` that
    // clears it, and pushHistory bails while it is set (no undo for the import).
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

/**
 * Every `MeshRejectReason`, as a table TYPED over the union: a reason added
 * there (a new model kind brought eight) fails `tsc` here until it is listed,
 * so the name-based fallback below can never silently stop recognising one.
 */
const SKIP_REASON_TABLE: Readonly<Record<MeshRejectReason, true>> = {
  unsupported: true,
  empty: true,
  'too-large': true,
  'bad-glb': true,
  compressed: true,
  'bad-splat': true,
  'splat-count': true,
  'ply-not-splat': true,
  'ply-sh': true,
  'ply-compressed': true,
  'spz-version': true,
  'gltf-splat': true,
  'splat-eval': true,
};
const SKIP_REASONS: ReadonlySet<unknown> = new Set(Object.keys(SKIP_REASON_TABLE));

/**
 * The zip's model entry as a preview mesh, or the refusal a drop of the same
 * file would get. `study` is the study-session switch (`isEvalMode()` at the
 * one caller), a parameter so a node test can hold it: a study session takes
 * no Gaussian splat (D10), refused on the KIND alone — before the sniff, the
 * way the preview drop refuses one before its pre-read gate.
 */
export function zipModelOutcome(
  entryName: string,
  data: Uint8Array,
  study: boolean,
): { mesh: PreviewMesh } | { refusal: MeshRefusal } {
  const fileName = entryName.split('/').pop() ?? entryName;
  if (study && isSplatKind(detectMeshKind(fileName))) return { refusal: splatEvalRefusal() };
  const result = createPreviewMesh(fileName, data);
  return 'mesh' in result ? { mesh: result.mesh } : { refusal: result.refusal };
}

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
 * A zip's entries, or null when the archive is unreadable/corrupt. THROWS
 * `ZipLimitError` on a reader cap, including the pre-read size gate: a gigabyte
 * drop must not be allocated just to be refused.
 */
async function readZipEntries(file: File): Promise<ZipReadEntry[] | null> {
  if (file.size > READ_MAX_ARCHIVE_BYTES) {
    throw new ZipLimitError('total-size', READ_MAX_TOTAL_UNCOMPRESSED, file.size, 'archive too large');
  }
  try {
    return await readZip(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    if (isZipLimitError(e)) throw e;
    return null;
  }
}

/**
 * The archive's shader script (`.js`/`.mjs`/`.tsl`): the one carrying a project
 * block wins, otherwise the first. Null = no script at all.
 */
function pickShaderScript(entries: ZipReadEntry[], skipJunk: boolean): string | null {
  const dec = new TextDecoder();
  const scripts = entries
    .filter((e) => /\.(js|mjs|tsl)$/i.test(e.name) && !(skipJunk && isJunkEntry(e.name)))
    .map((e) => dec.decode(e.data));
  if (scripts.length === 0) return null;
  return scripts.find((t) => t.includes('FASTSHADERS_PROJECT_V1')) ?? scripts[0];
}

/**
 * Import a FastShaders `.zip` export: its shader script goes through the
 * normal text import, and a model in it becomes the preview mesh.
 *
 * - Resolves null when the archive is unreadable, or holds neither a script
 *   nor a model: the caller owns that "no shader" message.
 * - THROWS `ZipLimitError` on a reader cap and `ZipModelSkippedError` for a
 *   model-only zip whose model is refused, both before any store write.
 * A refused model beside a script is not a refusal: the shader loads and the
 * import note says why the model was skipped.
 */
export async function importShaderZip(
  file: File,
  opts?: { nameFallback?: string },
): Promise<'project' | 'script' | 'model' | null> {
  // A cap is actionable and every surface announces it; corruption keeps the
  // historical null ("no shader").
  const entries = await readZipEntries(file);
  if (!entries) return null;

  // A model in the archive becomes the custom preview mesh (the mesh-carrying
  // export writes one under models/). Entry names are attacker-controlled;
  // createPreviewMesh validates and sanitizes at this boundary.
  const modelEntry = entries.find((e) => !isJunkEntry(e.name) && detectMeshKind(e.name) !== null);
  let mesh: PreviewMesh | null = null;
  // A refused model no longer vanishes. 'unsupported' cannot happen here (the
  // entry was picked BY its extension), so it is not reported.
  let skipped: { refusal: MeshRefusal; bytes: number } | null = null;
  if (modelEntry) {
    // A splat in a study session is skipped like any refused model — beside a
    // script the shader loads and the import note says why; alone, the zip
    // is refused with that reason.
    const outcome = zipModelOutcome(modelEntry.name, modelEntry.data, isEvalMode());
    if ('mesh' in outcome) mesh = outcome.mesh;
    else if (outcome.refusal.reason !== 'unsupported') {
      skipped = { refusal: outcome.refusal, bytes: modelEntry.data.length };
    }
  }

  // Junk entries are NOT skipped here (unlike ADD's read): unchanged behaviour.
  const script = pickShaderScript(entries, false);
  if (script === null) {
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

  // This path is already async, so pay for the on-demand converter chunk HERE
  // rather than letting importShaderText defer its bare-script branch: the mesh
  // handshake below is ordered around that branch having already run. A zip
  // carrying a project block never reaches the converter, so it never loads it.
  if (!script.includes('FASTSHADERS_PROJECT_V1')) await preloadShaderImport();

  // Set (or CLEAR) the mesh BEFORE the text import, so the prefs re-read that
  // applyProjectToStore dispatches describes the archive's own model.
  useAppStore.getState().setPreviewMesh(mesh);
  const imported = importShaderText(script, {
    keepPreviewMesh: true,
    nameFallback: opts?.nameFallback,
  });
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

/* ── the dropped-shader dialog: OPEN and ADD ─────────────────────────────── */

/**
 * A dropped shader file has TWO answers (`Modals/ShaderImportModal.tsx`): OPEN
 * replaces the document and adopts a name; ADD parks the shader beside the
 * graph in one group frame, wired to nothing.
 * See docs/dev/graph-and-store.md § A dropped shader ASKS.
 */

/**
 * The shader script inside a dropped file, WITHOUT touching the store (an Add
 * must not swap the mesh on screen). Null = no shader script; the zip reader's
 * caps still THROW.
 */
async function readDroppedShaderText(file: File): Promise<string | null> {
  if (!isZipFile(file)) return file.text();
  const entries = await readZipEntries(file);
  return entries && pickShaderScript(entries, true);
}

/**
 * OPEN: today's import, plus the name. Returns what `importShaderText` /
 * `importShaderZip` return, so a caller's "no shader in that zip" branch is
 * unchanged. Throws exactly what they throw.
 */
export async function openDroppedShader(
  file: File,
): Promise<'project' | 'script' | 'model' | null> {
  const nameFallback = sanitizeDroppedName(shaderDropStem(file.name));
  if (isZipFile(file)) return importShaderZip(file, { nameFallback });
  const text = await file.text();
  // Pay for the converter chunk here, on the async boundary this path already
  // has, so a bare script's branch is settled when this resolves.
  const parsed = extractProjectState(text);
  if (!parsed) await preloadShaderImport();
  return importShaderText(text, { nameFallback, parsed });
}

export type ShaderAddOutcome =
  | { ok: true; added: number; droppedSinks: number; groupLabel: string }
  | { ok: false; reason: 'no-shader' | 'nothing-to-add' | 'parse-failed' | 'over-budget' };

/**
 * The arriving graph an ADD is about: a project block's own nodes and edges,
 * or a bare script parsed back to a graph and laid out (`autoLayout`, which the
 * OPEN path's sync gives it). `codeToGraph` and `layoutEngine` load on demand.
 */
async function droppedShaderGraph(
  text: string,
): Promise<{ nodes: AppNode[]; edges: AppEdge[]; moduleText: string; project: FastShadersProject | null } | null> {
  const projectResult = extractProjectState(text);
  if (projectResult) {
    return {
      nodes: projectResult.project.graph.nodes,
      edges: projectResult.project.graph.edges,
      moduleText: projectResult.stripped,
      // The WHOLE block: its top-level `imageRefs` name the module literals.
      project: projectResult.project,
    };
  }
  const converter = await preloadShaderImport();
  if (!converter) return null;
  const { code } = converter.scriptToTSLWithSettings(text);
  const [{ codeToGraph }, { autoLayout }] = await Promise.all([
    import('./codeToGraph'),
    import('./layoutEngine'),
  ]);
  const parsed = codeToGraph(code);
  // A warning still yields a graph (the sync engine's own rule); anything
  // else means there is nothing trustworthy to add.
  if (parsed.errors.some((e) => e.severity !== 'warning')) return null;
  if (parsed.nodes.length === 0) return null;
  return {
    nodes: autoLayout(parsed.nodes, parsed.edges),
    edges: parsed.edges,
    moduleText: '',
    project: null,
  };
}

/**
 * ADD: park the dropped shader beside the graph, in one group frame named
 * after the file, wired to nothing. The arrivals go through the same
 * sanitizers as every ingest path, except the Output ones (the planner drops
 * every sink). The image budget counts the LIVE graph plus the arrivals and is
 * checked BEFORE `pushHistory`. ONE undo entry; `fs:graph-merged`, never
 * `fs:graph-imported`. See docs/dev/graph-and-store.md § A dropped shader ASKS.
 */
export async function addDroppedShader(
  file: File,
  opts?: { overBudgetOk?: boolean },
): Promise<ShaderAddOutcome> {
  const text = await readDroppedShaderText(file);
  if (text === null) return { ok: false, reason: 'no-shader' };
  const graph = await droppedShaderGraph(text);
  if (!graph) return { ok: false, reason: 'parse-failed' };

  const store = useAppStore.getState();

  // Folded node types first — before anything reads a def.
  let nodes = migrateLegacyNodeTypes(graph.nodes);
  const edges = sanitizeEdgeExtras(graph.edges);
  autoExposeConnectedParamPorts(nodes, edges);

  // Image payloads, exactly as the OPEN path (applyProjectToStore) takes them.
  const images = ingestImages(
    graph.project && { ...graph.project, graph: { ...graph.project.graph, nodes, edges } },
    graph.moduleText,
    nodes,
    store.ignoreImageLimits,
  );
  nodes = sanitizeDataRangeNodes(sanitizeDataNodes(images.nodes).nodes);

  // The project image budget, counted on every path that ADDS a payload.
  if (!opts?.overBudgetOk && exceedsImageBudget(store.nodes, nodes, store.ignoreImageLimits)) {
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'image-total-cap',
      fileName: file.name,
      proceed: () => { void addDroppedShader(file, { overBudgetOk: true }); },
    });
    return { ok: false, reason: 'over-budget' };
  }

  const groupLabel = droppedGroupLabel(file.name);
  const plan = planShaderGroup({ nodes, edges }, store.nodes, groupLabel);
  if (!plan) return { ok: false, reason: 'nothing-to-add' };

  enqueueCount('images-stripped', images.stripped);
  enqueueCount('images-missing', images.missing);

  useAppStore.getState().pushHistory();
  useAppStore.setState((state) => ({
    // The frame BEFORE its members — React Flow requires a parent to precede
    // its children, and the planner already ordered the members that way.
    nodes: [plan.group, ...state.nodes, ...plan.members] as AppNode[],
    edges: [...state.edges, ...plan.edges] as AppEdge[],
    syncSource: 'graph' as const,
    isUndoRedo: false,
  }));
  announceGraphMerged();
  return {
    ok: true,
    added: plan.members.length,
    droppedSinks: plan.droppedSinks,
    groupLabel,
  };
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
 * The CONTRIBUTING SET after the unfold, never `findDefaultOutput`: the first
 * Output answered [] for every split document, so the preview copy kept every
 * texture the shader had already baked in.
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
 * The PROJECT wins when its block parses (the stored module text is then never
 * parsed); otherwise the MODULE takes the bare-script path. The preview copy is
 * the texture-stripped model. Everything that can refuse runs BEFORE the store
 * is touched, and the abort signal is checked after every await.
 * See docs/dev/models-and-gltf.md § A FastShaders single-GLB export is RESTORED.
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
