import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The suite runs with `isolate: false`, so a global a test file stubs and does
 * not restore lands on whatever file the worker runs next. CLAUDE.md states the
 * contract as "every file that calls vi.stubGlobal must restore it"; this is
 * the grep that holds it. The needles are assembled so this file does not
 * match itself.
 */
const SRC = new URL('.', import.meta.url).pathname;
const STUB = 'vi.stub' + 'Global(';
// A test-utils helper that stubs on the caller's behalf (installInProcessWorker
// stubs `Worker`) puts its caller under the same rule.
const STUBBERS = [STUB, 'installInProcess' + 'Worker('];
const RESTORE = 'vi.unstub' + 'AllGlobals(';

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? testFiles(join(dir, e.name)) : e.name.endsWith('.test.ts') ? [join(dir, e.name)] : [],
  );
}

describe('vi.stubGlobal is always restored', () => {
  const stubbing = testFiles(SRC).filter((f) => {
    const text = readFileSync(f, 'utf8');
    return STUBBERS.some((s) => text.includes(s));
  });

  it('finds the stubbing files (a vacuous sweep would pass on nothing)', () => {
    expect(stubbing.length).toBeGreaterThan(0);
  });

  it('every file that stubs a global also unstubs', () => {
    const leaking = stubbing.filter((f) => !readFileSync(f, 'utf8').includes(RESTORE));
    expect(leaking).toEqual([]);
  });

  it('CLAUDE.md states the rule, not a file count that goes stale', () => {
    const doc = readFileSync(join(SRC, '../CLAUDE.md'), 'utf8');
    expect(doc).not.toMatch(/\*\*\d+ files call `vi\.stubGlobal`/);
    expect(doc).toContain("every file that calls `vi.stubGlobal` (`grep -rl '" + STUB + "' src`) must restore it");
  });
});
