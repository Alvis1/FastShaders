import { useAppStore } from '@/store/useAppStore';
import { valueNum, valueStr } from '@/utils/valueCoerce';
import { drivingMarchOutput } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { contributingOutputs, materialPartsMirrorPlanAcross, moduleSettingsOutput } from '@/utils/outputMaterials';
import { tslToShaderModule, type PropertyInfo, type ShaderModuleOptions } from './tslToShaderModule';
import { embedProjectState, type FastShadersProject } from './fastShadersProject';
import { inlineImageAssetsFromNodes, imageAssetFor } from './imageAssets';
import { EXPORT_IMAGE_REFS, referenceImagesInModule } from './projectImageRefs';
import { getNodeValues } from '@/types';
import type { AppNode, AppEdge, MaterialSettings, OutputNodeData } from '@/types';
import { toKebabCase } from '@/utils/nameUtils';
import { collectImageFiles } from '@/utils/imageNode';
import { buildExportBundle, type ExportBundle } from '@/utils/exportBundle';
import { evalLog } from '@/eval/telemetry';
import { isEvalMode } from '@/eval/evalMode';
import {
  planExportPreflight,
  planDesktopOnlyExport,
  planSingleGlbPreflight,
  type ExportTooLarge,
  type ExportPreflightChoice,
  type SingleGlbTooLarge,
} from '@/utils/exportPreflight';
import { effectiveExportFormat } from '@/utils/glbExportAvailability';
import {
  glbExportRefusalText,
  glbExportReportNoteLines,
  type GlbExportNoteLine,
} from '@/utils/glbExportCopy';
import { FS_SINGLE_GLB_MIME } from './glbShaderContract';
import { getKtx2Encoder } from '@/utils/ktx2Encoder';
import type { SingleGlbBuildMode } from './exportSingleGlb';
import type { ImportNoteLine } from '@/utils/importNote';
import { safeJsonReviver } from '@/utils/safeJson';

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
          name: valueStr(values.name ?? 'color1'),
          type: 'color' as const,
          defaultValue: valueStr(values.hex ?? '#ff0000'),
        };
      }
      return {
        name: valueStr(values.name ?? 'property1'),
        type: 'float' as const,
        defaultValue: valueNum(values.value ?? 1.0),
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
    // These keys are localStorage, i.e. writable by anything at this origin,
    // AND `projectImport` writes them straight out of an imported file — so
    // this is a trust boundary and takes the shared deny-list reviver
    // (utils/safeJson.ts, the one copy of that rule). It matters more here than
    // at a read-only site: whatever comes back is embedded VERBATIM into the
    // downloaded `.js` and thus travels to whoever the file is shared with.
    try { return JSON.parse(raw, safeJsonReviver) as T; } catch { return undefined; }
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

/** What a module that could not be built starts with (its whole text is this line). */
export const EXPORT_ERROR_PREFIX = '// Export error:';

export interface BuildExportModuleOptions {
  /**
   * true: every image placeholder is expanded back to its `data:` payload —
   * the self-contained `.js` export. false: the `"fs-asset:<key>"` literals
   * survive — the single-GLB export, where loader 0.8 resolves each key from
   * the GLB's own image bytes (glbShaderContract.ts).
   */
  inlineImages: boolean;
  /** The single-GLB file name; adds the GLB usage header (tslToShaderModule opts). */
  glbFile?: string;
}

/**
 * The shaderloader MODULE of the current graph, read imperatively from the
 * store: the ONE builder behind the `.js` download (`inlineImages: true`,
 * exactly what buildShaderBundle embeds) and the single-GLB export
 * (`inlineImages: false` + `glbFile`). Both go through the same Raymarch-aware
 * material settings, property list and loader-0.6 mirror plan — the `.js`
 * and the `.glb` module must come from one builder, or the two exports
 * drift. A module that cannot be built is the EXPORT_ERROR_PREFIX line, so a
 * composer can refuse it by prefix.
 */
export function buildExportModule(opts: BuildExportModuleOptions): string {
  const state = useAppStore.getState();
  // TWO different questions off one node list. The module's top-level
  // material settings belong to `moduleSettingsOutput` (D1: the untargeted
  // Output, else the first of any kind — a targeted Output must not lend its
  // settings to the whole module while an untargeted one exists); the MIRROR
  // plan below belongs to the Output SET that contributes to the module, which
  // `contributingOutputs` answers in one place for every emission-side surface.
  const materialSettings = marchMaterialSettings(
    state.nodes,
    state.edges,
    (moduleSettingsOutput(state.nodes)?.data as OutputNodeData | undefined)?.materialSettings,
  );
  const moduleOpts: ShaderModuleOptions = opts.glbFile !== undefined ? { glbFile: opts.glbFile } : {};
  try {
    // The .js export must be self-contained, so image placeholders are
    // expanded back to their real `data:` payloads before the module is built;
    // the .glb keeps them for the loader to resolve from the file's images.
    return tslToShaderModule(
      opts.inlineImages ? inlineImageAssetsFromNodes(state.code, state.nodes) : state.code,
      materialSettings,
      collectShaderProperties(state.nodes),
      // The loader-0.6 mirrors of an import-built Output's index sections —
      // module-only (materialPartsContract R7), and the SAME plan the preview
      // passes, so the download is what the author previewed.
      materialPartsMirrorPlanAcross(contributingOutputs(state.nodes)),
      moduleOpts,
    );
  } catch (e) {
    return `${EXPORT_ERROR_PREFIX} ${e instanceof Error ? e.message : String(e)}`;
  }
}

export interface BuildShaderBundleOptions {
  /**
   * Override the session flag `exportIncludeMesh` for THIS build only (the N1
   * "Export without the 3D model" answer). Absent = the flag, exactly today's
   * behaviour. Never written back to the store.
   */
  includeMesh?: boolean;
}

/**
 * Build the complete export bundle for the current graph: the shaderloader
 * module with the project snapshot embedded, plus images/model as a zip when
 * present. Shared by every export surface — the toolbar EXPORT download, the
 * NEW-shader save-first path, the desktop Work-folder save and the study
 * package — so all of them produce byte-identical bundles. Assembly is pure —
 * see exportBundle.ts. The three USER surfaces reach it through
 * buildShaderBundleChecked (the export pre-flight).
 */
export function buildShaderBundle(opts: BuildShaderBundleOptions = {}): ExportBundle {
  const state = useAppStore.getState();
  // The self-contained module (buildExportModule is the one module builder).
  const script = buildExportModule({ inlineImages: true });

  const project = buildProjectState();
  const embedded = embedProjectState(
    script,
    // OWNER GATE (engine/projectImageRefs.ts): 0.3.33 and older read pixels
    // only from `imageB64`, so while this is false every block keeps them all.
    EXPORT_IMAGE_REFS
      ? referenceImagesInModule(project, script, (n) => imageAssetFor(n.id, getNodeValues(n))?.src ?? null)
      : project,
  );
  return buildExportBundle(
    shaderBaseName(state.shaderName),
    embedded,
    collectImageFiles(state.nodes),
    // The EXPORT button's right-click setting can exclude the loaded mesh —
    // and the export pre-flight can drop it for one build; see
    // buildShaderBundleChecked.
    (opts.includeMesh ?? state.exportIncludeMesh) ? state.previewMesh : null,
  );
}

/**
 * Shows the N1 dialog and resolves with the user's answer
 * (components/Modals/ExportPreflightModal's useExportPreflight).
 */
export type AskExportPreflight = (tooLarge: ExportTooLarge) => Promise<ExportPreflightChoice>;

/**
 * The export pre-flight: builds the bundle and, when it would unpack past (or
 * hold more entries than) what FastShaders can open again, asks first. Resolves to the bundle to deliver, or
 * null when the user cancelled.
 *
 * The ONE path for the three USER export surfaces (EXPORT, NEW's save-first,
 * the Work-folder Save). The study package (SusModal) calls buildShaderBundle()
 * directly and never pauses on a dialog. Skipped in a study session: NEW's
 * save-first is the only eval-reachable download, and research doc §8 keeps
 * new notices out of the study condition.
 *
 * No timer or awaited I/O may sit between the answer and the return: the
 * caller's download must stay in the click's task, or Safari may drop the
 * anchor download for lack of transient activation. The no-dialog branch
 * resolves through microtasks, and the dialog's answer resolves inside the
 * button's own click task with a synchronous rebuild.
 */
export async function buildShaderBundleChecked(
  ask: AskExportPreflight,
): Promise<ExportBundle | null> {
  const bundle = buildShaderBundle();
  if (isEvalMode()) return bundle;
  const tooLarge = planExportPreflight(bundle);
  if (!tooLarge) return bundle;
  const choice = await ask(tooLarge);
  if (choice === 'cancel') return null;
  if (choice === 'without-model' && tooLarge.withoutModel) {
    return buildShaderBundle({ includeMesh: false });
  }
  return bundle;
}

/**
 * ONE `.glb` — the loaded model, its textures and this shader inside
 * (engine/exportSingleGlb.ts writes it). `report` is what the delivery
 * announces, as import-note LINES so it re-renders in the active language.
 */
export interface ShaderGlbExport {
  kind: 'glb';
  fileName: string;
  mime: typeof FS_SINGLE_GLB_MIME;
  bytes: Uint8Array<ArrayBuffer>;
  report: GlbExportNoteLine[];
}

/** What a USER export surface delivers: the bundle, or one `.glb`. */
export type ShaderExport = ExportBundle | ShaderGlbExport;

/** The bytes a READER would have to open again (what the notices count). */
export function exportSizeBytes(e: ShaderExport): number {
  return e.kind === 'glb' ? e.bytes.length : e.unpackedBytes;
}

/** The single-GLB dialog's answers (components/Modals/GlbExportModal.tsx). */
export type GlbTooLargeChoice = 'full' | 'webp-only' | 'no-ktx2' | 'as-bundle' | 'cancel';

/** N1-GLB's finding plus the `.zip` alternative, when THAT bundle reopens. */
export interface GlbTooLargeRequest extends SingleGlbTooLarge {
  asBundle: { sizeBytes: number } | null;
}

/**
 * The UI the `.glb` path needs (GlbExportModal's `useGlbExportUi`). Every
 * method is safe to call while nothing is shown, and every promise resolves —
 * the modal answers `cancel`/`false` on unmount.
 */
export interface GlbExportUi {
  /** Shows "Building …" after 300 ms; `cancel` aborts the build. */
  begin(fileName: string, cancel: () => void): void;
  /** How the KTX2 encodes are going, while that view is up (Phase 8). */
  progress(done: number, total: number): void;
  failed(message: string, canBundle: boolean): Promise<'as-bundle' | 'cancel'>;
  tooLarge(request: GlbTooLargeRequest): Promise<GlbTooLargeChoice>;
  /** A FRESH click when the build outlived the first one's activation. */
  ready(fileName: string, sizeBytes: number): Promise<boolean>;
  end(): void;
}

export interface ShaderExportAsks {
  preflight: AskExportPreflight;
  glb: GlbExportUi;
  /** `download` may need the ready step; the Work folder's IPC write never does. */
  delivery: 'download' | 'write';
}

/**
 * Is the click that started this export still good for an anchor download?
 * A missing API counts as NOT active — the safe direction, since the cost of
 * being wrong is one extra click rather than a download Safari drops.
 */
function hasTransientActivation(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true;
  } catch {
    return false;
  }
}

/** The `.js`/`.zip` alternative, but only when THAT bundle reopens (N1). */
function bundleIfReopens(): ExportBundle | null {
  const b = buildShaderBundle();
  return planExportPreflight(b) === null ? b : null;
}

/**
 * THE path for the three USER export surfaces (EXPORT, NEW's save-first, the
 * desktop Work-folder Save) now that an export may be ONE `.glb`. For the
 * bundle format it delegates to `buildShaderBundleChecked` unchanged.
 *
 * A study session never reaches the GLB path: the check sits ABOVE the first
 * `prepareSingleGlb` call (the Format row is not rendered there either, but
 * the popover itself IS reachable by right-click), and the study package still
 * calls bare `buildShaderBundle()`.
 *
 * TIMING. Building a `.glb` awaits the PNG/JPEG fallback encodes, so this path
 * cannot keep `buildShaderBundleChecked`'s microtask-only rule. `prepared.build`
 * is SYNCHRONOUS and runs after the last answer, and when the click's transient
 * activation has lapsed the modal's "ready" step supplies a fresh one — the
 * Safari anchor-download rule. The Work folder writes over IPC and never asks.
 */
export async function buildShaderExportChecked(asks: ShaderExportAsks): Promise<ShaderExport | null> {
  const s = useAppStore.getState();
  if (isEvalMode() || effectiveExportFormat(s.exportAsGlb, s.previewMesh, false) !== 'glb') {
    return buildShaderBundleChecked(asks.preflight);
  }
  const lang = s.language;
  const ctrl = new AbortController();
  asks.glb.begin(`${shaderBaseName(s.shaderName)}.glb`, () => ctrl.abort());
  try {
    // Loaded here, not at module scope: the repacker, its plan and the canvas
    // fallback encoder are a large graph that only a .glb export needs, and
    // exportShader sits on the boot path (the toolbar imports it).
    const { prepareSingleGlb } = await import('./exportSingleGlb');
    // The KTX2 copies are opt-in per export (the popover's row) AND need an
    // encoder registered; with either missing this is exactly today's file.
    const encoder = getKtx2Encoder();
    const r = await prepareSingleGlb({
      signal: ctrl.signal,
      ktx2: s.exportKtx2 && encoder ? { encoder, onProgress: (d, t) => asks.glb.progress(d, t) } : null,
    });
    if (!r.ok) {
      if (r.reason === 'aborted') return null;
      const text = glbExportRefusalText(r.reason, lang, { name: r.name, detail: r.detail });
      if (text === null) return null; // `study` — unreachable above, never shown
      const alt = bundleIfReopens();
      const c = await asks.glb.failed(text, alt !== null);
      return c === 'as-bundle' && alt ? alt : null;
    }
    const prepared = r.prepared;
    let mode: SingleGlbBuildMode = 'fallback';
    const tl = planSingleGlbPreflight(prepared.sizes);
    if (tl) {
      const alt = bundleIfReopens();
      const c = await asks.glb.tooLarge({ ...tl, asBundle: alt ? { sizeBytes: alt.unpackedBytes } : null });
      if (c === 'cancel') return null;
      if (c === 'as-bundle') return alt;
      if (c === 'webp-only') mode = 'required';
      if (c === 'no-ktx2') mode = 'no-ktx2';
    }
    if (asks.delivery === 'download' && !hasTransientActivation()) {
      const shown = mode === 'no-ktx2' ? prepared.sizes.noKtx2 : prepared.sizes[mode];
      if (!(await asks.glb.ready(prepared.fileName, shown.totalBytes))) return null;
    }
    // SYNC from here: nothing may await between the answer (or the fresh
    // click) and the caller's download.
    try {
      const built = prepared.build(mode);
      return {
        kind: 'glb',
        fileName: prepared.fileName,
        mime: FS_SINGLE_GLB_MIME,
        bytes: built.bytes,
        report: glbExportReportNoteLines(
          built.report.size,
          prepared.problems,
          prepared.notes,
          mode === 'no-ktx2' ? undefined : { written: prepared.ktx2Written, skipped: prepared.ktx2Skipped },
        ),
      };
    } catch (e) {
      // A measured repack that refused: the invariant failure exportSingleGlb
      // documents. Offer the bundle rather than ending on a dead press.
      const alt = bundleIfReopens();
      const c = await asks.glb.failed(e instanceof Error ? e.message : String(e), alt !== null);
      return c === 'as-bundle' && alt ? alt : null;
    }
  } finally {
    asks.glb.end();
  }
}

/**
 * Trigger the browser download of an already-checked export (the toolbar
 * EXPORT button and the NEW-shader save-first path pass
 * buildShaderExportChecked's result). A cancelled pre-flight never gets here,
 * so it logs nothing. What the delivery announces (a `.glb`'s report lines,
 * N1's desktop-only line) is posted HERE, after the anchor click, so both
 * download surfaces announce it only once the file has been handed over.
 */
export function downloadShader(bundle: ShaderExport = buildShaderBundle()): void {
  // Eval telemetry only — a no-op outside a study session.
  evalLog('export', { kind: bundle.kind });
  const blob = new Blob([bundle.bytes], { type: bundle.mime });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = bundle.fileName;
  a.click();
  URL.revokeObjectURL(url);
  announceExportDelivered(bundle);
}

/**
 * Post what a DELIVERED export has to say, in ONE note: a single-GLB export's
 * report (textures written WebP-only, slots other viewers show untextured, an
 * approximated placement) and N1's desktop-only line ("Saved (… MB). Only the
 * desktop editor can open it again …"). Called from downloadShader's tail and
 * from the desktop Work folder once its write resolved — never before
 * delivery, so the note cannot claim a save that did not happen. One note
 * because `showImportNote` REPLACES: two calls would hide the first.
 *
 * The desktop line reads the byte count the READER counts (`unpackedBytes` for
 * a bundle, the file itself for a `.glb`). A no-op on the web build
 * (planDesktopOnlyExport is always null there) and in a study session
 * (research doc §8 keeps new notices out of the condition).
 */
export function announceExportDelivered(e: ShaderExport): void {
  if (isEvalMode()) return;
  const lines: ImportNoteLine[] = e.kind === 'glb' ? [...e.report] : [];
  const note = planDesktopOnlyExport(exportSizeBytes(e));
  if (note) lines.push({ kind: 'export-desktop-only', ...note });
  if (lines.length > 0) useAppStore.getState().showImportNote(lines);
}

/**
 * The material settings the module is built with. When a Raymarch Output
 * drives, the window SPHERE must render its BACK faces too — the march starts
 * at the camera for a back-face fragment, which is what lets the viewer zoom
 * inside the window and still see the shape — so `side` is forced to double;
 * everything else is the Output node's own settings, or nothing.
 */
export function marchMaterialSettings(
  nodes: AppNode[],
  edges: AppEdge[],
  settings: MaterialSettings | undefined,
): MaterialSettings | undefined {
  if (!drivingMarchOutput(nodes, unwrapCollapsedGroupEdges(nodes, edges))) return settings;
  return { ...settings, side: 'double' };
}
