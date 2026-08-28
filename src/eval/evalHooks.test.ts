/**
 * Source pins for the eval-telemetry chokepoints (the project's drift-test
 * culture). Two failure modes, both silent at runtime:
 *
 *  1. A hook quietly LOST in a refactor — the study then under-counts an
 *     action class with no error anywhere (LogUI's "piecemeal logging"
 *     warning: missing key events are discovered post-hoc, after the data
 *     is collected).
 *  2. Telemetry quietly SPREADING — an `evalLog` call landing outside the
 *     reviewed chokepoint set widens what a study session records without
 *     the consent text knowing.
 *
 * TypeScript catches neither; only reading the source does.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const srcRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(srcRoot, rel), 'utf8');

/** The reviewed chokepoints and the exact events each must emit. */
const HOOKS: { file: string; events: string[] }[] = [
  {
    file: 'store/useAppStore.ts',
    events: [
      "evalLog('node-add'",
      "evalLog('node-remove'",
      "evalLog('edge-disconnect'",
      "evalLog('new-graph')",
      "evalLog('undo')",
      "evalLog('redo')",
      "evalLog('gesture'",
    ],
  },
  {
    file: 'components/NodeEditor/NodeEditor.tsx',
    events: [
      "evalLog('edge-connect'",
      "evalLog('node-remove'",
      "evalLog('edge-disconnect'",
      "evalLog('asset-drop'",
    ],
  },
  {
    // 'code-apply' lives at the Apply GESTURES, deliberately NOT in
    // store.requestCodeSync — projectImport calls that on the bare-script
    // import path, which would count imports as user Applies.
    file: 'components/CodeEditor/CodeEditor.tsx',
    events: ["evalLog('code-apply')"],
  },
  {
    file: 'engine/exportShader.ts',
    events: ["evalLog('export'"],
  },
];

/** Every file allowed to mention evalLog at all. */
const ALLOWED_FILES = new Set([
  ...HOOKS.map((h) => h.file),
  // The eval module itself (definition + the questionnaire's own events).
  'eval/telemetry.ts',
  'eval/SusModal.tsx',
  'eval/evalHooks.test.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('eval telemetry hooks', () => {
  it.each(HOOKS)('$file carries its reviewed evalLog calls', ({ file, events }) => {
    const src = read(file);
    for (const ev of events) {
      expect(src, `${file} lost the hook ${ev}`).toContain(ev);
    }
  });

  it('evalLog appears ONLY in the reviewed files', () => {
    const offenders: string[] = [];
    for (const full of walk(srcRoot)) {
      const rel = full.slice(srcRoot.length).replace(/\\/g, '/');
      // The CALL form only — prose mentions in comments are fine.
      if (!readFileSync(full, 'utf8').includes('evalLog(')) continue;
      if (!ALLOWED_FILES.has(rel)) offenders.push(rel);
    }
    expect(offenders, 'telemetry spread outside the reviewed chokepoints').toEqual([]);
  });

  it('the store never imports eval code beyond the telemetry logger', () => {
    // The bridge pattern is load-bearing: telemetry.ts must not import the
    // store (the store imports telemetry), and the store must not grow eval
    // imports beyond the one logger entry point.
    const telemetry = read('eval/telemetry.ts');
    expect(telemetry).not.toContain("from '@/store/useAppStore'");
    const store = read('store/useAppStore.ts');
    const evalImports = store.match(/from '@\/eval\/[^']+'/g) ?? [];
    expect(evalImports).toEqual(["from '@/eval/telemetry'"]);
  });

  it("requestCodeSync carries NO code-apply hook (imports call it too)", () => {
    const store = read('store/useAppStore.ts');
    // lastIndexOf: the first occurrences are the interface declarations.
    const requestCodeSync = store.slice(store.lastIndexOf('requestCodeSync:'), store.lastIndexOf('setTotalCost:'));
    expect(requestCodeSync, 'code-apply must be logged at the Apply gestures, not in requestCodeSync').not.toContain('evalLog(');
  });

  it('the journal lives in sessionStorage, never localStorage', () => {
    // Consent decision, not convenience: the journal must die with the tab
    // (close-to-withdraw) and stay out of the fs:graph localStorage quota.
    const telemetry = read('eval/telemetry.ts');
    expect(telemetry).toContain('sessionStorage.setItem(EVAL_JOURNAL_KEY');
    expect(telemetry).toContain('sessionStorage.getItem(EVAL_JOURNAL_KEY');
    expect(telemetry).not.toMatch(/localStorage\s*\.\s*(get|set|remove)Item\(EVAL_JOURNAL_KEY/);
  });

  it('eval mode is armed via sessionStorage, never localStorage', () => {
    // The flag must die with the tab — a localStorage arm would leave a
    // participant's browser in eval mode for every later visit.
    const evalMode = read('eval/evalMode.ts');
    expect(evalMode).toContain("sessionStorage.getItem(EVAL_ARM_KEY)");
    expect(evalMode).not.toContain('localStorage.getItem(EVAL_ARM_KEY)');
    const redirector = readFileSync(join(srcRoot, '../public/eval/index.html'), 'utf8');
    expect(redirector).toContain("sessionStorage.setItem('fs:evalArm'");
    // The word appears in the explanatory comment; the CALLS must not.
    expect(redirector).not.toMatch(/localStorage\s*\./);
  });
});
