/**
 * The rules of the text the code panel keeps when an Apply dropped code
 * (utils/codeDraft.ts): which report keeps it, which graph→code write ends it,
 * and what the panel's report says afterwards. Pure — the store half is
 * store/codeDraft.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { draftAfterGraphWrite, dropsCode, errorsAfterGraphWrite, panelText, type CodeDraft } from './codeDraft';
import type { ParseError } from '@/types';

const draft = (over: Partial<CodeDraft> = {}): CodeDraft => ({
  code: 'typed',
  applied: 'typed',
  graph: null,
  emitted: new Set(['a']),
  names: new Map([['a', 'x']]),
  ...over,
});

const dropped: ParseError = { message: '"scale = 3" was dropped — a plain number is not a node; write float(3).', line: 4, column: 9, severity: 'warning' };
const kept: ParseError = { message: 'Unknown function: hash', line: 5, severity: 'warning', kept: true };
const blocking: ParseError = { message: 'Unexpected token (10:39)', line: 10 };

describe('which Apply keeps the text', () => {
  it('one whose report says code did not reach the graph', () => {
    expect(dropsCode([dropped])).toBe(true);
    expect(dropsCode([kept, dropped])).toBe(true);
  });

  it('never a clean one, one that only kept an unknown function, or a failed one', () => {
    expect(dropsCode([])).toBe(false);
    expect(dropsCode([kept])).toBe(false);
    // A blocking error changed no graph: the typed text stays for its own reason.
    expect(dropsCode([blocking, { ...blocking, severity: 'error' }])).toBe(false);
  });
});

describe('what the panel shows', () => {
  it('the kept text, else the graph\'s code', () => {
    expect(panelText({ code: 'graph', codeDraft: null })).toBe('graph');
    expect(panelText({ code: 'graph', codeDraft: draft() })).toBe('typed');
    // An emptied panel is still the kept text, not a fall back to the graph's.
    expect(panelText({ code: 'graph', codeDraft: draft({ code: '' }) })).toBe('');
  });
});

describe('a graph→code write and the kept text', () => {
  it('the first write after the Apply is what the text is held against', () => {
    const d = draft();
    expect(draftAfterGraphWrite(d, 'G0', false)).toEqual({ ...d, graph: 'G0' });
  });

  it('the SAME text again keeps it, by identity (a re-measure, a selection, a cost badge)', () => {
    const d = draft({ graph: 'G0' });
    expect(draftAfterGraphWrite(d, 'G0', false)).toBe(d);
    expect(draftAfterGraphWrite(d, 'G0', true)).toBe(d);
  });

  it('another text ends it: the graph changed', () => {
    expect(draftAfterGraphWrite(draft({ graph: 'G0' }), 'G1', false)).toBeNull();
  });

  it('another text from an UNCHANGED graph (the validator landing) moves the hold to it', () => {
    const d = draft({ graph: 'G0' });
    expect(draftAfterGraphWrite(d, 'G0 validated', true)).toEqual({ ...d, graph: 'G0 validated' });
  });

  it('no kept text stays none', () => {
    expect(draftAfterGraphWrite(null, 'G0', false)).toBeNull();
    expect(draftAfterGraphWrite(null, 'G0', true)).toBeNull();
  });
});

describe('the report after that write', () => {
  it('describes the kept text for as long as it is kept — blocking errors too', () => {
    const errors = [blocking, dropped, kept];
    const d = draft({ graph: 'G0' });
    expect(errorsAfterGraphWrite(errors, d, d)).toBe(errors);
    expect(errorsAfterGraphWrite(errors, null, d)).toBe(errors);
  });

  it('with no kept text: blocking errors go with the text they described, warnings stay as they are', () => {
    expect(errorsAfterGraphWrite([blocking, dropped, kept], null, null)).toEqual([dropped, kept]);
    const warnings = [dropped, kept];
    expect(errorsAfterGraphWrite(warnings, null, null)).toBe(warnings);
    const none: ParseError[] = [];
    expect(errorsAfterGraphWrite(none, null, null)).toBe(none);
  });

  it('when a hold ENDS, its dropped-code warnings go with the text they quoted', () => {
    const after = errorsAfterGraphWrite([blocking, dropped, kept], draft({ graph: 'G0' }), null);
    // Only what the regenerated text still holds stays: the unknown function.
    expect(after).toEqual([kept]);
    expect(after[0]).toBe(kept);
    expect(errorsAfterGraphWrite([dropped], draft({ graph: 'G0' }), null)).toEqual([]);
  });

  it('the same array when the ended hold leaves nothing to drop', () => {
    const errors = [kept];
    expect(errorsAfterGraphWrite(errors, draft({ graph: 'G0' }), null)).toBe(errors);
  });
});
