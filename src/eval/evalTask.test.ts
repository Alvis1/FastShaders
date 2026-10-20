import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { DEFAULT_EVAL_TASK, introInStudy, introShowsBudget, parseEvalTask } from './evalTask';

/**
 * RUN a redirector's inline script against a launch URL and return what it
 * stored — the behaviour, not its spelling. sessionStorage and location are
 * stand-ins; URLSearchParams is Node's, which follows the same spec.
 */
function runRedirector(entry: 'eval' | 'evalp' | 'evalpro', search: string): Record<string, string> {
  const html = readFileSync(fileURLToPath(new URL(`../../public/${entry}/index.html`, import.meta.url)), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error(`no inline script in public/${entry}/index.html`);
  const store: Record<string, string> = {};
  const sessionStorage = {
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    getItem: (k: string) => store[k] ?? null,
  };
  runInNewContext(script, { sessionStorage, location: { search, replace: () => {} }, URLSearchParams });
  return store;
}

describe('parseEvalTask', () => {
  it('reads the documented launch URL', () => {
    expect(parseEvalTask('?task=T7-fire&budget=200&costbar=off')).toEqual({
      arm: null,
      id: 'T7-fire',
      briefBudget: 200,
      costBarVisible: false,
      // costbar=off hides the BAR only — per-node prices stay. /evalp is the
      // stronger arm; see its own block below.
      pointsVisible: true,
      proQuestions: false,
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
      arm: null,
      id: 'T7-fire',
      briefBudget: 200,
      costBarVisible: false,
      pointsVisible: false,
      proQuestions: false,
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
  it('forces points=off while preserving other launch parameters', () => {
    const t = parseEvalTask(runRedirector('evalp', '?task=T7-fire&budget=200')['fs:evalTaskQuery']);
    expect(t).toMatchObject({ arm: 'evalp', id: 'T7-fire', briefBudget: 200, pointsVisible: false, costBarVisible: false });
    expect(parseEvalTask(runRedirector('evalp', '')['fs:evalTaskQuery'])).toMatchObject({ arm: 'evalp', pointsVisible: false });
  });

  it('a link that already says points=on (or names another arm) cannot undo it', () => {
    // The redirector used to APPEND `&points=off`; URLSearchParams.get answers
    // the FIRST occurrence, so `/evalp?points=on` showed every price.
    const t = parseEvalTask(runRedirector('evalp', '?points=on&arm=eval')['fs:evalTaskQuery']);
    expect(t).toMatchObject({ arm: 'evalp', pointsVisible: false });
  });

  it('an over-long link keeps the forced condition rather than none', () => {
    const t = parseEvalTask(runRedirector('evalp', `?task=${'x'.repeat(3000)}`)['fs:evalTaskQuery']);
    expect(t).toMatchObject({ arm: 'evalp', pointsVisible: false, id: null });
  });

  it('arms through sessionStorage, never localStorage', () => {
    const store = runRedirector('evalp', '');
    // Same session-scoped arming as /eval — the flag must die with the tab.
    expect(store['fs:evalArm']).toBe('1');
    const html = readFileSync(fileURLToPath(new URL('../../public/evalp/index.html', import.meta.url)), 'utf8');
    expect(html).not.toMatch(/localStorage\s*\./);
  });
});

describe('the study arm', () => {
  it('each entry names itself, whatever the launch URL said', () => {
    expect(parseEvalTask(runRedirector('eval', '?arm=evalpro&task=T1')['fs:evalTaskQuery'])).toMatchObject({ arm: 'eval', id: 'T1', proQuestions: false });
    expect(parseEvalTask(runRedirector('eval', '')['fs:evalTaskQuery']).arm).toBe('eval');
    expect(parseEvalTask(runRedirector('evalpro', '?arm=evalp')['fs:evalTaskQuery'])).toMatchObject({ arm: 'evalpro', proQuestions: true });
  });

  it('only the three entry names are an arm', () => {
    for (const a of ['', 'EVAL', 'evalx', '__proto__', 'eval ']) {
      expect(parseEvalTask(`?arm=${encodeURIComponent(a)}`).arm, a).toBeNull();
    }
  });

  it('every entry shows the intro, and its budget slide only with the cost bar on', () => {
    const on = (q: string) => parseEvalTask(q);
    expect(introInStudy(on('?arm=eval'))).toBe(true);
    expect(introInStudy(on('?arm=evalpro&pro=on'))).toBe(true);
    // The same training in the no-points arm, minus the budget slide — so an
    // arm comparison does not also compare having had the intro.
    expect(introInStudy(on('?arm=evalp&points=off'))).toBe(true);
    expect(introShowsBudget(on('?arm=evalp&points=off'))).toBe(false);
    // No recorded entry (an older redirector): no intro.
    expect(introInStudy(on(''))).toBe(false);
    expect(introShowsBudget(on('?arm=eval'))).toBe(true);
    expect(introShowsBudget(on('?arm=eval&costbar=off'))).toBe(false);
    expect(introShowsBudget(on('?arm=eval&points=off'))).toBe(false);
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

describe('the professional arm (/evalpro, ?pro=on)', () => {
  it('is opt-IN — an absent parameter must never hand a student the pro block', () => {
    for (const q of ['', '?task=T1', '?points=off', '?pro=', '?pro=off', '?pro=yes']) {
      expect(parseEvalTask(q).proQuestions, q).toBe(false);
    }
    for (const v of ['on', 'ON', '1', 'true']) {
      expect(parseEvalTask(`?pro=${v}`).proQuestions, v).toBe(true);
    }
  });

  it('composes with the other conditions rather than replacing them', () => {
    const t = parseEvalTask('?task=T7-fire&budget=200&costbar=off&pro=on');
    expect(t).toEqual({
      arm: null,
      id: 'T7-fire',
      briefBudget: 200,
      costBarVisible: false,
      pointsVisible: true,
      proQuestions: true,
    });
  });
});

describe('the /evalpro entry', () => {
  it('forces pro=on while preserving other launch parameters', () => {
    const t = parseEvalTask(runRedirector('evalpro', '?task=T7-fire&costbar=off')['fs:evalTaskQuery']);
    expect(t).toMatchObject({ arm: 'evalpro', id: 'T7-fire', costBarVisible: false, proQuestions: true });
    // A link saying pro=off cannot drop the block (the FIRST occurrence wins).
    expect(parseEvalTask(runRedirector('evalpro', '?pro=off')['fs:evalTaskQuery']).proQuestions).toBe(true);
    const store = runRedirector('evalpro', '');
    expect(store['fs:evalArm']).toBe('1');
    const html = readFileSync(fileURLToPath(new URL('../../public/evalpro/index.html', import.meta.url)), 'utf8');
    expect(html).not.toMatch(/localStorage\s*\./);
  });
});

