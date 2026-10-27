import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from './useAppStore';
import type { CodeSpan } from '@/types';
import { HISTORY_IDLE } from '@/test-utils';

/**
 * `codeNodeSpans` — the graph→code pass's text WITH each node's spans in it,
 * for the code panel's node → code highlight — is ONE value written in the
 * SAME `set()` as `code`, so no subscriber ever pairs a text with another
 * text's spans.
 */
describe('store codeNodeSpans', () => {
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({
      code: '',
      previewCode: '',
      codeEmitted: null,
      codeNodeSpans: null,
      syncSource: 'graph',
      ...HISTORY_IDLE,
    });
  });

  const span: CodeSpan = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 12, kind: 'own', inline: false };

  it("a 'graph' write carries the code and its spans in ONE notification", () => {
    const spans = new Map([['n', [span]]]);
    const seen: { code: string; pairCode: string | undefined }[] = [];
    const off = useAppStore.subscribe((s) => seen.push({ code: s.code, pairCode: s.codeNodeSpans?.code }));
    try {
      useAppStore.getState().setCode('a\nconst x = 1;', 'graph', undefined, { emitted: null, nodeSpans: spans });
    } finally {
      off();
    }
    expect(seen).toEqual([{ code: 'a\nconst x = 1;', pairCode: 'a\nconst x = 1;' }]);
    expect(useAppStore.getState().codeNodeSpans?.spans).toBe(spans);
  });

  it("a 'graph' write without spans clears the pair", () => {
    useAppStore.getState().setCode('x', 'graph', undefined, { nodeSpans: new Map([['n', [span]]]) });
    useAppStore.getState().setCode('y', 'graph');
    expect(useAppStore.getState().codeNodeSpans).toBeNull();
  });

  it("typing (a 'code' write) leaves the pair alone: it carries its own text", () => {
    useAppStore.getState().setCode('x', 'graph', undefined, { nodeSpans: new Map([['n', [span]]]) });
    const pair = useAppStore.getState().codeNodeSpans;
    useAppStore.getState().setCode('x // typed', 'code');
    expect(useAppStore.getState().code).toBe('x // typed');
    expect(useAppStore.getState().codeNodeSpans).toBe(pair);
    expect(pair?.code).toBe('x');
  });
});
