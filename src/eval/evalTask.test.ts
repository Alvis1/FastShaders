import { describe, it, expect } from 'vitest';
import { DEFAULT_EVAL_TASK, parseEvalTask } from './evalTask';

describe('parseEvalTask', () => {
  it('reads the documented launch URL', () => {
    expect(parseEvalTask('?task=T7-fire&budget=200&costbar=off')).toEqual({
      id: 'T7-fire',
      briefBudget: 200,
      costBarVisible: false,
    });
  });

  it('defaults to an unlabelled session with the cost bar VISIBLE', () => {
    // The cost bar is the app's normal state; only an explicit off removes it,
    // so a mistyped parameter cannot silently move a participant into the
    // other experimental condition.
    expect(parseEvalTask('')).toEqual(DEFAULT_EVAL_TASK);
    expect(parseEvalTask('?costbar=offf').costBarVisible).toBe(true);
    expect(parseEvalTask('?costbar=on').costBarVisible).toBe(true);
    expect(parseEvalTask('?task=T1').costBarVisible).toBe(true);
  });

  it('accepts the other explicit off spellings', () => {
    for (const v of ['off', 'OFF', '0', 'false']) {
      expect(parseEvalTask(`?costbar=${v}`).costBarVisible, v).toBe(false);
    }
  });

  it('keeps the brief budget separate from any device budget', () => {
    // The number in a task brief and the headset's maxPoints are different
    // claims; the package carries both so neither is ambiguous.
    expect(parseEvalTask('?budget=200').briefBudget).toBe(200);
    expect(parseEvalTask('?budget=0').briefBudget).toBeNull();
    expect(parseEvalTask('?budget=-5').briefBudget).toBeNull();
    expect(parseEvalTask('?budget=abc').briefBudget).toBeNull();
    expect(parseEvalTask('?budget=1e9').briefBudget).toBeNull();
    expect(parseEvalTask('?budget=200.7').briefBudget).toBe(201);
  });

  it('refuses task ids that would break a CSV, a filename or JSON', () => {
    expect(parseEvalTask('?task=' + encodeURIComponent('a,b')).id).toBeNull();
    expect(parseEvalTask('?task=' + encodeURIComponent('a b')).id).toBeNull();
    expect(parseEvalTask('?task=' + encodeURIComponent('../etc')).id).toBeNull();
    expect(parseEvalTask('?task=' + 'x'.repeat(65)).id).toBeNull();
    expect(parseEvalTask('?task=T7-fire_v2.1').id).toBe('T7-fire_v2.1');
  });

  it('survives junk without failing the session', () => {
    expect(() => parseEvalTask('%%%')).not.toThrow();
    expect(parseEvalTask('%%%').costBarVisible).toBe(true);
  });
});
