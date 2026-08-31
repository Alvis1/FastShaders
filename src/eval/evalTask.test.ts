import { describe, it, expect } from 'vitest';
import { DEFAULT_EVAL_TASK, parseEvalTask } from './evalTask';

describe('parseEvalTask', () => {
  it('reads the documented launch URL', () => {
    expect(parseEvalTask('?task=T7-fire&budget=200&costbar=off')).toEqual({
      id: 'T7-fire',
      briefBudget: 200,
      costBarVisible: false,
      // costbar=off hides the BAR only — per-node prices stay. /evalp is the
      // stronger arm; see its own block below.
      pointsVisible: true,
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

describe('the pointless arm (/evalp, ?points=off)', () => {
  it('removes every point figure and the cost bar with it', () => {
    // The bar IS a point figure, so "no points" must imply "no bar" — a
    // condition that hid the total but left per-node prices on screen would
    // not be an absence of cost feedback at all.
    const t = parseEvalTask('?points=off');
    expect(t.pointsVisible).toBe(false);
    expect(t.costBarVisible).toBe(false);
  });

  it('is the STRONGER arm — costbar=off alone leaves the prices visible', () => {
    const t = parseEvalTask('?costbar=off');
    expect(t.costBarVisible).toBe(false);
    expect(t.pointsVisible).toBe(true);
  });

  it('still carries the task label and brief budget', () => {
    // /evalp appends points=off to whatever the researcher launched with.
    expect(parseEvalTask('?task=T7-fire&budget=200&points=off')).toEqual({
      id: 'T7-fire',
      briefBudget: 200,
      costBarVisible: false,
      pointsVisible: false,
    });
  });

  it('keeps points visible unless explicitly switched off', () => {
    for (const q of ['', '?points=on', '?points=', '?points=offf', '?task=T1']) {
      expect(parseEvalTask(q).pointsVisible, q).toBe(true);
    }
    for (const v of ['off', 'OFF', '0', 'false']) {
      expect(parseEvalTask(`?points=${v}`).pointsVisible, v).toBe(false);
    }
  });
});

describe('the /evalp entry', () => {
  it('forces points=off while preserving other launch parameters', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const html = readFileSync(fileURLToPath(new URL('../../public/evalp/index.html', import.meta.url)), 'utf8');
    expect(html).toContain("'&points=off'");
    expect(html).toContain("'?points=off'");
    // Same session-scoped arming as /eval — the flag must die with the tab.
    expect(html).toContain("sessionStorage.setItem('fs:evalArm', '1')");
    expect(html).not.toMatch(/localStorage\s*\./);
  });
});

describe('leaving the study returns the STANDARD app', () => {
  it('clearEvalMode erases the launch CONDITION, not just the arm flag', async () => {
    // The bug this pins: declining at the consent screen cleared fs:evalArm
    // and fs:evalSession but left fs:evalTaskQuery, so "No thanks — open the
    // normal app" handed back an editor with no cost bar, no node prices and
    // no budget lines — opted out of the study, still inside its condition,
    // with no way back short of clearing site data. Same after a submit.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('./evalMode.ts', import.meta.url)), 'utf8');
    const body = src.slice(src.indexOf('export function clearEvalMode'));
    const fn = body.slice(0, body.indexOf('\n}') + 2);
    for (const key of ['EVAL_ARM_KEY', 'EVAL_SESSION_KEY', 'EVAL_TASK_KEY']) {
      expect(fn, `clearEvalMode must remove ${key}`).toContain(`removeItem(${key})`);
    }
  });

  it('a study condition cannot apply outside a study session', () => {
    // Belt and braces behind the eraser: evalTask() gates on isEvalMode(), so
    // a stale or hand-written key is inert in the standard app. Verified in a
    // browser too — declining from /evalp returns 55 cost badges and the bar.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { fileURLToPath } = require('node:url') as typeof import('node:url');
    const src = readFileSync(fileURLToPath(new URL('./evalTask.ts', import.meta.url)), 'utf8');
    expect(src).toContain('if (!isEvalMode()) return { ...DEFAULT_EVAL_TASK };');
  });
});

