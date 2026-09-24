/**
 * The GLB import dialog's RESTORE widening (GLB Phase 7 Step 6): the pure
 * plan and words for real, and the wiring (the modal, the hook, ShaderPreview)
 * from SOURCE — the vitest env is `node`, so those components have no
 * rendering test (glbImportDialog.test.ts's pattern). The commit itself is
 * engine/projectImportGlb.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import lv from '@/i18n/lv.json';
import {
  planGlbImportDialog,
  restoreFactOf,
  MAX_FACT_ASSETS_REFUSED,
  type GlbDialogContext,
  type GlbImportFacts,
  type GlbRestoreFact,
} from '@/utils/glbImportGate';
import {
  FS_REASON_KEYS,
  GLB_IMPORT_KEYS,
  GLB_RESTORE_KEYS,
  fsRefusalNotice,
  glbDialogCopy,
  glbRestoredLineText,
} from '@/utils/glbImportCopy';
import { importNoteLifetimeMs, importNoteLineText, GLB_REPORT_NOTE_MS } from '@/utils/importNote';
import { MESH_MAX_BYTES } from '@/utils/previewMesh';

const UI = (lv as { ui: Record<string, string> }).ui;
const CTX: GlbDialogContext = { allowManyMaterials: false, ignoreImageLimits: false, deviceMaxDim: 2048 };

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const FACT: GlbRestoreFact = { hasProject: true, hasModule: true, moduleEdited: false, assetsRefused: 0 };

function buildable(over: Partial<GlbImportFacts> = {}): GlbImportFacts {
  return {
    kind: 'glb',
    fileName: 'm.glb',
    fileBytes: 1000,
    materialIndices: [0],
    textures: [{ key: 'k', slot: 'baseColor', width: 256, height: 256, sourceLossless: false, materials: [0] }],
    embeddedShader: null,
    ...over,
  };
}

describe('planGlbImportDialog — restore', () => {
  it('no facts (the reader refused the model) but a stored shader: offered, restore only', () => {
    const p = planGlbImportDialog(null, CTX, { fact: FACT, refusal: null, fileBytes: 10 });
    expect(p).toMatchObject({ offer: true, primary: null, gate: null, budget: null, embeddedShader: FACT, embeddedRefusal: null });
    expect(p.buildMaterialIndices).toEqual([]);
    expect(p.modelOnlyRefusal).toBeNull();
    const big = planGlbImportDialog(null, CTX, { fact: FACT, refusal: null, fileBytes: MESH_MAX_BYTES + 1 });
    expect(big.modelOnlyRefusal?.reason).toBe('too-large');
  });

  it('a textureless model with a stored shader: restore only, with its counts', () => {
    const p = planGlbImportDialog(buildable({ textures: [] }), CTX, { fact: FACT, refusal: null });
    expect(p).toMatchObject({ offer: true, primary: null, materials: 1, textures: 0, embeddedShader: FACT });
  });

  it('both offered: the Phase 5 build plan plus the restore fact', () => {
    const p = planGlbImportDialog(buildable(), CTX, { fact: FACT, refusal: null });
    expect(p.primary).toBe('build');
    expect(p.gate).toEqual({ state: 'ok', build: 1 });
    expect(p.embeddedShader).toBe(FACT);
    // Without the third argument the plan is Phase 5's, with the two fields null.
    expect(planGlbImportDialog(buildable(), CTX)).toMatchObject({ primary: 'build', embeddedShader: null, embeddedRefusal: null });
  });

  it('a refused stored shader is carried, offered or not; junk refusals are not', () => {
    expect(planGlbImportDialog(null, CTX, { fact: null, refusal: 'damaged' })).toMatchObject({ offer: false, embeddedRefusal: 'damaged' });
    expect(planGlbImportDialog(buildable(), CTX, { fact: null, refusal: 'inconsistent' })).toMatchObject({
      offer: true,
      primary: 'build',
      embeddedRefusal: 'inconsistent',
    });
    for (const junk of ['nope', 5, null, undefined, {}]) {
      expect(planGlbImportDialog(null, CTX, { fact: null, refusal: junk as never }).embeddedRefusal).toBeNull();
    }
  });

  it('restoreFactOf reads only an ok result, and clamps the refused-asset count', () => {
    expect(restoreFactOf({ state: 'none' })).toBeNull();
    expect(restoreFactOf({ state: 'refused', reason: 'damaged' })).toBeNull();
    const ok = (assetsRefused: number, projectText: string | null) =>
      restoreFactOf({ state: 'ok', shader: { moduleText: null, projectText, assets: new Map(), assetsRefused, moduleEdited: true } });
    expect(ok(3, 'p')).toEqual({ hasProject: true, hasModule: false, moduleEdited: true, assetsRefused: 3 });
    expect(ok(1e9, null)!.assetsRefused).toBe(MAX_FACT_ASSETS_REFUSED);
    expect(ok(-1, null)!.assetsRefused).toBe(0);
  });
});

describe('glbDialogCopy — restore', () => {
  const copy = (plan: ReturnType<typeof planGlbImportDialog>, facts: GlbImportFacts | null, hasModel = false) =>
    glbDialogCopy(plan, facts, { hasModel, phase: 'ask', progress: null, fileName: 'x.glb' }, 'en');

  it('restore only: the title asks, and its summary + replace warning ride the BUTTON', () => {
    const c = copy(planGlbImportDialog(null, CTX, { fact: FACT, refusal: null }), null);
    expect(c.title).toBe('Restore the shader stored in “x.glb”?');
    // The body carries WARNINGS only now; what the answer does is its tooltip.
    expect(c.lines).toEqual([]);
    expect(c.primaryLabel).toBeNull();
    expect(c.restoreLabel).toBe(GLB_RESTORE_KEYS.restore);
    expect(c.restoreTitle).toContain(GLB_RESTORE_KEYS.restoreTitle);
    expect(c.restoreTitle).toContain(GLB_RESTORE_KEYS.summaryProject);
    expect(c.restoreTitle).toContain(GLB_RESTORE_KEYS.replacesRestore);
  });

  it('module only, edited and with refused images: the module summary and the images warning, never the edited one', () => {
    const fact = { hasProject: false, hasModule: true, moduleEdited: true, assetsRefused: 2 };
    const c = copy(planGlbImportDialog(null, CTX, { fact, refusal: null }), null);
    expect(c.lines.map((l) => [l.text, l.tone])).toEqual([
      ['Embedded images that cannot be used: 2', 'warn'],
    ]);
    expect(c.restoreTitle).toContain(GLB_RESTORE_KEYS.summaryModule);
  });

  it('with the project, an edited module adds its warning', () => {
    const c = copy(planGlbImportDialog(null, CTX, { fact: { ...FACT, moduleEdited: true }, refusal: null }), null);
    expect(c.lines.map((l) => l.text)).toContain(GLB_RESTORE_KEYS.moduleEdited);
  });

  it('both offered: each answer explains ITSELF, and the body stays empty', () => {
    const c = copy(planGlbImportDialog(buildable(), CTX, { fact: FACT, refusal: null }), buildable(), true);
    // The build's counts are the header's FACT rows now, not prose lines.
    expect(c.facts).toEqual([expect.stringMatching(/^Textures: 1 \(memory: .* MB\)$/), 'Materials: 1']);
    expect(c.lines).toEqual([]);
    expect(c.primaryLabel).toBe(GLB_IMPORT_KEYS.withMaterials);
    // The build tooltip promises the canvas survives; the restore's says it
    // replaces. There is no combined sentence any more, because the two
    // answers no longer do the same thing to the graph.
    expect(c.primaryTitle).toContain(GLB_IMPORT_KEYS.replaces);
    expect(c.primaryTitle).toContain(GLB_IMPORT_KEYS.modelReplaced);
    expect(c.restoreTitle).toContain(GLB_RESTORE_KEYS.replacesRestore);
    expect(c.restoreLabel).toBe(GLB_RESTORE_KEYS.restore);
    expect(c.title).toContain('Restore');
  });

  it('build with a refused stored shader: one warning line, the build title, no restore button', () => {
    const c = copy(planGlbImportDialog(buildable(), CTX, { fact: null, refusal: 'unsupported-version' }), buildable());
    expect(c.lines[0]).toEqual({ text: 'The shader stored in this model could not be read (it was saved by a newer FastShaders).', tone: 'warn' });
    // A build dialog's heading is the bare file name; only a RESTORE still
    // asks a question, because it replaces the project with someone else's code.
    expect(c.title).toBe('m.glb');
    expect(c.restoreLabel).toBeNull();
    expect(c.primaryTitle).toContain(GLB_IMPORT_KEYS.replaces);
  });
});

describe('the restore words', () => {
  it('every key is translated, with the same placeholders', () => {
    const ph = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort();
    const keys = [...Object.values(GLB_RESTORE_KEYS), ...FS_REASON_KEYS.values(), 'Load the dropped shader file? It replaces the current project.'];
    for (const key of keys) {
      expect(UI[key], key).toBeTypeOf('string');
      expect(UI[key]).not.toBe(key);
      expect(ph(UI[key])).toEqual(ph(key));
    }
    expect([...FS_REASON_KEYS.keys()].sort()).toEqual(['damaged', 'inconsistent', 'too-large', 'unsupported-version']);
    expect(Object.isFrozen(GLB_RESTORE_KEYS)).toBe(true);
  });

  it('single-pass fills: a file name spelling a placeholder stays verbatim', () => {
    expect(fsRefusalNotice('{reason}$&.glb', 'damaged', 'en')).toBe(
      'The shader stored in “{reason}$&.glb” could not be read (the file is damaged), so only the model was loaded.',
    );
    expect(glbRestoredLineText({ fileName: '{name}.glb', imported: 'script' }, 'en')).toBe(
      'Opened the shader code stored in “{name}.glb”',
    );
    expect(fsRefusalNotice('a.glb', 'too-large', 'lv')).toContain(UI['it is too large']);
  });

  it("the import note's 'glb-restored' line renders both variants and lives 30 s", () => {
    expect(importNoteLineText({ kind: 'glb-restored', fileName: 'a.glb', imported: 'project' }, 'en')).toBe(
      'Restored the shader and node graph from “a.glb”',
    );
    expect(importNoteLineText({ kind: 'glb-restored', fileName: 'a.glb', imported: 'script' }, 'lv')).toBe(
      'Atvērts failā “a.glb” saglabātais ēnotāja kods',
    );
    expect(importNoteLifetimeMs({ id: 'n', lines: [{ kind: 'glb-restored', fileName: 'a.glb', imported: 'project' }] })).toBe(
      GLB_REPORT_NOTE_MS,
    );
  });
});

describe('the wiring (source pins)', () => {
  const MODAL = codeOnly(read('../Modals/GlbImportModal.tsx'));
  const HOOK = codeOnly(read('useGlbImport.tsx'));
  const PREVIEW = codeOnly(read('ShaderPreview.tsx'));

  it('ShaderPreview threads the drop source; the paired branch never offers; the study gate is untouched', () => {
    expect(PREVIEW).toContain('else void loadMeshFile(model, { source });');
    expect(PREVIEW).toContain('void loadMeshFile(model, { offerBuild: false });');
    expect(PREVIEW).toContain("glbFlow.offer(file.name, bytes, kind, opts?.source ?? 'dom')");
    expect(PREVIEW).toMatch(/const offer = opts\?\.offerBuild !== false && !isEvalMode\(\)/);
  });

  it('Restore confirms a forwarded drop with the forwarded-shader key BEFORE the commit, and only then', () => {
    const at = HOOK.indexOf("if (c === 'restore') {");
    expect(at).toBeGreaterThan(-1);
    const branch = HOOK.slice(at, HOOK.indexOf('return;\n    }\n    if (req.plan.primary', at));
    const confirm = branch.indexOf("window.confirm(`${t('Load the dropped shader file? It replaces the current project.', lang)}");
    expect(confirm).toBeGreaterThan(-1);
    expect(branch.slice(0, confirm)).toContain("req.source === 'iframe' &&");
    expect(branch.indexOf('importShaderGlb(')).toBeGreaterThan(confirm);
    expect(branch).toContain('if (!req.plan.embeddedShader || abortRef.current) return;');
    expect(HOOK.split('importShaderGlb(')).toHaveLength(2);
  });

  it('a refused stored shader is announced after the model-only load, from both decline paths', () => {
    expect(HOOK).toContain('queueMicrotask(');
    expect(HOOK).toContain('fsRefusalNotice(sanitizeMeshFileName(fileName, \'glb\'), reason, lang)');
    expect(HOOK.match(/announceRefusal\(\)/g)?.length).toBe(2);
  });

  it('the modal: Restore renders last, primary only then, never the focused default, nothing remembered', () => {
    const build = MODAL.indexOf("onClick={() => onChoose('build')}");
    const restore = MODAL.indexOf("onClick={() => onChoose('restore')}");
    expect(restore).toBeGreaterThan(build);
    expect(MODAL).toContain("title={copy.restoreTitle ?? undefined}");
    const focusAt = MODAL.indexOf('const btn = modelOnlyRef.current');
    const focus = MODAL.slice(focusAt, MODAL.indexOf('}, [open', focusAt));
    expect(focus).not.toMatch(/restore/i);
    expect(MODAL).not.toContain('localStorage');
    expect(MODAL).not.toContain('type="checkbox"');
  });
});
