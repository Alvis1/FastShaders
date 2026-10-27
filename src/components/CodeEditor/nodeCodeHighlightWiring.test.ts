import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The node → code highlight's wiring (useNodeCodeHighlight.ts). Monaco does
 * not run under `node`, so what is pinned here is where each piece sits; the
 * pure half is nodeCodeHighlight.test.ts, the behaviour against a fake editor
 * nodeCodeHighlightEditor.test.ts, the spans nodeSpans.test.ts.
 */
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const hook = read('./useNodeCodeHighlight.ts');
const editor = read('./CodeEditor.tsx');
const sync = read('../../hooks/useSyncEngine.ts');

describe('node → code highlight wiring (source pins)', () => {
  it('the TSL editor attaches it on mount, and only the TSL editor', () => {
    expect(editor).toContain('const attachHighlight = useNodeCodeHighlight();');
    const mount = editor.slice(editor.indexOf('const handleMount'), editor.indexOf('const handleChange'));
    expect(mount).toContain('attachHighlight(editor, monaco);');
    // The read-only A-Frame / Three.js editors take no onMount.
    expect(editor.match(/onMount=\{/g)).toHaveLength(1);
  });

  it('a study session attaches nothing — on mount and on a replayed effect', () => {
    const cb = hook.slice(hook.indexOf('return useCallback('));
    expect(cb).toMatch(/if \(isEvalMode\(\)\) return;\s+ctrl\.current = attachNodeCodeHighlight\(editor, monaco\);/);
    expect(hook).toContain('if (!ctrl.current && last.current && !isEvalMode())');
  });

  it('no animation-frame loop and no telemetry', () => {
    expect(hook).not.toContain('requestAnimationFrame(');
    expect(hook).not.toContain('evalLog');
  });

  it('repaints inside the content-change event and undoes everything it attached', () => {
    const change = hook.slice(hook.indexOf('editor.onDidChangeModelContent('), hook.indexOf('editor.onDidLayoutChange('));
    expect(change).toContain('seedAndPaint(pair)');
    expect(change).toContain('paint();');
    const dispose = hook.slice(hook.indexOf('function dispose()'));
    expect(dispose).toContain('unsubscribe();');
    expect(dispose).toContain("window.removeEventListener('pointerdown', onPointerDown, true);");
    expect(dispose).toContain("window.removeEventListener('click', onClick, true);");
  });

  it('the spans ride the graph→code write with their text', () => {
    expect(sync).toContain("setCode(result.code, 'graph', previewText, { emitted, names: result.varNames, nodeSpans: result.nodeSpans })");
  });
});
