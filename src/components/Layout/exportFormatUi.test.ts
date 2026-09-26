/**
 * The EXPORT popover's Format choice, pinned from SOURCE — the vitest env is
 * `node`, so none of these components can be mounted, and every rule below is
 * one a wrong wiring would break silently:
 *
 *  - the study never sees the row (the popover IS reachable there by
 *    right-click), and the engine refuses the path even if it did;
 *  - the popover carries no prose: every row explains itself — and an
 *    inactive row says why — in its TOOLTIP, so an inactive input is
 *    `aria-disabled` with a guarded onChange, never `disabled` (WebKit drops
 *    the tooltip of a disabled control);
 *  - the "Export model" row names the SHOWN model (a built-in shape too) and
 *    is never locked while there is one;
 *  - only EXPORT honours the unconnected-nodes row; NEW and the Work folder
 *    always save the whole canvas;
 *  - every surface asks `effectiveExportFormat` rather than the raw flag, or
 *    the Work-folder tooltip predicts a `.glb` while the write lands a `.zip`;
 *  - the flag is session-only: never in history, the autosave or a file.
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
  it('renders the Format group only outside a study session', () => {
    const at = TOOLBAR.indexOf('className="toolbar__export-format"');
    expect(at).toBeGreaterThan(-1);
    const gate = TOOLBAR.lastIndexOf('{!isEvalMode() && (', at);
    expect(gate).toBeGreaterThan(-1);
    // Nothing else opens between the gate and the group.
    expect(TOOLBAR.slice(gate, at)).not.toContain('{exportOpen');
  });

  const POPOVER = TOOLBAR.slice(
    TOOLBAR.indexOf('className="toolbar__local-popover toolbar__export-popover"'),
    TOOLBAR.indexOf('{__FS_DESKTOP__ && <WorkFolder />}'),
  );

  it('an unavailable .glb radio is aria-disabled and says why in its row tooltip', () => {
    expect(POPOVER).toContain('aria-disabled={!glbAvail.ok || undefined}');
    // The guard is what makes aria-disabled inert: a click still reaches onChange.
    expect(POPOVER).toContain('if (glbAvail.ok) setExportAsGlb(true);');
    expect(POPOVER).toMatch(/: \(glbUnavailableText\(glbAvail, language\) \?\? undefined\)/);
    expect(POPOVER).toContain('GLB_EXPORT_KEYS.popoverNoteGlb');
    // Never `disabled`: WebKit drops a disabled control's tooltip, which is the reason.
    expect(POPOVER).not.toMatch(/\sdisabled=\{/);
  });

  it('the popover holds no prose: every explanation is a row tooltip', () => {
    expect(POPOVER).not.toContain('toolbar__local-note');
    expect(POPOVER).not.toContain('toolbar__export-format-reason');
    expect(read('components/Layout/Toolbar.css')).not.toContain('toolbar__export-format-reason');
  });

  it('the "Export model" row names the shown model and is never locked while there is one', () => {
    const row = POPOVER.slice(POPOVER.indexOf("t('Export model', language)") - 3500);
    expect(row).toContain('activePreviewModel(previewShape, previewMesh)');
    // Inactive only when there is no model at all.
    expect(POPOVER).toContain('aria-disabled={name === null || undefined}');
    // A built-in shape rides its own flag; the dropped model keeps exportIncludeMesh.
    expect(POPOVER).toContain('checked={glb || (builtin ? exportBuiltinModel : exportIncludeMesh)}');
    expect(POPOVER).toContain('if (builtin) setExportBuiltinModel(e.target.checked);');
    // A study session names only a dropped model — it never exports a shape.
    expect(row).toContain("? (previewMesh ? { kind: 'dropped' as const, mesh: previewMesh } : null)");
    // In .glb mode unticking means "the shader file without the model" — both flags.
    const glbBranch = row.slice(row.indexOf('if (glb) {'), row.indexOf('if (builtin) setExportBuiltinModel'));
    expect(glbBranch).toContain('setExportAsGlb(false);');
    expect(glbBranch).toContain('setExportIncludeMesh(false);');
    expect(POPOVER).toContain('GLB_EXPORT_KEYS.meshNoteGlb');
    // The format radio never writes the mesh flag.
    const group = POPOVER.slice(
      POPOVER.indexOf('className="toolbar__export-format"'),
      POPOVER.indexOf("t(GLB_EXPORT_KEYS.formatGlb, language)"),
    );
    expect(group).not.toContain('setExportIncludeMesh');
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
    const call = TOOLBAR.indexOf('buildShaderExportChecked(');
    const evalBranch = TOOLBAR.lastIndexOf('if (isEvalMode()) {', call);
    expect(evalBranch).toBeGreaterThan(-1);
    expect(TOOLBAR.slice(evalBranch, call)).toContain('setEvalFinishOpen(true)');
    expect(TOOLBAR).toContain('if (exportBusyRef.current) return;');
    expect(TOOLBAR).toContain("delivery: 'download'");
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

describe('the engine gate and the derived flag', () => {
  it('isEvalMode is answered BEFORE the first single-GLB call', () => {
    const fn = EXPORT_SHADER.slice(EXPORT_SHADER.indexOf('export async function buildShaderExportChecked'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const gate = body.indexOf('isEvalMode()');
    const prepare = body.indexOf('prepareSingleGlb');
    expect(gate).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(gate);
    expect(body).toContain("effectiveExportFormat(s.exportAsGlb, s.previewMesh, false) !== 'glb'");
    expect(body).toContain('buildShaderBundleChecked(asks.preflight, graph, model)');
    // The telemetry chokepoint stays on the download tail. The pattern is
    // ASSEMBLED, because evalHooks.test.ts scans every file under src/ for the
    // call text and would count this one as a logging site.
    expect(EXPORT_SHADER).toMatch(new RegExp(['evalLog', "\\('export'"].join('')));
  });

  it('no surface reads the raw flag except through effectiveExportFormat', () => {
    for (const [name, src] of [
      ['Toolbar', TOOLBAR],
      ['WorkFolder', WORK_FOLDER],
      ['CodeEditor', read('components/CodeEditor/CodeEditor.tsx')],
      ['exportShader', EXPORT_SHADER],
    ] as const) {
      for (const m of src.matchAll(/\.exportAsGlb\b/g)) {
        const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
        // Either the value goes straight into the decision, or the line is the
        // plain store selector that feeds it one render later.
        const ok =
          line.includes('effectiveExportFormat(') ||
          line.trim() === 'const exportAsGlb = useAppStore((s) => s.exportAsGlb);';
        expect(ok, `${name}: ${line.trim()}`).toBe(true);
      }
      // …and nothing branches on the raw flag.
      expect(src, name).not.toMatch(/\bexportAsGlb\s*(\?|&&|\|\||===|!==)/);
    }
  });

  it('the flag is session-only: no history, no autosave, no project block', () => {
    const store = read('store/useAppStore.ts');
    const snapshot = store.slice(store.indexOf('function snapshotOf'), store.indexOf('function snapshotOf') + 2000);
    expect(snapshot).not.toContain('exportAsGlb');
    expect(store).not.toContain("'fs:exportAsGlb'");
    expect(store).toContain('exportAsGlb: asGlb === true');
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

  it('opening one adopts the FORMAT, so Save writes back to that file', () => {
    // Without it `bundleKind` is still 'js'/'zip', `workFolderSaveName` re-extends
    // the tracked name, and the next Save forks a sibling while `waves.glb` keeps
    // the pre-edit shader — silently, since the folder holds no such sibling to
    // confirm over.
    const branch = WORK_FOLDER.slice(
      WORK_FOLDER.indexOf('await importShaderGlb(entry.fileName, bytes)'),
      WORK_FOLDER.indexOf("} else if (/\\.zip$/i.test(entry.fileName))"),
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toContain('setExportAsGlb(true)');
  });

  it('a study session neither lists nor opens one', () => {
    expect(WORK_FOLDER).toContain('isEvalMode() ? list.filter((e) => !/\\.glb$/i.test(e.fileName)) : list');
    expect(WORK_FOLDER).toContain('if (isEvalMode() && /\\.glb$/i.test(entry.fileName)) return;');
  });
});

describe('the code panel follows the format', () => {
  it("the A-Frame tab hangs the shader on the model, and each tab's label names its own file", () => {
    const src = read('components/CodeEditor/CodeEditor.tsx');
    expect(src).toContain("...(exportFormat === 'glb' ? { modelFile: glbFileName } : {})");
    expect(src).toContain('GLB_EXPORT_KEYS.tabAFrameGlb');
    expect(src).toContain('GLB_EXPORT_KEYS.tabThreeGlb');
    // The Three.js page stays on the .js export.
    expect(src).not.toContain('buildThreeEmbedHTML(scriptCode, {\n        shaderFile: glbFileName');
  });
});
