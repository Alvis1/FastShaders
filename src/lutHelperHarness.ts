/**
 * Test harness for the PLAIN-JS module helpers (engine/lutHelperText.ts — the
 * `kind: 'js'` rows of engine/moduleHelpers.ts). Not a test file and never
 * imported by the app (like shaderloaderHarness.ts): the helper text is
 * evaluated here EXACTLY as emitted, against real three/tsl, so the drift
 * tests compare the TS twins with what actually runs in the preview.
 *
 * isolate:false contract: the suite shares one module registry and one
 * `globalThis` per worker, so EVERY swap of `globalThis.THREE` goes through
 * `withRecordingThree`, which restores it in `finally` — and is SYNC ONLY: an
 * async `fn` would run its awaits after the restore, against whatever THREE the
 * next file left. A thenable result throws. `withHelpers` and
 * `bakeEditorModule` are built on it; a suite running a module through a
 * loader's transforms calls it directly.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { MODULE_HELPERS } from '@/engine/moduleHelpers';
import { TSL_EXPORT_NAMES } from '@/engine/tslExportNames';

/** Run `fn` with `globalThis.THREE` set to real three/webgpu whose DataTexture RECORDS every instance into `made`
 *  (the same namespace object is handed to `fn`, for a loader sandbox's `THREE`). Restores the previous THREE — or
 *  its absence — in `finally`. SYNC ONLY: if `fn` returns a thenable it throws (after restoring). */
export function withRecordingThree<T>(fn: (three: typeof THREE, made: THREE.DataTexture[]) => T): T {
  const made: THREE.DataTexture[] = [];
  class RecordingDataTexture extends THREE.DataTexture {
    constructor(...args: ConstructorParameters<typeof THREE.DataTexture>) {
      super(...args);
      made.push(this);
    }
  }
  const three = { ...THREE, DataTexture: RecordingDataTexture } as typeof THREE;
  const g = globalThis as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(g, 'THREE');
  const prev = g.THREE;
  g.THREE = three;
  let result: T;
  try {
    result = fn(three, made);
  } finally {
    if (had) g.THREE = prev;
    else delete g.THREE;
  }
  if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
    throw new Error('withRecordingThree is sync-only: the callback returned a thenable, which would run after THREE was restored');
  }
  return result;
}

/** `names` plus everything they `requires`, in TABLE order (the emission order). */
export function helperClosure(names: readonly string[]): string[] {
  const want = new Set<string>();
  const add = (n: string) => {
    if (want.has(n)) return;
    const h = MODULE_HELPERS.get(n);
    if (!h) throw new Error(`no module helper named ${n}`);
    want.add(n);
    for (const r of h.requires ?? []) add(r);
  };
  names.forEach(add);
  return [...MODULE_HELPERS.keys()].filter((n) => want.has(n));
}

/** Evaluate MODULE_HELPERS text for `names` (requires resolved) with REAL three/tsl, inside `withRecordingThree`
 *  (so `made` is every DataTexture the helpers bake, and THREE is restored after — sync only). */
export function withHelpers<T>(names: string[], fn: (h: Record<string, any>, made: THREE.DataTexture[]) => T): T {
  const order = helperClosure(names);
  const imports = new Set<string>(['Fn']);
  for (const n of order) for (const i of MODULE_HELPERS.get(n)!.imports) imports.add(i);
  const text = order.map((n) => MODULE_HELPERS.get(n)!.lines.join('\n')).join('\n\n');
  return withRecordingThree((_three, made) => {
    const helpers = new Function('__tsl', `const { ${[...imports].join(', ')} } = __tsl;\n${text}\nreturn { ${order.join(', ')} };`)(TSL) as Record<string, any>;
    return fn(helpers, made);
  });
}

/** Run an EDITOR module (graphToCode's text) AND its shader body inside `withRecordingThree`; returns every
 *  DataTexture it made. The body is what calls the plain-JS helpers and bakes: `shader()` alone only makes a call
 *  node, and three runs the body at build time, which needs a renderer — so the `three/tsl` import becomes a
 *  destructure of the real namespace, the default export is captured, and `Fn().shaderNode.jsFunc` is called. */
export function bakeEditorModule(text: string): THREE.DataTexture[] {
  return withRecordingThree((_three, made) => {
    const body = text
      .replace(/^import\s*\{([^}]*)\}\s*from\s*'three\/tsl';\s*$/m, 'const {$1} = __TSL;')
      .replace(/^export default (\w+);\s*$/m, '__captured.shader = $1;');
    const captured: { shader?: { shaderNode?: { jsFunc?: () => unknown } } } = {};
    new Function('__TSL', '__captured', body)(TSL, captured);
    const jsFunc = captured.shader?.shaderNode?.jsFunc;
    if (typeof jsFunc !== 'function') throw new Error('three moved Fn().shaderNode.jsFunc — find the body another way');
    if (!jsFunc()) throw new Error('the shader body returned nothing');
    return made;
  });
}

/** Identifier tokens (loader regex, strings included) that are TSL exports and not in `allowed`. A LINT: the
 *  binding pin is lutHelperLoaders.test.ts, which runs the real loader transforms. */
export function tslTokenHits(text: string, allowed: readonly string[]): string[] {
  const ok = new Set(allowed);
  const hits = new Set<string>();
  for (const m of text.matchAll(/(?<![.\w])([A-Za-z_$]\w*)/g)) {
    if (TSL_EXPORT_NAMES.has(m[1]) && !ok.has(m[1])) hits.add(m[1]);
  }
  return [...hits].sort();
}
