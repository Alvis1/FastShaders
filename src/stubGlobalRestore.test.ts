import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { projectDocs } from './projectDocs';

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
// stubs `Worker`, stubLocalStorage stubs `localStorage`) puts its caller under
// the same rule.
const STUBBERS = [STUB, 'installInProcess' + 'Worker(', 'stubLocal' + 'Storage('];
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
    const doc = projectDocs();
    expect(doc).not.toMatch(/\*\*\d+ files call `vi\.stubGlobal`/);
    expect(doc).toContain("every file that calls `vi.stubGlobal` (`grep -rl '" + STUB + "' src`) must restore it");
  });
});

/**
 * A cleanup hook that ASSERTS before it restores leaks on exactly the run that
 * matters: a failed `expect` ends the hook, so the stubs, fake timers or spies
 * after it ride into whichever file the worker runs next, and that file fails
 * for no reason of its own (found in settledPreview.test.ts's React block,
 * then in gltfReader.test.ts's URL.createObjectURL spy). Read from the AST,
 * statement by statement, so a needle in a string or a comment is not a call
 * and a try/finally that restores in its `finally` is one statement, not a leak.
 */
describe('a cleanup hook restores BEFORE it asserts', () => {
  const RESTORES = /vi\.unstubAllGlobals\(|vi\.useRealTimers\(|\.mockRestore\(|vi\.restoreAllMocks\(/;
  const ASSERTS = /\bexpect\(/;
  type Node = { type: string; start: number; end: number; loc: { start: { line: number } } } & Record<string, unknown>;
  const SKIP = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);
  function walk(node: unknown, visit: (n: Node) => void): void {
    if (!node || typeof (node as Node).type !== 'string') return;
    visit(node as Node);
    for (const [k, v] of Object.entries(node as Node)) {
      if (SKIP.has(k)) continue;
      if (Array.isArray(v)) for (const c of v) walk(c, visit);
      else walk(v, visit);
    }
  }
  /** `file:line` of every afterEach/afterAll whose body asserts in a statement BEFORE one that restores. */
  function assertsBeforeRestoring(file: string, text: string): string[] {
    const out: string[] = [];
    walk(parse(text, { sourceType: 'module', plugins: ['typescript'] }).program, (n) => {
      const callee = n.callee as Node | undefined;
      if (n.type !== 'CallExpression' || callee?.type !== 'Identifier') return;
      if (callee.name !== 'afterEach' && callee.name !== 'afterAll') return;
      const body = ((n.arguments as Node[])[0]?.body ?? null) as Node | null;
      if (body?.type !== 'BlockStatement') return;
      const stmts = (body.body as Node[]).map((s) => text.slice(s.start, s.end));
      const firstAssert = stmts.findIndex((s) => ASSERTS.test(s));
      if (firstAssert >= 0 && stmts.some((s, i) => i > firstAssert && RESTORES.test(s))) out.push(`${file}:${n.loc.start.line}`);
    });
    return out;
  }

  it('no test file has one', () => {
    const leaking = testFiles(SRC).flatMap((f) => assertsBeforeRestoring(f.slice(SRC.length), readFileSync(f, 'utf8')));
    expect(leaking).toEqual([]);
  });

  it('the sweep sees the shape it hunts (a vacuous sweep would pass on nothing)', () => {
    const hook = (body: string) => `afterEach(() => {\n${body}\n});\n`;
    expect(assertsBeforeRestoring('x', hook('expect(a).toBe(1);\nvi.useRealTimers();'))).toEqual(['x:1']);
    expect(assertsBeforeRestoring('x', hook('const c = spy.mock.calls.slice();\nspy.mockRestore();\nexpect(c).toEqual([]);'))).toEqual([]);
    expect(assertsBeforeRestoring('x', hook('try { expect(a).toBe(1); } finally { vi.unstubAllGlobals(); }'))).toEqual([]);
    expect(assertsBeforeRestoring('x', `const s = 'afterEach(() => { expect(1); vi.useRealTimers(); })';\n`)).toEqual([]);
  });
});
