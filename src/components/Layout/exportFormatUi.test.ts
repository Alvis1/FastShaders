/**
 * CONTEXTUAL EXPORT (owner, 2026-09-28), pinned from SOURCE — the vitest env
 * is `node`, so none of these components can be mounted, and every rule below
 * is one a wrong wiring would break silently:
 *
 *  - EXPORT writes what the preview SHOWS (engine/exportModel.ts): a packable
 *    model the `.glb`, a built-in shape the shader file; the popover's ONE
 *    smaller button is the other way for one export, never in a study session
 *    (the popover IS reachable there by right-click), and the engine refuses
 *    the `.glb` path even if it were;
 *  - the popover carries no prose: every row explains itself in its TOOLTIP,
 *    so an inactive input is `aria-disabled` with a guarded onChange, never
 *    `disabled` (WebKit drops the tooltip of a disabled control);
 *  - a study session keeps its "Export model" checkbox (`exportIncludeMesh`);
 *  - only EXPORT honours the unconnected-nodes row; NEW and the Work folder
 *    always save the whole canvas;
 *  - every surface asks `exportFormatFor` with ITS surface, or the Work-folder
 *    tooltip predicts a `.glb` while the write lands a `.zip`;
 *  - there is no stored format: nothing in history, the autosave or a file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(SRC, p), 'utf8');

const TOOLBAR = read('components/Layout/Toolbar.tsx');
const EDITOR = read('components/NodeEditor/NodeEditor.tsx');
const WORK_FOLDER = read('components/Layout/WorkFolder.tsx');
const EXPORT_SHADER = read('engine/exportShader.ts');

describe('the Toolbar popover', () => {
  const POPOVER = TOOLBAR.slice(
    TOOLBAR.indexOf('className="toolbar__local-popover toolbar__export-popover"'),
    TOOLBAR.indexOf('{__FS_DESKTOP__ && <WorkFolder />}'),
  );

  it('EXPORT and the smaller button ask the CONTEXTUAL decision, never a stored choice', () => {
    expect(TOOLBAR).toContain("const exportFormat = useAppStore((s) => exportFormatFor(s, isEvalMode(), 'primary'));");
    expect(TOOLBAR).toContain('const exportAlt = useAppStore((s) => exportAlternate(s, isEvalMode()));');
    // The Format radio and the sticky model rows are gone.
    expect(TOOLBAR).not.toContain('toolbar__export-format');
    expect(TOOLBAR).not.toContain('exportAsGlb');
    expect(TOOLBAR).not.toContain('exportBuiltinModel');
  });

  it('the ONE smaller button: only when there is another way out, and it runs that one export', () => {
    const at = POPOVER.indexOf('className="toolbar__export-alt"');
    expect(at).toBeGreaterThan(-1);
    // Rendered only while exportAlternate offers something — null in a study
    // session, so the study popover never grows a download.
    const gate = POPOVER.lastIndexOf('{exportAlt !== null && (', at);
    expect(gate).toBeGreaterThan(-1);
    const button = POPOVER.slice(at, POPOVER.indexOf('</button>', at));
    expect(button).toContain("runExport('alternate');");
    expect(button).toContain('setExportOpen(false);');
    expect(button).toContain("t('Export with model ({name})', language)");
    expect(button).toContain("t('Export .zip', language)");
    // Its explanation is its tooltip, per way out.
    expect(button).toMatch(/title=\{\s*exportAlt === 'with-model'/);
    // Never `disabled`: WebKit drops a disabled control's tooltip.
    expect(POPOVER).not.toMatch(/\sdisabled=\{/);
  });

  it('the popover holds no prose: every explanation is a row tooltip', () => {
    expect(POPOVER).not.toContain('toolbar__local-note');
    expect(POPOVER).not.toContain('toolbar__export-format-reason');
    expect(read('components/Layout/Toolbar.css')).not.toContain('toolbar__export-format-reason');
  });

  it("EXPORT's tooltip says SHOWN, and why an unpackable model on screen is not the .glb", () => {
    expect(TOOLBAR).toContain('when the graph embeds images or a custom 3D model is shown in the preview');
    expect(TOOLBAR).not.toContain('custom preview mesh is loaded');
    expect(TOOLBAR).toContain("!isEvalMode() && shownForExport?.kind === 'dropped'");
    expect(TOOLBAR).toContain('glbUnavailableText(glbExportAvailability(shownForExport.mesh), language)');
    expect(TOOLBAR).toContain("${exportWhyNotGlb ? `${exportWhyNotGlb} ` : ''}");
  });

  it('every new EXPORT / A-Frame string has its Latvian entry', () => {
    const ui = (JSON.parse(read('i18n/lv.json')) as { ui: Record<string, string> }).ui;
    const keys = [
      'Export with model ({name})',
      'Export .zip',
      'Download a .zip: the shader with {name} as an .obj file under models/, tessellated exactly as the preview shows it. EXPORT itself downloads the shader alone.',
      'Download a .zip instead of the .glb: the shader file with {name} under models/ and its images as files — for pages that load the shader and the model separately.',
      'Download the shader — .js with the FastShaders project embedded (drag it back in to continue); becomes a .zip with the image and 3D-model files alongside when the graph embeds images or a custom 3D model is shown in the preview',
      'A ready-to-run VR page on the model the export .zip carries. Put {file} and models/{model} next to it and serve the folder over http(s) — file:// blocks the shader load.',
    ];
    const editor = read('components/CodeEditor/CodeEditor.tsx');
    for (const k of keys) {
      // The key is really spelled in the source it is claimed for…
      expect(TOOLBAR.includes(k) || editor.includes(k), k).toBe(true);
      // …and translated (not left as the English text).
      expect(ui[k], k).toBeTypeOf('string');
      expect(ui[k], k).not.toBe(k);
    }
    // Every {placeholder} survives the translation.
    for (const k of keys) for (const ph of k.match(/\{\w+\}/g) ?? []) expect(ui[k], `${k} ${ph}`).toContain(ph);
  });

  it('a study session keeps its "Export model" checkbox, and only there', () => {
    const at = POPOVER.indexOf("t('Export model', language)");
    expect(at).toBeGreaterThan(-1);
    const gate = POPOVER.lastIndexOf('{isEvalMode() && (', at);
    expect(gate).toBeGreaterThan(-1);
    const row = POPOVER.slice(gate, at);
    expect(row).toContain('checked={exportIncludeMesh}');
    // Inactive only when there is no model at all, and the guard makes it inert.
    expect(row).toContain('aria-disabled={!previewMesh || undefined}');
    expect(row).toContain('if (previewMesh) setExportIncludeMesh(e.target.checked);');
  });

  it('the unconnected-nodes row: outside a study, and only EXPORT reads it', () => {
    const at = POPOVER.indexOf("t('Include unconnected nodes', language)");
    expect(at).toBeGreaterThan(-1);
    const gate = POPOVER.lastIndexOf('{!isEvalMode() && (', at);
    expect(POPOVER.slice(gate, at)).toContain('checked={exportAllNodes}');
    expect(TOOLBAR).toContain("scope: exportAllNodes ? 'whole' : 'connected'");
    // …and it is the ONE surface that ships the SHOWN model.
    expect(TOOLBAR).toContain("model: 'shown',");
    expect(EDITOR).not.toContain("model: 'shown'");
    expect(WORK_FOLDER).not.toContain("model: 'shown'");
  });

  it('EXPORT keeps the study branch above the wrapper and guards a second press', () => {
    // The click answers the study session BEFORE it runs the export.
    const click = TOOLBAR.slice(TOOLBAR.indexOf('className="toolbar__export"'));
    const evalBranch = click.indexOf('if (isEvalMode()) {');
    const run = click.indexOf('runExport();');
    expect(evalBranch).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(evalBranch);
    expect(click.slice(evalBranch, run)).toContain('setEvalFinishOpen(true)');
    // Both buttons share ONE runner, which holds the second-press guard.
    const runner = TOOLBAR.slice(TOOLBAR.indexOf('const runExport = '), TOOLBAR.indexOf('buildShaderExportChecked('));
    expect(runner).toContain('if (exportBusyRef.current) return;');
    expect(TOOLBAR).toContain("delivery: 'download'");
    expect(TOOLBAR).toContain('...(variant ? { variant } : {}),');
    expect(TOOLBAR).not.toContain('buildShaderBundleChecked(');
  });
});

describe('every user surface goes through the one wrapper', () => {
  it('NEW and the Work-folder Save call it, with their own delivery', () => {
    expect(EDITOR).toContain('buildShaderExportChecked(');
    expect(EDITOR).not.toContain('buildShaderBundleChecked(');
    expect(EDITOR).toContain("delivery: 'download'");
    expect(WORK_FOLDER).toContain('buildShaderExportChecked(');
    expect(WORK_FOLDER).not.toContain('buildShaderBundleChecked(');
    expect(WORK_FOLDER).toContain("delivery: 'write'");
  });

  it('NEW and the Work-folder Save are saves of the document: always the whole canvas', () => {
    for (const [name, src] of [
      ['NodeEditor', EDITOR],
      ['WorkFolder', WORK_FOLDER],
    ] as const) {
      expect(src, name).toContain("scope: 'whole'");
      expect(src, name).not.toContain('exportAllNodes');
    }
  });

  it('each mounts ONE modal element, which covers both dialogs', () => {
    const hook = read('components/Modals/ExportPreflightModal.tsx');
    expect(hook).toContain('const { ui: glb, modal: glbModal } = useGlbExportUi();');
    for (const [name, src] of [
      ['Toolbar', TOOLBAR],
      ['NodeEditor', EDITOR],
      ['WorkFolder', WORK_FOLDER],
    ] as const) {
      expect(src, name).toContain('glb: glbExportUi');
      expect(src, name).toContain('{exportPreflightModal}');
    }
  });

  it('the study package still builds the bare bundle', () => {
    const sus = read('eval/SusModal.tsx');
    expect(sus).toContain('buildShaderBundle()');
    expect(sus).not.toContain('buildShaderExportChecked');
    expect(sus).not.toContain('prepareSingleGlb');
  });

  it('neither export dialog logs telemetry (evalHooks ALLOWED_FILES must not move)', () => {
    // The call text is ASSEMBLED: evalHooks.test.ts scans every file under
    // src/ for it and would count this one as a logging site.
    const CALL = ['evalLog', '('].join('');
    expect(read('components/Modals/GlbExportModal.tsx')).not.toContain(CALL);
    expect(read('components/Modals/ExportPreflightModal.tsx')).not.toContain(CALL);
  });
});

describe('the engine gate and the contextual decision', () => {
  it('isEvalMode is answered BEFORE the first single-GLB call', () => {
    const fn = EXPORT_SHADER.slice(EXPORT_SHADER.indexOf('export async function buildShaderExportChecked'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const gate = body.indexOf('isEvalMode()');
    const prepare = body.indexOf('prepareSingleGlb');
    expect(gate).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(gate);
    expect(body).toContain("const surface = asks.model !== 'shown' ? 'document' : asks.variant === 'alternate' ? 'alternate' : 'primary';");
    expect(body).toContain("exportFormatFor(s, false, surface) !== 'glb'");
    expect(body).toContain('buildShaderBundleChecked(asks.preflight, graph, model)');
    // The telemetry chokepoint stays on the download tail. The pattern is
    // ASSEMBLED, because evalHooks.test.ts scans every file under src/ for the
    // call text and would count this one as a logging site.
    expect(EXPORT_SHADER).toMatch(new RegExp(['evalLog', "\\('export'"].join('')));
  });

  it('every surface asks exportFormatFor with ITS surface', () => {
    expect(WORK_FOLDER).toContain("exportFormatFor(s, isEvalMode(), 'document')");
    const editor = read('components/CodeEditor/CodeEditor.tsx');
    expect(editor).toContain("useAppStore((s) => exportFormatFor(s, isEvalMode(), 'primary'))");
    for (const [name, src] of [
      ['Toolbar', TOOLBAR],
      ['WorkFolder', WORK_FOLDER],
      ['CodeEditor', editor],
      ['exportShader', EXPORT_SHADER],
    ] as const) {
      // The leaf takes the model to pack; only exportModel.ts decides which.
      expect(src, name).not.toContain('effectiveExportFormat(');
    }
  });

  it('there is no stored format: no flag in the store, history, autosave or project block', () => {
    const store = read('store/useAppStore.ts');
    for (const gone of ['exportAsGlb', 'exportBuiltinModel', 'setExportAsGlb', 'setExportBuiltinModel']) {
      expect(store, gone).not.toMatch(new RegExp(`\\b${gone}\\b`));
    }
    const project = EXPORT_SHADER.slice(EXPORT_SHADER.indexOf('export function buildProjectState'));
    expect(project.slice(0, project.indexOf('\n}\n'))).not.toContain('exportAsGlb');
  });

  it('so is exportAllNodes, and a study session never prunes', () => {
    const store = read('store/useAppStore.ts');
    const snapshot = store.slice(store.indexOf('function snapshotOf'), store.indexOf('function snapshotOf') + 2000);
    expect(snapshot).not.toContain('exportAllNodes');
    expect(store).not.toContain("'fs:exportAllNodes'");
    expect(store).toContain('exportAllNodes: false,');
    const project = EXPORT_SHADER.slice(EXPORT_SHADER.indexOf('export function buildProjectState'));
    expect(project.slice(0, project.indexOf('\n}\n'))).not.toContain('exportAllNodes');
    expect(EXPORT_SHADER).toContain("exportGraphFor(isEvalMode() ? 'whole' : (asks.scope ?? 'whole'))");
  });
});

describe('the Work folder opens a .glb', () => {
  it('its branch runs before the zip test and calls the GLB importer', () => {
    const glb = WORK_FOLDER.indexOf('/\\.glb$/i.test(entry.fileName)');
    const zip = WORK_FOLDER.indexOf('/\\.zip$/i.test(entry.fileName)');
    expect(glb).toBeGreaterThan(-1);
    expect(zip).toBeGreaterThan(glb);
    expect(WORK_FOLDER).toContain('await importShaderGlb(entry.fileName, bytes)');
    // Each refusal gets its own sentence: no shader, a refused model, damaged.
    expect(WORK_FOLDER).toContain('GLB_EXPORT_KEYS.workFolderNoShader');
    expect(WORK_FOLDER).toContain('meshRefusalMessage(r.refusal, language)');
    expect(WORK_FOLDER).toContain("fsRefusalNotice(shown, 'damaged', language)");
  });

  it('opening one brings its model back, and Save — a DOCUMENT save — packs it into a .glb again', () => {
    // Otherwise `bundleKind` is 'js'/'zip', `workFolderSaveName` re-extends the
    // tracked name, and the next Save forks a sibling while `waves.glb` keeps
    // the pre-edit shader — silently, since the folder holds no such sibling to
    // confirm over. The 'document' surface packs the LOADED model whatever the
    // preview shows (exportModel.test.ts pins that), so no flag is adopted.
    const branch = WORK_FOLDER.slice(
      WORK_FOLDER.indexOf('await importShaderGlb(entry.fileName, bytes)'),
      WORK_FOLDER.indexOf("} else if (/\\.zip$/i.test(entry.fileName))"),
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).not.toContain('setExportAsGlb');
    expect(WORK_FOLDER).toContain("const documentFormat = useAppStore((s) => exportFormatFor(s, isEvalMode(), 'document'));");
  });

  it('…but a tracked .js/.zip is written back as the bundle, never forked into a .glb', () => {
    // The Save asks the family BEFORE it builds, and the tooltip predicts the same.
    expect(WORK_FOLDER).toContain("documentFormat === 'glb' && !keepsBundleFormat(trackedFile) && !untrackedBundle");
    // Nothing tracked (a relaunch): the folder is asked, and a failed listing
    // falls back to the document rule instead of blocking the save.
    const save = WORK_FOLDER.slice(WORK_FOLDER.indexOf('const save = useCallback('));
    expect(save).toContain("if (!bundleOnly && origin === null && exportFormatFor(useAppStore.getState(), isEvalMode(), 'document') === 'glb') {");
    expect(save).toContain("invokeDesktop<WorkFolderEntry[]>('work_folder_list').catch(() => [] as WorkFolderEntry[])");
    expect(save).toContain('bundleOnly = untrackedKeepsBundle(');
    expect(save.indexOf('bundleOnly = untrackedKeepsBundle(')).toBeLessThan(save.indexOf('buildShaderExportChecked('));
    expect(WORK_FOLDER).toContain('...(bundleOnly ? { bundleOnly: true as const } : {}),');
    expect(EXPORT_SHADER).toContain("asks.bundleOnly === true ||");
  });

  it('a study session neither lists nor opens one', () => {
    expect(WORK_FOLDER).toContain('isEvalMode() ? list.filter((e) => !/\\.glb$/i.test(e.fileName)) : list');
    expect(WORK_FOLDER).toContain('if (isEvalMode() && /\\.glb$/i.test(entry.fileName)) return;');
  });
});

describe('the code panel follows the EXPORT button', () => {
  it("the A-Frame tab hangs the shader on the model, and each tab's label names its own file", () => {
    const src = read('components/CodeEditor/CodeEditor.tsx');
    // A .glb export: the page stands on the .glb; otherwise on the model the
    // .zip ships under models/, when it ships one (tslToAFrameHTML `bundledModel`).
    expect(src).toContain("...(exportFormat === 'glb' ? { modelFile: glbFileName } : { bundledModel })");
    // The bundle's model is named from the SAME decision the button builds from…
    expect(src).toContain("const choice = exportModelChoice(s, false, 'primary');");
    // …and a study session keeps the primitive page it always had.
    const key = src.slice(src.indexOf('const bundledModelKey = useAppStore((s) => {'));
    expect(key.slice(0, key.indexOf('});'))).toContain("if (isEvalMode()) return '';");
  });

  it('both embed tabs follow the SHOWN geometry live, with the snapshot only as the fallback', () => {
    const src = read('components/CodeEditor/CodeEditor.tsx');
    expect(src).toContain('const shownGeometry = useAppStore((s) => (isEvalMode() ? null : (s.previewShape?.geometry ?? null)));');
    expect(src).toContain('const pageGeometry = shownGeometry ?? fallbackGeometry;');
    expect(src).toContain('[marchWindow, embedStamp],');
    expect(src.split('geometry: pageGeometry,').length - 1).toBe(2);
    expect(src).toContain('GLB_EXPORT_KEYS.tabAFrameGlb');
    expect(src).toContain('GLB_EXPORT_KEYS.tabThreeGlb');
    // The Three.js page stays on the .js export.
    expect(src).not.toContain('buildThreeEmbedHTML(scriptCode, {\n        shaderFile: glbFileName');
  });
});
