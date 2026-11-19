/**
 * Source pins for how the generator is wired into the app: its gates in a
 * study session and the embed, its one entry (the toolbar's Settings list) and
 * one commit path, the key that never leaves memory, the keys the dialog holds
 * back from the canvas, and model text that is never markup. Read as text —
 * these are properties of the code's SHAPE that a unit test of each module
 * cannot see.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import lv from '@/i18n/lv.json';
import { GENERATOR_STORAGE_KEYS } from '@/utils/generatorFlag';
import { projectDocs } from '@/projectDocs';
import { PREF_KEYS, loadGeneratorPrefs } from './prefs';
import { offeredRoutes } from './registry';
import { clearCloudKey, hasCloudKey, setCloudKey, subscribeCloudKey, withCloudKey } from './cloudKey';
import * as cloudKeyModule from './cloudKey';

const read = (p: string) => readFileSync(p, 'utf8');
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const LLM = files('src/llm');
/** The one boot-path piece besides the leaf flag: it loads the dialog with import(). */
const LAUNCHER = 'src/components/Layout/GeneratorLauncher.tsx';
const DIALOG = 'src/llm/GeneratorDialog.tsx';
const TOOLBAR = 'src/components/Layout/Toolbar.tsx';

describe('absent in a study session', () => {
  it('every preference key is one the clean slate removes', () => {
    for (const key of Object.values(PREF_KEYS)) expect(GENERATOR_STORAGE_KEYS as readonly string[], key).toContain(key);
  });

  it('no route is offered in a study session, whatever the build', () => {
    for (const desktop of [false, true]) for (const cloud of [false, true]) for (const dev of [false, true]) {
      expect(offeredRoutes({ desktop, cloud, dev }, true)).toEqual([]);
    }
    expect(offeredRoutes({ desktop: false, cloud: false, dev: false }, false)).toEqual([]);
    expect(offeredRoutes({ desktop: true, cloud: false, dev: false }, false)).toEqual(['local', 'claude']);
    expect(offeredRoutes({ desktop: false, cloud: true, dev: false }, false)).toEqual(['claude']);
  });

  it('the Settings row and its Open button sit inside a guard that is false in a study, in the embed, and on a build that reaches no model', () => {
    const tb = codeOnly(read(TOOLBAR));
    expect(tb).toContain('const NODE_GENERATOR_BUILD = generatorBuild(__FS_DESKTOP__, __FS_LLM_CLOUD__);');
    expect(tb).toContain('const generatorRow = !isEvalMode() && !isEmbedMode() && NODE_GENERATOR_BUILD;');
    const at = tb.indexOf("t('Generate nodes from text', language)");
    expect(at).toBeGreaterThan(-1);
    const row = tb.slice(tb.lastIndexOf('{generatorRow && (', at), at);
    expect(row).toContain('checked={nodeGenerator}');
    expect(row).toContain('setNodeGenerator(e.target.checked)');
    const open = tb.indexOf("t('Open the generator…', language)");
    expect(open).toBeGreaterThan(at);
    expect(tb.slice(tb.lastIndexOf('{generatorRow && nodeGenerator && (', open), open)).toContain('onClick={openGenerator}');
    // Each counts toward the popover's height clamp only when it is drawn.
    expect(tb).toMatch(/const prefsRows = [^;]*\(generatorRow \? 1 : 0\)[^;]*\(generatorRow && nodeGenerator \? 1 : 0\);/);
  });

  it('the launcher checks the opt-in, the study and the embed again, and reaches the dialog only through import()', () => {
    const src = codeOnly(read(LAUNCHER));
    expect(src).toMatch(/if \(!open \|\| isEmbedMode\(\) \|\| !generatorOffered\(enabled, isEvalMode\(\), generatorBuild\(__FS_DESKTOP__, __FS_LLM_CLOUD__\)\)\) return null;/);
    expect(src).toMatch(/lazyOr<DialogProps>\(\s*\(\) => import\('@\/llm\/GeneratorDialog'\)/);
    // No static edge into src/llm/ (bootWave.test.ts walks the whole graph).
    expect(src).not.toMatch(/^import[^;]*from '@\/llm\//m);
    // The Toolbar mounts it; nothing else does.
    const mounts = files('src').filter((f) => /<GeneratorLauncher\b/.test(codeOnly(read(f))));
    expect(mounts).toEqual([TOOLBAR]);
  });

  it('the study clean slate removes every key and turns the flag off', () => {
    const gate = read('src/eval/EvalGate.tsx');
    const body = gate.slice(gate.indexOf('function cleanSlateForStudy'), gate.indexOf('\nexport function EvalGate'));
    expect(body).toMatch(/for \(const key of GENERATOR_STORAGE_KEYS\) localStorage\.removeItem\(key\);/);
    expect(body).toMatch(/nodeGenerator: false/);
  });

  it('the run and the commit refuse in a study session themselves', () => {
    expect(codeOnly(read('src/llm/orchestrate.ts'))).toMatch(/if \(o\.inStudy\(\)\) return \{ ok: false, kind: 'study' \};/);
    expect(codeOnly(read('src/llm/place.ts'))).toMatch(/if \(inStudy\(\)\) return \{ ok: false, reason: 'study' \};/);
    expect(codeOnly(read(DIALOG))).toMatch(/runGeneration\(\{[\s\S]*?inStudy: isEvalMode,/);
    // And nothing in src/llm, nor the launcher, reports to the study telemetry.
    for (const f of [...LLM, LAUNCHER]) expect(codeOnly(read(f)), f).not.toMatch(/\bevalLog\(/);
  });
});

describe('one commit path', () => {
  it('only place.ts adds to the graph, through the dropped-shader ADD', () => {
    for (const f of [...LLM, LAUNCHER]) {
      const src = codeOnly(read(f));
      expect(src, f).not.toMatch(/\bsetCode\(|\brequestCodeSync\(|\bsetNodes\(|\bpushHistory\(/);
      if (!f.endsWith('place.ts')) expect(src, f).not.toMatch(/\baddDroppedShader\(/);
    }
    expect(codeOnly(read('src/llm/place.ts'))).toMatch(/await addDroppedShader\(file\)/);
    expect(codeOnly(read(DIALOG))).toMatch(/addGeneratedGroup\(tsl, request, isEvalMode\)/);
  });
});

describe('the dialog', () => {
  const dialog = () => codeOnly(read(DIALOG));

  it('is an aria-modal dialog, so the canvas\'s own key handlers stand down behind it', () => {
    // keysBehindDialogs.test.ts: Delete/X, Cmd/Ctrl+C/V/G/D, the bare canvas
    // keys and Cmd/Ctrl+Z all return while this query matches.
    expect(dialog()).toMatch(/role="dialog"\s+aria-modal="true"/);
  });

  it('swallows every key but Tab in the capture phase', () => {
    expect(dialog()).toMatch(/useModalKeys\(true, \(e\) => \{/);
    expect(dialog()).toMatch(/if \(e\.key !== 'Tab'\) e\.stopPropagation\(\);\s*\}, true\);/);
    expect(codeOnly(read(LAUNCHER))).toMatch(/if \(e\.key !== 'Tab'\) e\.stopPropagation\(\);\s*\}, true\);/);
  });

  it('cancels a running generation, and a running check, when it closes or the page goes', () => {
    const src = dialog();
    expect(src).toMatch(/const stop = \(\) => \{ abortRef\.current\?\.abort\(\); checkRef\.current\?\.abort\(\); \};/);
    expect(src).toMatch(/window\.addEventListener\('pagehide', stop\);\s*return \(\) => \{ window\.removeEventListener\('pagehide', stop\); stop\(\); \};/);
  });

  it('prints its cost on the fixed 100 of the selected device, never a table figure', () => {
    const src = dialog();
    expect(src).toContain('const deviceBudget = useDeviceBudget();');
    expect(src).toMatch(/toBudgetPoints\(phase\.result\.cost, deviceBudget\)/);
    expect(src).toContain('<Points value={points} />');
    expect(src).toContain('max: POINT_BUDGET');
    // The retired user cap and the raw budget never reach the screen.
    expect(src).not.toMatch(/costBudgetOverrides|maxPoints/);
  });

  it('every t() string in the dialog, the launcher and the Settings rows has its Latvian', () => {
    const ui = lv.ui as Record<string, string>;
    const keys = new Set<string>();
    const literal = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;
    for (const f of [DIALOG, LAUNCHER]) for (const m of codeOnly(read(f)).matchAll(literal)) keys.add(m[1].replace(/\\'/g, "'"));
    // Keys that reach t() through a variable (failureText's, a phase's
    // message): every sentence-like literal in the dialog — capitalised, with
    // a space. Error texts for the console start lower-case and are skipped.
    for (const m of codeOnly(read(DIALOG)).matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
      if (/^[A-Z{(]/.test(m[1]) && m[1].includes(' ')) keys.add(m[1].replace(/\\'/g, "'"));
    }
    const tb = codeOnly(read(TOOLBAR));
    keys.add(/const NODE_GENERATOR_HINT =\s*'([^']*)';/.exec(tb)![1]);
    keys.add('Generate nodes from text');
    keys.add('Open the generator…');
    expect(keys.size).toBeGreaterThan(60);
    const missing = [...keys].filter((k) => !ui[k]);
    expect(missing).toEqual([]);
  });

  it('the example request stays English: requests are written in English', () => {
    const src = read(DIALOG);
    expect(src).toContain('placeholder="e.g. glowing lava cracks on dark rock"');
    expect((lv.ui as Record<string, string>)['e.g. glowing lava cracks on dark rock']).toBeUndefined();
  });
});

describe('model text is data', () => {
  it('nothing renders markup or evaluates text', () => {
    for (const f of LLM) {
      expect(codeOnly(read(f)), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\b|new Function\(|\beval\(/);
    }
  });
});

describe('the API key', () => {
  it('lives in memory: set, used, forgotten', () => {
    clearCloudKey();
    const seen: boolean[] = [];
    const off = subscribeCloudKey((h) => seen.push(h));
    expect(setCloudKey('too short')).toBe(false);
    expect(setCloudKey('sk-ant-has a space in it xxxxxxxx')).toBe(false);
    expect(setCloudKey('  sk-ant-api03-0123456789abcdefghij  ')).toBe(true);
    expect(hasCloudKey()).toBe(true);
    expect(withCloudKey((k) => k)).toBe('sk-ant-api03-0123456789abcdefghij');
    clearCloudKey();
    expect(withCloudKey((k) => k)).toBeNull();
    off();
    expect(seen).toEqual([true, false]);
  });

  it('has no getter, imports nothing, and only the Claude provider reads it', () => {
    expect(Object.keys(cloudKeyModule).sort()).toEqual(['MIN_KEY_LENGTH', 'clearCloudKey', 'hasCloudKey', 'setCloudKey', 'subscribeCloudKey', 'withCloudKey']);
    expect(read('src/llm/cloudKey.ts')).not.toMatch(/^\s*import\s/m);
    const readers = [...files('src'), ...LLM].filter((f) => /\bwithCloudKey\(/.test(codeOnly(read(f))) && !f.endsWith('cloudKey.ts'));
    expect([...new Set(readers)]).toEqual(['src/llm/providers/claude.ts']);
  });

  it('is typed into a plain text field outside any form (a password field invites the manager to SAVE it)', () => {
    const src = codeOnly(read(DIALOG));
    expect(src).not.toMatch(/type="password"|<form/);
    expect(src).toMatch(/autoComplete="off"[\s\S]{0,80}spellCheck=\{false\}/);
  });

  it('is never written to storage, and the Claude provider reaches nothing that persists', () => {
    for (const f of LLM) {
      const src = codeOnly(read(f));
      if (/localStorage\.setItem|sessionStorage/.test(src)) expect(f).toBe('src/llm/prefs.ts');
    }
    const claude = codeOnly(read('src/llm/providers/claude.ts'));
    expect(claude).not.toMatch(/from '@\/store|projectImport|fastShadersProject/);
  });

  it('preferences are validated, never coerced', () => {
    const store: Record<string, string> = {
      'fs:llmRoute': 'claude ',
      'fs:llmLocalBase': 'http://example.com:80',
      'fs:llmLocalModel': 'a model with spaces',
      'fs:llmCloudModel': 'claude-opus-5-5-20260401',
    };
    expect(loadGeneratorPrefs((k) => store[k] ?? null)).toEqual({
      route: null, localBase: 'http://127.0.0.1:1234', localModel: '', cloudModel: 'claude-opus-5-5',
    });
    expect(loadGeneratorPrefs(() => { throw new Error('blocked'); }).route).toBeNull();
    const ok = loadGeneratorPrefs((k) => ({ 'fs:llmRoute': 'local', 'fs:llmLocalBase': 'http://localhost:11434/v1', 'fs:llmLocalModel': 'qwen/qwen3-coder-next', 'fs:llmCloudModel': 'claude-haiku-4-5' } as Record<string, string>)[k] ?? null);
    expect(ok).toEqual({ route: 'local', localBase: 'http://localhost:11434', localModel: 'qwen/qwen3-coder-next', cloudModel: 'claude-haiku-4-5' });
  });
});

describe('the docs carry the feature', () => {
  it('names the opt-in key and the reasoning file', () => {
    const docs = projectDocs();
    expect(docs).toContain('fs:nodeGenerator');
    expect(docs).toContain('node-generator.md');
  });
});
