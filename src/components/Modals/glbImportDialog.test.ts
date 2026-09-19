/**
 * The GLB import dialog's wiring, pinned from SOURCE (the vitest env is
 * `node`; the modal, the hook, ShaderPreview, NodeEditor and the Toolbar have
 * no rendering test — the modelDropNotices.test.ts pattern). The decisions
 * behind each pin are tested for real in utils/ (glbImportGate,
 * glbImportCopy, glbImportReport, previewModelDrop) and engine/ (gltfImport,
 * glbImportCommit).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLB_READ_MAX_BYTES } from '@/utils/gltfCompression';
import { READ_MAX_TOTAL_UNCOMPRESSED } from '@/utils/zipReader';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const MODAL = read('GlbImportModal.tsx');
const HOOK = read('../Preview/useGlbImport.tsx');
const PREVIEW = read('../Preview/ShaderPreview.tsx');
const NODE_EDITOR = read('../NodeEditor/NodeEditor.tsx');
const TOOLBAR = read('../Layout/Toolbar.tsx');
const EVAL_GATE = read('../../eval/EvalGate.tsx');
const STORE = read('../../store/useAppStore.ts');
const LIMITS = read('../../utils/glbImportLimits.ts');
const CLAUDE = readFileSync(resolve(__dirname, '../../../CLAUDE.md'), 'utf8');

/** Strip block and line comments, so a pin cannot be satisfied by prose. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** The text of a `const name = useCallback(` … up to its first `}, [` dep list. */
function callbackBody(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at, `${name} was renamed`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('}, [', at));
}

describe('GlbImportModal', () => {
  const code = codeOnly(MODAL);

  it('remembers nothing: no checkbox, no "remember", no localStorage', () => {
    expect(code).not.toContain('type="checkbox"');
    expect(code).not.toMatch(/remember/i);
    expect(code).not.toContain('localStorage');
  });

  it('Escape cancels, in the CAPTURE phase, and every other key but Tab is swallowed', () => {
    expect(code).toMatch(/e\.key === 'Escape'[\s\S]{0,80}onChoose\('cancel'\)/);
    expect(code).toContain("window.addEventListener('keydown', onKey, true)");
    expect(code).toMatch(/if \(e\.key !== 'Tab'\) e\.stopPropagation\(\)/);
  });

  it('initial focus goes to Model only when enabled, else the panel — never the primary', () => {
    const at = code.indexOf('const btn = modelOnlyRef.current');
    expect(at).toBeGreaterThan(-1);
    const focus = code.slice(at, code.indexOf('}, [open', at));
    expect(focus).toContain('btn.focus()');
    expect(focus).toContain('panelRef.current?.focus()');
    expect(focus).not.toContain('primary');
  });

  it('the backdrop swallows drag/drop and cancels only while asking', () => {
    expect(code).toContain('onDragOver={(e) => e.preventDefault()}');
    expect(code).toContain('onDrop={(e) => e.preventDefault()}');
    expect(code).toMatch(/onClick=\{\(\) => \{ if \(!building\) onChoose\('cancel'\); \}\}/);
  });

  it('Model only is refused with aria-disabled + the reason as its title, never `disabled`', () => {
    const at = code.indexOf('ref={modelOnlyRef}');
    const btn = code.slice(at, code.indexOf('</button>', at));
    expect(btn).toContain('aria-disabled={modelOnlyBlocked || undefined}');
    expect(btn).toContain('title={copy.modelOnlyDisabledReason ?? undefined}');
    expect(btn).toContain("if (!modelOnlyBlocked) onChoose('model')");
  });

  it('the primary is rendered only with a label, and the buttons are Cancel / Model only / primary', () => {
    expect(code).toContain('{copy.primaryLabel && (');
    const cancel = code.indexOf("onClick={() => onChoose('cancel')}");
    const model = code.indexOf('ref={modelOnlyRef}');
    const primary = code.indexOf("onClick={() => onChoose('build')}");
    expect(cancel).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(cancel);
    expect(primary).toBeGreaterThan(model);
  });
});

describe('useGlbImport', () => {
  const code = codeOnly(HOOK);

  it('Model only touches neither commitGlbImport nor any event — the caller applies the bytes it read', () => {
    const at = code.indexOf("if (c === 'model') {");
    const branch = code.slice(at, code.indexOf("if (req.plan.primary === null", at));
    expect(branch).toContain('depsRef.current.applyModelBytes(req.fileName, req.bytes)');
    expect(branch).not.toContain('commitGlbImport');
    expect(branch).not.toContain('CustomEvent');
    expect(branch).not.toContain('dispatchEvent');
  });

  it('Build commits exactly once and posts ONE report note', () => {
    expect(code).toContain("import { commitGlbImport, importShaderGlb } from '@/engine/projectImport'");
    expect(code.split('commitGlbImport(')).toHaveLength(2); // exactly one call
    expect(code).toContain('showImportNote(glbImportReportLines(r.report))');
  });

  it('a second drop while open is refused with the busy notice; the reader refusal is an info line', () => {
    expect(code).toContain("depsRef.current.showDropNotice(t(GLB_IMPORT_KEYS.busy, lang))");
    expect(code).toContain("return 'busy'");
    // The notice names the SANITIZED file name, never the raw dropped one.
    expect(code).toMatch(/gltfBuildRefusalMessage\(read\.refusal, sanitizeMeshFileName\(fileName, kind\), bytes\.length, lang\),\s*'info',?\s*\)/);
    expect(code).not.toMatch(/gltfBuildRefusalMessage\(read\.refusal, fileName,/);
  });

  it('the build seeds NO progress: the line waits for the encoder\'s first (0, total) report', () => {
    const at = code.indexOf("setPhase('building');");
    expect(at).toBeGreaterThan(-1);
    const seed = code.slice(at, code.indexOf('buildGlbImport(', at));
    expect(seed).toContain('setProgress(null)');
    expect(code).not.toContain('setProgress({ done: 0, total: 0 })');
  });

  it('the portal host follows fullscreen (pickPortalHost), and unmount aborts', () => {
    expect(code).toContain('pickPortalHost(fullscreenEl(), depsRef.current.anchorRef.current, document.body)');
    expect(code).toContain("document.addEventListener('fullscreenchange', resolve)");
    expect(code).toMatch(/useEffect\(\(\) => \(\) => \{ abortRef\.current\?\.abort\(\); \}, \[\]\)/);
  });
});

describe('ShaderPreview.loadMeshFile', () => {
  const load = callbackBody(PREVIEW, 'loadMeshFile');

  it('decides the offer before the read, with isEvalMode in the expression', () => {
    const offer = load.indexOf('const offer =');
    const read = load.indexOf('file.arrayBuffer()');
    expect(offer).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(offer);
    expect(load.slice(offer, load.indexOf(';', offer))).toContain('!isEvalMode()');
  });

  it('passes the offer predicate to the ONE gate, so a paired or study drop keeps the 64 MiB cap', () => {
    expect(load).toContain('preReadModelGate(detectMeshKind(file.name), file.size, offer)');
    expect(load).not.toContain('MESH_MAX_BYTES');
    expect(load).not.toContain('GLB_READ_MAX_BYTES');
  });

  it('a busy dialog refuses EVERY model drop (offered or not); a declined offer falls through to today\'s model drop', () => {
    const body = codeOnly(load);
    expect(body).toContain('if (glbFlow.busy())');
    expect(body).not.toContain('offer && glbFlow.busy()');
    // Refused before anything is read or applied.
    expect(body.indexOf('if (glbFlow.busy())')).toBeLessThan(body.indexOf('file.arrayBuffer()'));
    expect(load).toContain("glbFlow.offer(file.name, bytes, kind, opts?.source ?? 'dom') !== 'declined') return;");
    expect(load).toContain('applyModelBytes(file.name, bytes);');
  });

  it('a busy dialog refuses a dropped shader or model in handleDroppedFiles, before the iframe confirm', () => {
    const drop = codeOnly(callbackBody(PREVIEW, 'handleDroppedFiles'));
    const guard = drop.indexOf('if (glbFlow.busy() && (model || zip || script))');
    expect(guard).toBeGreaterThan(-1);
    expect(drop.slice(guard, guard + 160)).toContain('showDropNotice(t(GLB_IMPORT_KEYS.busy, language))');
    expect(guard).toBeLessThan(drop.indexOf('window.confirm('));
    expect(guard).toBeLessThan(drop.indexOf('importShaderZip('));
    expect(guard).toBeLessThan(drop.indexOf('importShaderText('));
  });

  it('the combined shader+model drop and the paired canvas drop are never offered', () => {
    expect(PREVIEW).toContain('void loadMeshFile(model, { offerBuild: false })');
    const at = PREVIEW.indexOf('window.addEventListener(PREVIEW_MODEL_FILE_EVENT');
    const effect = PREVIEW.slice(PREVIEW.lastIndexOf('useEffect(', at), at);
    expect(effect).toContain('previewModelDropOf(ev)');
    expect(effect).toContain('offerBuild: !d.pairedWithShader');
  });

  it('applyModelBytes keeps the model drop verbatim and the modal is rendered', () => {
    const apply = callbackBody(PREVIEW, 'applyModelBytes');
    expect(apply).toContain('createPreviewMesh(fileName, bytes)');
    expect(apply).toContain('meshRefusalMessage(result.refusal, language)');
    expect(apply).toContain("setGeometry('custom')");
    expect(PREVIEW).toContain('{glbFlow.modal}');
  });
});

describe('NodeEditor', () => {
  it('pairs the model dropped WITH a project, and not the one dropped alone', () => {
    expect(NODE_EDITOR).toContain('requestPreviewModelLoad(models[0], { pairedWithShader: true })');
    expect(NODE_EDITOR.split('requestPreviewModelLoad(models[0])')).toHaveLength(2);
  });

  it('the import note lives as long as its lines say', () => {
    expect(NODE_EDITOR).toContain('importNoteLifetimeMs(importNote)');
    expect(codeOnly(NODE_EDITOR)).not.toMatch(/dismissImportNote\(id\);\s*\}, 12000\)/);
  });
});

describe('Toolbar', () => {
  const code = codeOnly(TOOLBAR);

  it('the allow-many row sits inside !isEvalMode() and drives the store setter', () => {
    const at = code.indexOf("fillTemplate(t('Allow more than {limit} materials'");
    expect(at).toBeGreaterThan(-1);
    const before = code.slice(code.lastIndexOf('{!isEvalMode() && (', at), at);
    expect(before).toContain('setAllowManyMaterials(e.target.checked)');
    expect(before).toContain('checked={allowManyMaterials}');
  });

  it('its hint is its OWN constant, outside OPTIONAL_CATEGORY_HINTS, and the popover height counts rows', () => {
    const block = TOOLBAR.slice(TOOLBAR.indexOf('const OPTIONAL_CATEGORY_HINTS'), TOOLBAR.indexOf('};', TOOLBAR.indexOf('const OPTIONAL_CATEGORY_HINTS')));
    expect(block).not.toContain('materials');
    expect(code).toContain('const ALLOW_MANY_MATERIALS_HINT =');
    expect(code).toContain('prefsHeight(prefsRows)');
    expect(code).toContain("(isEvalMode() ? 0 : 1)");
    expect(code).not.toContain('PREFS_H ');
  });
});

describe('the flag', () => {
  it('EvalGate resets it (a study condition)', () => {
    const at = EVAL_GATE.indexOf('function cleanSlateForStudy');
    const body = EVAL_GATE.slice(at, EVAL_GATE.indexOf('\nexport function EvalGate', at));
    expect(body).toContain('removeItem(ALLOW_MANY_MATERIALS_KEY)');
    expect(body).toContain('allowManyMaterials: false');
  });

  it('the store reads the LEAF, never the gate or the copy', () => {
    const store = codeOnly(STORE);
    expect(store).toContain("from '@/utils/glbImportLimits'");
    expect(store).not.toContain('glbImportGate');
    expect(store).not.toContain('glbImportCopy');
    expect(LIMITS).not.toMatch(/^import /m);
  });

  it("the build-path pre-read cap is THIS build's zip reader cap (96 MiB web, 256 MiB desktop)", () => {
    expect(GLB_READ_MAX_BYTES).toBe(READ_MAX_TOTAL_UNCOMPRESSED);
  });

  it('CLAUDE.md names the key and the convention', () => {
    expect(CLAUDE).toContain('fs:allowManyMaterials');
    expect(CLAUDE).toContain('GlbImportModal');
  });
});
