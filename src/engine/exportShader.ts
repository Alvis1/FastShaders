import { useAppStore } from '@/store/useAppStore';
import { drivingSdfOutput } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { findDefaultOutput } from '@/utils/outputMaterials';
import { tslToShaderModule, type PropertyInfo } from './tslToShaderModule';
import { embedProjectState, type FastShadersProject } from './fastShadersProject';
import { inlineImageAssetsFromNodes } from './imageAssets';
import { getNodeValues } from '@/types';
import type { AppNode, AppEdge, MaterialSettings, OutputNodeData } from '@/types';
import { toKebabCase } from '@/utils/nameUtils';
import { collectImageFiles } from '@/utils/imageNode';
import { buildExportBundle, type ExportBundle } from '@/utils/exportBundle';
import { evalLog } from '@/eval/telemetry';

/**
 * Shared "Download Shader" path. Lives outside any component so the toolbar
 * EXPORT button and any future export surface produce byte-identical bundles;
 * everything is read imperatively from the store at click time.
 */

/** Property definitions from property_float / property_color nodes. */
export function collectShaderProperties(nodes: AppNode[]): PropertyInfo[] {
  return nodes
    .filter((n) => n.data.registryType === 'property_float' || n.data.registryType === 'property_color')
    .map((n) => {
      const values = getNodeValues(n);
      if (n.data.registryType === 'property_color') {
        return {
          name: String(values.name ?? 'color1'),
          type: 'color' as const,
          defaultValue: String(values.hex ?? '#ff0000'),
        };
      }
      return {
        name: String(values.name ?? 'property1'),
        type: 'float' as const,
        defaultValue: Number(values.value ?? 1.0),
      };
    });
}

/**
 * Build the FastShaders project snapshot embedded in the downloaded `.js`.
 *
 * Preview-tab settings (geometry, lighting, uniform tunings, camera, …)
 * live in localStorage rather than the zustand store, so we read them
 * directly here — they're treated as user preferences that follow the
 * shader file when re-imported.
 */
export function buildProjectState(): FastShadersProject {
  const ls = (key: string): string | null => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const parseJson = <T,>(raw: string | null): T | undefined => {
    if (!raw) return undefined;
    try { return JSON.parse(raw) as T; } catch { return undefined; }
  };

  const state = useAppStore.getState();
  return {
    version: 1,
    shaderName: state.shaderName,
    selectedHeadsetId: state.selectedHeadsetId,
    graph: { nodes: state.nodes, edges: state.edges },
    ...(state.drawings.length ? { drawings: state.drawings } : {}),
    // Conditional for the same reason drawings is: a shader with no palettes
    // must embed the byte-identical block it embedded before palettes existed,
    // so re-exporting an untouched old shader produces an unchanged file.
    ...(state.shaderPalettes.length ? { palettes: state.shaderPalettes } : {}),
    preview: {
      geometry: ls('fs:previewGeometry') ?? undefined,
      lighting: ls('fs:previewLighting') ?? undefined,
      subdivision: (() => {
        const v = parseInt(ls('fs:previewSubdivision') ?? '', 10);
        return Number.isNaN(v) ? undefined : v;
      })(),
      bgColor: ls('fs:previewBgColor') ?? undefined,
      playing: ls('fs:previewPlaying') === 'true' ? true : undefined,
      uniformValues: parseJson<Record<string, number>>(ls('fs:previewUniformValues')),
      uniformBounds: parseJson<Record<string, unknown>>(ls('fs:previewUniformBounds')),
      cameraPos: parseJson<{ x: number; y: number; z: number }>(ls('fs:previewCameraPos')),
      rotation: parseJson<{ x: number; y: number; z: number }>(ls('fs:previewRotation')),
    },
    ui: {
      nodeEditorBgColor: state.nodeEditorBgColor,
      codeEditorTheme: state.codeEditorTheme,
      costColorLow: state.costColorLow,
      costColorHigh: state.costColorHigh,
    },
  };
}

/**
 * The stem every export file name is built from. Exported so a surface that has
 * to PREDICT the file name without paying for a full bundle build — the desktop
 * Work folder's Save tooltip — cannot drift from what buildShaderBundle
 * actually writes.
 */
export function shaderBaseName(shaderName: string): string {
  return toKebabCase(shaderName || 'shader');
}

/**
 * Build the complete export bundle for the current graph: the shaderloader
 * module with the project snapshot embedded, plus images/model as a zip when
 * present. Shared by every export surface — the toolbar EXPORT download and
 * the desktop Work-folder save — so all of them produce byte-identical
 * bundles. Assembly is pure — see exportBundle.ts.
 */
export function buildShaderBundle(): ExportBundle {
  const state = useAppStore.getState();
  const outputNode = findDefaultOutput(state.nodes);
  const materialSettings = sdfMaterialSettings(
    state.nodes,
    state.edges,
    (outputNode?.data as OutputNodeData | undefined)?.materialSettings,
  );

  let script: string;
  try {
    // The export must be self-contained, so image placeholders are expanded
    // back to their real `data:` payloads before the module is built.
    script = tslToShaderModule(
      inlineImageAssetsFromNodes(state.code, state.nodes),
      materialSettings,
      collectShaderProperties(state.nodes),
    );
  } catch (e) {
    script = `// Export error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const embedded = embedProjectState(script, buildProjectState());
  return buildExportBundle(
    shaderBaseName(state.shaderName),
    embedded,
    collectImageFiles(state.nodes),
    // The EXPORT button's right-click setting can exclude the loaded mesh.
    state.exportIncludeMesh ? state.previewMesh : null,
  );
}

/**
 * Build the bundle and trigger the browser download (the toolbar EXPORT
 * button + the NEW-shader modal's save-first path).
 */
export function downloadShader(): void {
  const bundle = buildShaderBundle();
  // Eval telemetry only — a no-op outside a study session.
  evalLog('export', { kind: bundle.kind });
  const blob = new Blob([bundle.bytes], { type: bundle.mime });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = bundle.fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The material settings the module is built with. When an SDF Output drives,
 * the window must render its BACK faces too — the march starts at the camera
 * for a back-face fragment, which is what lets the viewer zoom inside the box
 * and still see the shape — so `side` is forced to double; everything else is
 * the Output node's own settings, or nothing.
 */
export function sdfMaterialSettings(
  nodes: AppNode[],
  edges: AppEdge[],
  settings: MaterialSettings | undefined,
): MaterialSettings | undefined {
  if (!drivingSdfOutput(nodes, unwrapCollapsedGroupEdges(nodes, edges))) return settings;
  return { ...settings, side: 'double' };
}
