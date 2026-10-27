import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from './useAppStore';
import { HISTORY_IDLE, makeNode } from '@/test-utils';
import { importShaderText, preloadShaderImport } from '@/engine/projectImport';

/**
 * `codeEmitted` — the node ids the panel's `code` was generated from
 * (engine/panelCode.ts) — rides the SAME `set()` as the code, so no subscriber
 * and no Apply ever reads a text with another text's scope.
 */
describe('store codeEmitted', () => {
  beforeAll(() => preloadShaderImport());
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({
      nodes: [makeNode('output-1', 'output')],
      edges: [],
      code: '',
      previewCode: '',
      codeEmitted: null,
      codeNames: null,
      codeScopes: [],
      syncSource: 'graph',
      codeSyncRequested: false,
      ...HISTORY_IDLE,
    });
  });
  // The setState above and the import below both arm the 300 ms graph save;
  // under `isolate: false` it would fire in the next file (docs/dev/testing.md).
  afterEach(() => cancelPendingGraphSave());

  it("a 'graph' write sets it with the code, in ONE notification", () => {
    const ids = new Set(['a', 'b']);
    let notes = 0;
    const off = useAppStore.subscribe(() => { notes++; });
    try {
      useAppStore.getState().setCode('const x = 1;', 'graph', undefined, { emitted: ids });
    } finally {
      off();
    }
    expect(notes).toBe(1);
    const s = useAppStore.getState();
    expect(s.code).toBe('const x = 1;');
    expect(s.previewCode).toBe('const x = 1;');
    expect(s.codeEmitted).toBe(ids);
  });

  it("a 'graph' write without a set clears it (the whole graph)", () => {
    useAppStore.setState({ codeEmitted: new Set(['a']) });
    useAppStore.getState().setCode('const y = 2;', 'graph');
    expect(useAppStore.getState().codeEmitted).toBeNull();
  });

  it('typing keeps it: the set describes the text being edited', () => {
    const ids = new Set(['a']);
    useAppStore.getState().setCode('const x = 1;', 'graph', undefined, { emitted: ids });
    useAppStore.getState().setCode('const x = 1; // typed', 'code');
    expect(useAppStore.getState().codeEmitted).toBe(ids);
  });

  it('the names ride with it, and only with a scope', () => {
    const names = new Map([['a', 'float1']]);
    useAppStore.getState().setCode('const x = 1;', 'graph', undefined, { emitted: new Set(['a']), names });
    expect(useAppStore.getState().codeNames).toBe(names);
    useAppStore.getState().setCode('const y = 2;', 'graph', undefined, { names });
    expect(useAppStore.getState().codeNames).toBeNull();
  });

  it('a keystroke on an OLDER pass’s text (the panel’s settle lag) takes that text’s scope back', () => {
    // Pass 1 showed a and b; pass 2 hid b — and Monaco still shows pass 1.
    const first = { emitted: new Set(['a', 'b']), names: new Map([['a', 'x'], ['b', 'y']]) };
    const second = { emitted: new Set(['a']), names: new Map([['a', 'x'], ['b', 'y']]) };
    useAppStore.getState().setCode('// pass 1', 'graph', undefined, first);
    useAppStore.getState().setCode('// pass 2', 'graph', undefined, second);
    expect(useAppStore.getState().codeEmitted).toBe(second.emitted);
    useAppStore.getState().setCode('// pass 1 typed', 'code', undefined, { base: '// pass 1' });
    expect(useAppStore.getState().codeEmitted).toBe(first.emitted);
    expect(useAppStore.getState().codeNames).toBe(first.names);
    // A keystroke on the newest text, or on typed text, moves nothing.
    useAppStore.getState().setCode('// pass 1 typed more', 'code', undefined, { base: '// pass 1 typed' });
    expect(useAppStore.getState().codeEmitted).toBe(first.emitted);
  });

  it('a bare-script import nulls it: that text was never generated from this graph', () => {
    useAppStore.getState().setCode('const x = 1;', 'graph', undefined, { emitted: new Set(['output-1']) });
    const script = `import { color } from "three/tsl";

export default function (params) {
  return { colorNode: color(0xffffff) };
}
`;
    expect(importShaderText(script)).toBe('script');
    expect(useAppStore.getState().codeEmitted).toBeNull();
    expect(useAppStore.getState().codeNames).toBeNull();
    expect(useAppStore.getState().codeScopes).toEqual([]);
  });
});
