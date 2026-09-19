/**
 * The ONE place the shaderloader suites get a loader from.
 *
 * The loader is a plain classic script (`a-frame-shaderloader-<v>.js`), so the
 * `node` vitest env can only run it inside `vm`. Every loader suite used to
 * build that sandbox by hand and read `public/js/a-frame-shaderloader-0.6.js`
 * at module top level — which THROWS rather than skips the day that copy stops
 * being vendored. This module owns the sandbox shape, the file choice and the
 * handful of source anchors that differ between versions, so a suite can run
 * the SAME assertions against every ACTIVE loader:
 *
 *   for (const v of ACTIVE_LOADERS) describe.skipIf(!loaderAvailable(v))(…)
 *
 * - `CURRENT_LOADER` (0.8) is read from `public/js`, the copy the app serves;
 *   vendorSync.test.ts pins it byte for byte to the submodule.
 * - Every other version is read from the SUBMODULE, where the frozen loaders
 *   live (frozenLoaders.test.ts pins them by hash). A non-recursive checkout
 *   has an empty submodule directory, so those versions report unavailable
 *   and their suites skip instead of failing.
 *
 * Not a test file: it registers no tests and is imported only by tests.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const REPO = path.resolve(__dirname, '..');

/** The loader every new export and surface is moving to. */
export const CURRENT_LOADER = '0.8';

/** The loaders every parity suite runs against. 0.6 is frozen, 0.8 is 0.6's successor. */
export const ACTIVE_LOADERS = ['0.6', '0.8'] as const;
export type ActiveLoader = (typeof ACTIVE_LOADERS)[number];

/** The submodule's copy of a loader — the single source of truth. */
export function submoduleLoaderPath(v: string): string {
  return path.join(REPO, `a-frame-shaderloader/js/a-frame-shaderloader-${v}.js`);
}

/** The file a suite reads: the served copy for the current loader, the submodule otherwise. */
export function loaderPath(v: string): string {
  return v === CURRENT_LOADER
    ? path.join(REPO, `public/js/a-frame-shaderloader-${v}.js`)
    : submoduleLoaderPath(v);
}

export function loaderAvailable(v: string): boolean {
  return existsSync(loaderPath(v));
}

export function loaderText(v: string): string {
  return readFileSync(loaderPath(v), 'utf8');
}

type Log = (...args: unknown[]) => void;

export interface EvalLoaderOptions {
  /** Bound as `THREE` and `window.THREE`. Absent = no global three (window.THREE is null). */
  THREE?: unknown;
  /** Put an `AFRAME` stub on the sandbox (default true). 0.6 throws without it. */
  aframe?: boolean;
  /**
   * `AFRAME.components` — `{ shader: {} }` for the duplicate guard, `{ 'gltf-model': stub }` for the glTF hook.
   * Default: a registry holding a FRESH inert `gltf-model` (see `inertGltfModelEntry`), because real
   * A-Frame always has one and 0.8 warns when it cannot hook it. A supplied registry replaces it whole.
   */
  aframeComponents?: Record<string, unknown>;
  /** `AFRAME.THREE`, where the bundle's loader classes live. */
  aframeThree?: unknown;
  log?: Log;
  warn?: Log;
  error?: Log;
  href?: string;
  /** Extra sandbox globals (document, fetch, self, …). */
  globals?: Record<string, unknown>;
}

/**
 * A registry entry shaped like A-Frame's `gltf-model` (`{ Component }` whose
 * prototype has an `init`), minted FRESH per call: 0.8 wraps that prototype
 * once and marks it with a `Symbol.for` flag, which is agent-wide, so a class
 * shared between sandboxes would be hooked by the first loader only.
 */
export function inertGltfModelEntry(init: (this: Record<string, unknown>) => void = function () {}): {
  Component: { new (): Record<string, unknown>; prototype: { init: () => void } };
} {
  class GltfModelStub {
    [key: string]: unknown;
  }
  (GltfModelStub.prototype as unknown as { init: () => void }).init = init;
  return { Component: GltfModelStub as unknown as { new (): Record<string, unknown>; prototype: { init: () => void } } };
}

/**
 * The sandbox shape 0.6's suites always used: a console, URL, a location, a
 * `window` carrying THREE (or null), and an AFRAME stub that captures the
 * `shader` component definition. `globalThis` is the sandbox itself.
 */
export function makeLoaderSandbox(opts: EvalLoaderOptions = {}): {
  sandbox: Record<string, unknown>;
  registered: { names: string[]; def: unknown };
} {
  const registered: { names: string[]; def: unknown } = { names: [], def: null };
  const aframe = opts.aframe ?? true;
  const AFRAME: Record<string, unknown> = {
    registerComponent(name: string, def: unknown) {
      registered.names.push(name);
      if (name === 'shader') registered.def = def;
    },
    registerShader() {},
    utils: {},
  };
  AFRAME.components = opts.aframeComponents ?? { 'gltf-model': inertGltfModelEntry() };
  if (opts.aframeThree) AFRAME.THREE = opts.aframeThree;
  const sandbox: Record<string, unknown> = {
    console: { log: opts.log ?? (() => {}), error: opts.error ?? (() => {}), warn: opts.warn ?? (() => {}) },
    URL,
    location: { href: opts.href ?? 'https://example.test/index.html' },
    window: { THREE: opts.THREE ?? null },
    ...(opts.THREE ? { THREE: opts.THREE } : {}),
    ...(aframe ? { AFRAME } : {}),
    ...opts.globals,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, registered };
}

/** Run a loader's text in an existing sandbox (a second include, a second version). */
export function runLoaderIn(v: string, sandbox: Record<string, unknown>, suffix = ''): void {
  vm.runInContext(loaderText(v) + suffix, sandbox, { filename: loaderPath(v) });
}

/** Loosely typed: suites narrow what they use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FastShadersApi = Record<string, any>;

export interface EvaluatedLoader {
  /** The `shader` component definition, if the loader registered one. */
  def: unknown;
  /** `globalThis.FastShaders` (0.8+), else null. */
  FastShaders: FastShadersApi | null;
  sandbox: Record<string, unknown>;
  /** Every name passed to AFRAME.registerComponent, in order. */
  registered: string[];
}

export function evalLoader(v: string, opts: EvalLoaderOptions = {}): EvaluatedLoader {
  const { sandbox, registered } = makeLoaderSandbox(opts);
  runLoaderIn(v, sandbox);
  return {
    def: registered.def,
    FastShaders: (sandbox.FastShaders as FastShadersApi | undefined) ?? null,
    sandbox,
    registered: registered.names,
  };
}

export interface LoaderTransforms {
  autoDetectSchema: (source: string) => Record<string, { type: string; default: unknown }>;
  autoInjectTSLImports: (source: string) => string;
  fixTSLShadowing: (source: string) => string;
  globalizeBareImports: (source: string) => string;
  resolveTSLImports: (source: string, baseUrl?: string | null) => string;
}

const TOP_LEVEL_TRANSFORM_LOADERS = new Set(['0.4', '0.5', '0.6']);

/**
 * The source transforms of one loader version. Up to 0.6 they are top-level
 * functions of the script, reached by appending one line to it; 0.8 wraps
 * the file in an IIFE and exposes the same functions as FastShaders.transforms.
 */
export function transformsOf(v: string, opts: EvalLoaderOptions = {}): LoaderTransforms {
  if (TOP_LEVEL_TRANSFORM_LOADERS.has(v)) {
    const { sandbox } = makeLoaderSandbox(opts);
    runLoaderIn(
      v,
      sandbox,
      '\n;globalThis.__t = { autoDetectSchema, autoInjectTSLImports, fixTSLShadowing, ' +
        'globalizeBareImports, resolveTSLImports };',
    );
    return sandbox.__t as LoaderTransforms;
  }
  const api = evalLoader(v, opts).FastShaders;
  if (!api) throw new Error(`shaderloader ${v} installed no FastShaders api`);
  return api.transforms as LoaderTransforms;
}

/** text between the first `start` and the first `end` after it; throws when either anchor moved. */
export function sliceBetween(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  if (i < 0) throw new Error(`anchor not found: ${start}`);
  const j = text.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`anchor not found after ${start}: ${end}`);
  return text.slice(i, j);
}

/**
 * The few source anchors that necessarily MOVED between versions (0.6 is an
 * object-literal component; 0.8's work lives in core functions over a state).
 * Every other pinned literal — buildMaterial, the parts loop, the extendSchema
 * call and its comment, `barycentric === true`, toNonIndexed, __fsBarySource,
 * the pos.count guard, the first `} catch (err) {` block's order — is spelled
 * identically in both files by construction and needs no entry here.
 */
export const PINS: Record<
  ActiveLoader,
  {
    /** [start, end] of the per-mesh dispatch function. */
    dispatch: [string, string];
    /** syncWeld drops our bary geometries before anything else. */
    syncWeldUnbary: RegExp;
    /** [scopeStart, weldCall, baryCall]: within the apply, the weld runs before the bary. */
    weldThenBary: [string, string, string];
  }
> = {
  '0.6': {
    dispatch: ['applyMaterialToMesh: function', 'disposeShaderMaterial: function'],
    syncWeldUnbary: /syncWeld: function \(\)[\s\S]{0,400}this\.unbary\(\);/,
    weldThenBary: ['applyTSLShader: async function', 'this.syncWeld();', 'this.syncBary();'],
  },
  '0.8': {
    dispatch: ['function applyMaterialToMesh(', 'function restoreOriginalMaterials('],
    syncWeldUnbary: /function syncWeld\(state, mesh\) \{[\s\S]{0,400}unbary\(state\);/,
    weldThenBary: ['function applyResult(', 'syncWeld(state, mesh);', 'syncBary(state, mesh);'],
  },
};
