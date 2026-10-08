/**
 * Test harness for the PLAIN-JS module helpers (engine/lutHelperText.ts — the
 * `kind: 'js'` rows of engine/moduleHelpers.ts). Not a test file and never
 * imported by the app (like shaderloaderHarness.ts): the helper text is
 * evaluated here EXACTLY as emitted, against real three/tsl, so the drift
 * tests compare the TS twins with what actually runs in the preview.
 *
 * isolate:false contract: the suite shares one module registry and one
 * `globalThis` per worker, so `withHelpers` restores `globalThis.THREE` in
 * `finally` — and is SYNC ONLY: an async `fn` would run its awaits after the
 * restore, against whatever THREE the next file left. A thenable result throws.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { MODULE_HELPERS } from '@/engine/moduleHelpers';
import { TSL_EXPORT_NAMES } from '@/engine/tslExportNames';

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

/** Evaluate MODULE_HELPERS text for `names` (requires resolved) with REAL three/tsl, under a THREE stub whose
 *  DataTexture records every instance. Restores globalThis.THREE in `finally` (isolate:false contract). SYNC
 *  ONLY: if `fn` returns a thenable it throws (after restoring) — an async `fn` would otherwise run its awaits
 *  after the restore, against whatever THREE the next file left. */
export function withHelpers<T>(names: string[], fn: (h: Record<string, any>, made: THREE.DataTexture[]) => T): T {
  const order = helperClosure(names);
  const imports = new Set<string>(['Fn']);
  for (const n of order) for (const i of MODULE_HELPERS.get(n)!.imports) imports.add(i);
  const text = order.map((n) => MODULE_HELPERS.get(n)!.lines.join('\n')).join('\n\n');

  const made: THREE.DataTexture[] = [];
  class RecordingDataTexture extends THREE.DataTexture {
    constructor(...args: ConstructorParameters<typeof THREE.DataTexture>) {
      super(...args);
      made.push(this);
    }
  }
  const g = globalThis as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(g, 'THREE');
  const prev = g.THREE;
  g.THREE = { ...THREE, DataTexture: RecordingDataTexture };
  let result: T;
  try {
    const helpers = new Function('__tsl', `const { ${[...imports].join(', ')} } = __tsl;\n${text}\nreturn { ${order.join(', ')} };`)(TSL) as Record<string, any>;
    result = fn(helpers, made);
  } finally {
    if (had) g.THREE = prev;
    else delete g.THREE;
  }
  if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
    throw new Error('withHelpers is sync-only: the callback returned a thenable, which would run after THREE was restored');
  }
  return result;
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
