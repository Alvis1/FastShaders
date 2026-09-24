import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { HISTORY_IDLE } from '@/test-utils';
import { projectDocs } from './projectDocs';

/**
 * The suite runs with `isolate: false`, so the zustand store is SHARED by every
 * file a worker runs. `pushHistory` silently does nothing while `isUndoRedo`
 * or `coalescingHistory` is up; a file that undoes (tests have no sync engine
 * to clear the flag) or leaves a bracket open therefore breaks the next file's
 * "one undo entry" assertion — at random, depending on file order. Measured
 * 2026-09-24 in glbImportCommit.test.ts.
 *
 * The contract: a suite that touches the undo history spreads `HISTORY_IDLE`
 * (src/test-utils.ts) into its reset. This is the grep that holds it — a TEXT
 * check, so it catches the forgotten reset, not every creative way around it.
 * The needles are assembled so this file does not match itself.
 */
const SRC = new URL('.', import.meta.url).pathname;
const HISTORY_READ = new RegExp('\\.' + 'past\\b|\\b' + 'past: \\[\\]');
const IDLE = '...' + 'HISTORY_IDLE';

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? testFiles(join(dir, e.name)) : e.name.endsWith('.test.ts') ? [join(dir, e.name)] : [],
  );
}

describe('every suite that touches the undo history resets its flags', () => {
  const touching = testFiles(SRC).filter((f) => HISTORY_READ.test(readFileSync(f, 'utf8')));

  it('finds the history suites (a vacuous sweep would pass on nothing)', () => {
    expect(touching.length).toBeGreaterThan(10);
  });

  it('each one spreads HISTORY_IDLE', () => {
    const missing = touching
      .filter((f) => !readFileSync(f, 'utf8').includes(IDLE))
      .map((f) => f.slice(SRC.length));
    expect(missing).toEqual([]);
  });

  it('the docs state the rule', () => {
    expect(projectDocs()).toContain('HISTORY_IDLE');
  });
});

describe('HISTORY_IDLE is what pushHistory needs', () => {
  beforeEach(() => {
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });

  it.each([
    ['isUndoRedo', { isUndoRedo: true }],
    ['coalescingHistory', { coalescingHistory: true, interactionDepth: 1 }],
  ] as const)('a leaked %s silences pushHistory, and HISTORY_IDLE restores it', (_name, leaked) => {
    useAppStore.setState(leaked);
    useAppStore.getState().pushHistory();
    expect(useAppStore.getState().past).toHaveLength(0);

    useAppStore.setState(HISTORY_IDLE);
    useAppStore.getState().pushHistory();
    expect(useAppStore.getState().past).toHaveLength(1);
  });
});
