/**
 * Shared shader/project import — one code path for every import surface: the
 * Load Script picker, the code panel's drop zone, and the canvas drop.
 *
 * Accepts a shader script — `.js`/`.mjs`/`.tsl`, with or without an embedded
 * FASTSHADERS_PROJECT_V1 block; raw editor-style TSL passes through
 * scriptToTSL unchanged — or a FastShaders `.zip` export (the shader `.js` +
 * its images; the images ride inside the .js as data: URLs, so importing the
 * .js restores everything — the loose files exist for reuse/editing).
 */

import { useAppStore } from '@/store/useAppStore';
import { sanitizeImageNodes } from '@/utils/imageNode';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { generateId } from '@/utils/idGenerator';
import { readZip, type ZipReadEntry } from '@/utils/zipReader';
import { extractProjectState, type FastShadersProject } from './fastShadersProject';
import { scriptToTSL } from './scriptToTSL';

/**
 * Apply a FastShaders project snapshot to the store. Graph state is restored
 * reactively; preview/iframe settings are written to localStorage and a
 * `fs:project-imported` event lets ShaderPreview re-read its in-memory state
 * from those keys.
 */
export function applyProjectToStore(project: FastShadersProject): void {
  const store = useAppStore.getState();
  store.pushHistory();

  if (project.shaderName) store.setShaderName(project.shaderName);
  if (project.selectedHeadsetId) store.setSelectedHeadsetId(project.selectedHeadsetId);
  if (project.ui?.nodeEditorBgColor) store.setNodeEditorBgColor(project.ui.nodeEditorBgColor);
  if (project.ui?.codeEditorTheme === 'vs' || project.ui?.codeEditorTheme === 'vs-dark') {
    store.setCodeEditorTheme(project.ui.codeEditorTheme);
  }
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
  if (p.uniformValues) writeLs('fs:previewUniformValues', JSON.stringify(p.uniformValues));
  if (p.uniformBounds) writeLs('fs:previewUniformBounds', JSON.stringify(p.uniformBounds));
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

  // Restore graph last — switching syncSource to 'graph' will trigger
  // graphToCode in useSyncEngine, regenerating the editor code to match.
  useAppStore.setState({
    nodes: sanitized.nodes,
    edges: project.graph.edges,
    syncSource: 'graph',
    isUndoRedo: false,
  });

  window.dispatchEvent(new CustomEvent('fs:project-imported'));
}

/**
 * Import shader source text: a FASTSHADERS_PROJECT_V1 block restores the full
 * project; a bare shaderloader script is parsed back to TSL and re-synced.
 */
export function importShaderText(text: string): 'project' | 'script' {
  const projectResult = extractProjectState(text);
  if (projectResult) {
    applyProjectToStore(projectResult.project);
    return 'project';
  }
  const store = useAppStore.getState();
  store.setCode(scriptToTSL(text), 'code');
  store.requestCodeSync();
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
export async function importShaderZip(file: File): Promise<'project' | 'script' | null> {
  let entries: ZipReadEntry[];
  try {
    entries = await readZip(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return null;
  }
  const dec = new TextDecoder();
  const scripts = entries.filter((e) => /\.(js|mjs|tsl)$/i.test(e.name)).map((e) => dec.decode(e.data));
  if (scripts.length === 0) return null;
  const withProject = scripts.find((t) => t.includes('FASTSHADERS_PROJECT_V1'));
  return importShaderText(withProject ?? scripts[0]);
}
