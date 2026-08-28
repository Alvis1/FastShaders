/**
 * Shared shader/project import — one code path for every import surface: the
 * Load Script picker, the code panel's drop zone, and the canvas drop.
 *
 * Accepts a shader script — `.js`/`.mjs`/`.tsl`, with or without an embedded
 * FASTSHADERS_PROJECT_V1 block; raw editor-style TSL passes through
 * scriptToTSLWithSettings unchanged — or a FastShaders `.zip` export (the shader `.js` +
 * its images; the images ride inside the .js as data: URLs, so importing the
 * .js restores everything — the loose files exist for reuse/editing).
 */

import { useAppStore } from '@/store/useAppStore';
import { sanitizeImageNodes } from '@/utils/imageNode';
import { sanitizeDataNodes } from '@/utils/dataNode';
import { sanitizeDataRangeNodes } from '@/utils/dataRangeFormula';
import { sanitizeDrawings } from '@/utils/drawings';
import { sanitizePalettes } from '@/utils/palettes';
import { sanitizeEdgeExtras } from '@/utils/edgeExtras';
import { sanitizeOutputMaterials, foldExtraOutputs } from '@/utils/outputMaterials';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { generateId } from '@/utils/idGenerator';
import { readZip, type ZipReadEntry } from '@/utils/zipReader';
import { createPreviewMesh, detectMeshKind, type PreviewMesh } from '@/utils/previewMesh';
import { extractProjectState, type FastShadersProject } from './fastShadersProject';
import { scriptToTSLWithSettings } from './scriptToTSL';
import type { AppNode } from '@/types';

/**
 * Apply a FastShaders project snapshot to the store. Graph state is restored
 * reactively; preview/iframe settings are written to localStorage and a
 * `fs:project-imported` event lets ShaderPreview re-read its in-memory state
 * from those keys.
 */
function applyProjectToStore(project: FastShadersProject): void {
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
  autoExposeConnectedParamPorts(project.graph.nodes, project.graph.edges);

  // Imported files are adversarial input — bound image payloads before they
  // enter the store (soft caps skipped when the user opted out via the
  // ignore-limits checkbox; hard ceilings always apply). Stripped payloads
  // surface a notice with the re-import path spelled out.
  const sanitized = sanitizeImageNodes(project.graph.nodes, !store.ignoreImageLimits);
  if (sanitized.strippedCount > 0) {
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'images-stripped',
      detail: String(sanitized.strippedCount),
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
  dataSanitized.nodes = sanitizeOutputMaterials(dataSanitized.nodes);

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

  // A project written by the multi-Output design (or hand-edited to look like
  // one) is folded into the single-node shape, keeping the edges that fed the
  // extras — otherwise those Outputs sit on the canvas emitting nothing and
  // whatever was wired into them is silently lost. Runs on the SANITIZED edges,
  // since it re-points and re-ids some of them.
  const folded = foldExtraOutputs(dataSanitized.nodes, edges);

  // Restore graph last — switching syncSource to 'graph' will trigger
  // graphToCode in useSyncEngine, regenerating the editor code to match.
  useAppStore.setState({
    nodes: folded.nodes,
    edges: folded.edges,
    drawings,
    shaderPalettes: palettes,
    syncSource: 'graph',
    isUndoRedo: false,
  });

  // typeof guard: this module is also exercised by node-env unit tests — the
  // same guard announceGraphImport and showMesh already carry. Without it
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
 * Import shader source text: a FASTSHADERS_PROJECT_V1 block restores the full
 * project; a bare shaderloader script is parsed back to TSL and re-synced.
 *
 * A text import carries no model, so it CLEARS any session preview mesh —
 * otherwise a stale mesh would silently satisfy the incoming project's
 * 'custom' geometry pref and get bundled into the next export's zip. The zip
 * path passes `keepPreviewMesh` because it decides mesh presence from the
 * archive itself (and must set the mesh BEFORE the prefs re-read fires).
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
    applyProjectToStore(projectResult.project);
    return 'project';
  }
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
  // in-place update would leave the preview and the Output tab on the old
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
  // NOT recoverable from the module text and therefore RESET to its default
  // by this stamp: `mergeVertices` (preview-only, never emitted; absent ===
  // true). `displacementMode` IS recovered — but only because
  // scriptToTSLWithSettings distinguishes the two positionNode forms; without
  // that, importing an offset-displacement module would silently switch it to
  // normal mode. A raw editor-TSL file (the pass-through branch) carries no
  // settings at all, so importing one likewise clears them: editor TSL cannot
  // express them, and "the file is silent" is read as "the file says none".
  const converted = scriptToTSLWithSettings(text);
  useAppStore.setState((s) => ({
    nodes: s.nodes.map((n) =>
      n.data.registryType === 'output'
        ? { ...n, data: { ...n.data, materialSettings: converted.materialSettings } }
        : n,
    ) as AppNode[],
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
  // A bare script's graph doesn't exist yet — useSyncEngine's code→graph pass
  // builds it a commit or two from now. The canvas arms the fit on this event
  // and fires it on the graph it actually renders next, so announcing early is
  // correct here.
  announceGraphImport();
  return 'script';
}

export function isZipFile(file: File): boolean {
  return (
    /\.zip$/i.test(file.name) ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
  );
}

/**
 * Import a FastShaders `.zip` export: locate the shader script inside
 * (`.js`/`.mjs`/`.tsl`; the one carrying the project block wins, otherwise the
 * first script) and run it through the normal text import. Returns null when
 * the archive is unreadable or holds no script — the caller owns the
 * user-facing message.
 */
/** Zip housekeeping entries that must never win a file-pick (same as podest). */
function isJunkEntry(name: string): boolean {
  return name.includes('__MACOSX') || (name.split('/').pop() ?? '').startsWith('.');
}

export async function importShaderZip(file: File): Promise<'project' | 'script' | 'model' | null> {
  let entries: ZipReadEntry[];
  try {
    entries = await readZip(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return null;
  }

  // A model in the archive becomes the custom preview mesh (the mesh-carrying
  // export writes one under models/). Entry names are attacker-controlled;
  // createPreviewMesh validates and sanitizes at this boundary.
  const modelEntry = entries.find((e) => !isJunkEntry(e.name) && detectMeshKind(e.name) !== null);
  let mesh: PreviewMesh | null = null;
  if (modelEntry) {
    const result = createPreviewMesh(modelEntry.name.split('/').pop() ?? modelEntry.name, modelEntry.data);
    if ('mesh' in result) mesh = result.mesh;
  }

  const showMesh = () => {
    // A zip that ships a model always SHOWS it (podest's shader+model pairing
    // semantics): a script-only zip never touches prefs, and an older project
    // block predating the mesh feature would otherwise leave the model
    // invisible. Write the pref and (re-)fire the prefs re-read.
    try { localStorage.setItem('fs:previewGeometry', 'custom'); } catch { /* quota / private mode */ }
    // typeof guard: this module is also exercised by node-env unit tests.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fs:project-imported'));
    }
  };

  const dec = new TextDecoder();
  const scripts = entries.filter((e) => /\.(js|mjs|tsl)$/i.test(e.name)).map((e) => dec.decode(e.data));
  if (scripts.length === 0) {
    // Model-only zip: still a meaningful drop — load the mesh instead of
    // rejecting the archive outright (the caller treats 'model' as success).
    if (!mesh) return null;
    useAppStore.getState().setPreviewMesh(mesh);
    showMesh();
    return 'model';
  }
  const withProject = scripts.find((t) => t.includes('FASTSHADERS_PROJECT_V1'));

  // Set — or, when the archive has none, CLEAR — the mesh BEFORE the text
  // import: applyProjectToStore dispatches the prefs re-read synchronously,
  // and validateGeometry's 'custom' gate reads the store at that moment.
  useAppStore.getState().setPreviewMesh(mesh);
  const imported = importShaderText(withProject ?? scripts[0], { keepPreviewMesh: true });
  if (mesh) showMesh();
  return imported;
}
