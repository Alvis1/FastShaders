/**
 * The dropped-shader dialog's wiring, pinned from SOURCE (the vitest env is
 * `node`; the modal and the three drop surfaces have no rendering test — the
 * glbImportDialog.test.ts pattern). The DECISIONS behind the pins are tested
 * for real in `utils/shaderDropName.test.ts`,
 * `engine/shaderGroupImport.test.ts` and `engine/shaderDropFlow.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const MODAL = read('ShaderImportModal.tsx');
const REQUEST = read('../../utils/shaderDropRequest.ts');
const PREVIEW = read('../Preview/ShaderPreview.tsx');
const NODE_EDITOR = read('../NodeEditor/NodeEditor.tsx');
const CODE_EDITOR = read('../CodeEditor/CodeEditor.tsx');
const APP_LAYOUT = read('../Layout/AppLayout.tsx');
const PLANNER = read('../../engine/shaderGroupImport.ts');
const IMPORT = read('../../engine/projectImport.ts');

/** Strip block and line comments, so a pin cannot be satisfied by prose. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

describe('requestShaderImport — the ONE gate', () => {
  const code = codeOnly(REQUEST);

  it('is skipped in a study session, so a drop there stays byte-for-byte today', () => {
    // The model-drop dialog's rule (docs/dev/eval-mode.md): a study measures
    // the editor the participants were given, and a new dialog is a change.
    expect(code).toMatch(/if \(isEvalMode\(\)\) return false/);
  });

  it('bounds the file name ONCE, here, before anything renders it', () => {
    expect(code).toContain('sanitizeDroppedName(file.name)');
  });

  it('is what all three drop surfaces call', () => {
    for (const [name, src] of [
      ['ShaderPreview', PREVIEW],
      ['NodeEditor', NODE_EDITOR],
      ['CodeEditor', CODE_EDITOR],
    ] as const) {
      expect(codeOnly(src), `${name} no longer asks`).toContain('requestShaderImport(');
    }
  });

  it('and every one of them RETURNS when the dialog took the file', () => {
    // Falling through would run the old import as well — two imports for one
    // drop, the second overwriting the answer the user gave.
    for (const src of [PREVIEW, NODE_EDITOR, CODE_EDITOR]) {
      const at = codeOnly(src).indexOf('requestShaderImport(');
      expect(codeOnly(src).slice(at, at + 400)).toMatch(/\breturn\b/);
    }
  });
});

describe('ShaderImportModal', () => {
  const code = codeOnly(MODAL);

  it('offers exactly two answers plus Cancel', () => {
    expect(code).toContain("answer('add')");
    expect(code).toContain("answer('open')");
    expect(code).toContain('csv-import-modal__cancel');
  });

  it('remembers nothing: no checkbox, no "remember", no localStorage', () => {
    // Replacing a document is never a remembered preference.
    expect(code).not.toContain('type="checkbox"');
    expect(code).not.toMatch(/remember/i);
    expect(code).not.toContain('localStorage');
  });

  it('starts focus on ADD, so Enter cannot replace the document by reflex', () => {
    const at = code.indexOf('if (addRef.current)');
    expect(at).toBeGreaterThan(-1);
    const focus = code.slice(at, code.indexOf('}, [head?.id', at));
    expect(focus).toContain('addRef.current.focus()');
    expect(focus).not.toContain('open');
  });

  it('Escape cancels in the CAPTURE phase, and every other key but Tab is swallowed', () => {
    // The canvas binds its shortcuts on `window` — the NewShaderModal rule.
    expect(code).toMatch(/e\.key === 'Escape'[\s\S]{0,120}close\(\)/);
    expect(code).toContain("window.addEventListener('keydown', onKey, true)");
    expect(code).toMatch(/if \(e\.key !== 'Tab'\) e\.stopPropagation\(\)/);
  });

  it('swallows a drag/drop onto itself, so a second file never navigates the page', () => {
    expect(code).toContain('onDragOver={(e) => e.preventDefault()}');
    expect(code).toContain('onDrop={(e) => e.preventDefault()}');
  });

  it('ignores the backdrop while an import is running', () => {
    expect(code).toMatch(/onClick=\{\(\) => \{ if \(!busy\) close\(\); \}\}/);
  });

  it('tells the raising surface how it settled, on EVERY path', () => {
    // Cancel included — a drop the user cancelled must not go on to load the
    // 3D model that came with it.
    expect(code).toContain("head.onResolved?.('cancelled')");
    expect(code).toContain('item.onResolved?.(outcome)');
    expect(code).toContain('} finally {');
  });

  it('maps a refused zip through the ONE shared mapping before its own message', () => {
    const at = code.indexOf('} catch (e) {');
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, code.indexOf('} finally {', at));
    expect(body.indexOf('reportZipImportError')).toBeLessThan(body.indexOf('window.alert'));
  });

  it('is mounted ONCE, app-wide, beside the other store-queue dialogs', () => {
    expect(APP_LAYOUT).toContain('<ShaderImportModal />');
    expect(MODAL.match(/createPortal\(/g) ?? []).toHaveLength(1);
  });
});

describe('the ADD path', () => {
  it('drops every sink — the planner, not the caller, decides that', () => {
    expect(codeOnly(PLANNER)).toContain('incoming.nodes.filter(isSinkNode)');
  });

  it('announces a MERGE, never an import: the document did not change', () => {
    // `fs:graph-imported` means "a different document now", and the desktop
    // Work folder answers it by forgetting the open file.
    const at = IMPORT.indexOf('export async function addDroppedShader');
    expect(at).toBeGreaterThan(-1);
    const body = IMPORT.slice(at);
    expect(body).toContain('announceGraphMerged()');
    expect(codeOnly(body.slice(0, body.indexOf('\n}')))).not.toContain('announceGraphImport()');
  });

  it('checks the image budget BEFORE pushHistory, so a refusal leaves no undo entry', () => {
    const at = IMPORT.indexOf('export async function addDroppedShader');
    const body = codeOnly(IMPORT.slice(at));
    expect(body.indexOf('exceedsImageBudget')).toBeLessThan(body.indexOf('pushHistory()'));
  });

  it('never installs the archive’s model: Add is not a new document', () => {
    const at = IMPORT.indexOf('export async function addDroppedShader');
    const body = codeOnly(IMPORT.slice(at, IMPORT.indexOf('/* ── the GLB restore')));
    expect(body).not.toContain('setPreviewMesh');
    expect(body).not.toContain('showCustomMesh');
  });
});
