/**
 * A BLOCKING parse error describes the text a failed Apply left in the code
 * panel. When the graph→code pass replaces that text (any graph edit), the
 * error goes with it: before 2026-11-19 the panel kept "Unexpected token
 * (10:39)" over generated code that had no such line. Warnings describe what
 * a SUCCESSFUL Apply did, and that Apply's own regeneration follows it within
 * a moment — so they stay.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from './useAppStore';
import type { ParseError } from '@/types';

describe("a 'graph' code write and the panel's errors", () => {
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ code: '', previewCode: '', codeErrors: [], codeEmitted: null, codeNodeSpans: null, syncSource: 'graph' });
  });

  const blocking: ParseError = { message: 'Unexpected token (10:39)', line: 10 };
  const warning: ParseError = { message: 'A Loop block was skipped.', line: 4, severity: 'warning' };

  it('drops the blocking errors of the text it replaces', () => {
    useAppStore.getState().setCode('const a = float(0.25;', 'code');
    useAppStore.getState().setCodeErrors([blocking]);
    useAppStore.getState().setCode('const a = float(0.25);', 'graph');
    expect(useAppStore.getState().codeErrors).toEqual([]);
  });

  it('keeps the warnings of the Apply it follows', () => {
    useAppStore.getState().setCodeErrors([warning, blocking, { ...blocking, severity: 'error' }]);
    useAppStore.getState().setCode('x', 'graph');
    expect(useAppStore.getState().codeErrors).toEqual([warning]);
  });

  it('keeps the SAME array when there is nothing to drop (a scrub frame)', () => {
    const errors = [warning];
    useAppStore.getState().setCodeErrors(errors);
    useAppStore.getState().setCode('x', 'graph');
    expect(useAppStore.getState().codeErrors).toBe(errors);
  });

  it('typing leaves the errors alone: they describe the text being fixed', () => {
    useAppStore.getState().setCode('x', 'graph');
    useAppStore.getState().setCodeErrors([blocking]);
    useAppStore.getState().setCode('x // typed', 'code');
    expect(useAppStore.getState().codeErrors).toEqual([blocking]);
  });
});
