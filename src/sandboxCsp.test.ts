/**
 * The documents that run shader code carry their OWN Content-Security-Policy
 * (2026-11-19, ported from the 2026-10-08 llm-generator work and re-checked
 * against this tree's preview).
 *
 * Until then the preview's srcdoc and podest's stage only INHERITED a parent
 * policy, and that exists on web builds alone — in dev, the desktop app and
 * podest, shader code could fetch, open a WebSocket to or beacon any host, a
 * local LLM server included. Now:
 *
 *  - the editor's sandboxed preview and podest's stage document emit the SAME
 *    meta, byte for byte, right after `<meta charset>` (nothing before it can
 *    fetch). podest.html is a hand-maintained static page no sync plugin
 *    covers, so its builders are RUN here (podestSplat.test.ts's harness) and
 *    the line compared with the editor's;
 *  - both XR popups (the editor's and podest's) emit the XR twin;
 *  - the policy text itself is pinned, so widening it is a reviewed diff: scheme
 *    sources and keywords only, never an origin, and no script-src/default-src
 *    (a custom-scheme origin in a meta policy is what WebKit handles badly, and
 *    'self' in the frame is its opaque origin — see SANDBOX_CSP's comment);
 *  - the NETWORK-READ INVENTORY the policy depends on: a sandboxed document
 *    names the app's own URLs ONLY in classic `<script src>` tags (script-src,
 *    left unset). Models, decoders and images arrive as posted bytes. A
 *    built-in model or a decoder spelled into the sandboxed document by URL
 *    would be refused by `connect-src blob: data:` and blank the preview — the
 *    risk this port had to settle;
 *  - the embedders' half: the preview iframe is `sandbox="allow-scripts"` (no
 *    allow-same-origin) and carries the policy as its `csp` attribute; podest's
 *    stage iframe is `sandbox="allow-scripts"` and podest's page refuses frame
 *    navigations (`frame-src 'none'`), which a meta in the stage cannot.
 *
 * Nothing here touches a global (the suite runs with `isolate: false`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SANDBOX_CSP, XR_CSP, cspMetaTag, getBunnyModelUrl, decoderAssetUrl, tslToPreviewHTML, type PreviewOptions } from '@/engine/tslToPreviewHTML';
import { DECODER_FILES } from '@/utils/meshDecoders';

const TSL = "import { color } from 'three/tsl';\nexport default function () { return color(0xff0000); }\n";
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const podest = read('../public/podest.html');
const preview = read('./components/Preview/ShaderPreview.tsx');

describe('the policies themselves', () => {
  it('the sandbox policy is exactly this — a widening must edit this line', () => {
    expect(SANDBOX_CSP).toBe(
      "connect-src blob: data:; img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('the XR policy is exactly this', () => {
    expect(XR_CSP).toBe("connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'");
  });

  it.each([['sandbox', SANDBOX_CSP], ['xr', XR_CSP]])('%s: scheme sources and keywords only — no origin, no script-src/default-src', (_name, policy) => {
    expect(policy).not.toMatch(/https?:|tauri:|\*|localhost/);
    expect(policy).not.toMatch(/(^|;\s*)(script-src|default-src|script-src-elem|require-trusted-types-for)\b/);
    // Every directive appears once.
    const names = policy.split(';').map((d) => d.trim().split(/\s+/)[0]);
    expect(new Set(names).size).toBe(names.length);
    // Nothing that would need HTML escaping inside the double-quoted attribute.
    expect(policy).not.toMatch(/["<>&]/);
  });

  it('the meta has one spelling', () => {
    expect(cspMetaTag('x')).toBe('<meta http-equiv="Content-Security-Policy" content="x">');
  });
});

/** The editor's document head: the line right after `<meta charset>` is the policy, before any script. */
function expectPolicyFirst(html: string, policy: string): void {
  const lines = html.split('\n');
  const charset = lines.findIndex((l) => l.trim() === '<meta charset="UTF-8">');
  expect(charset, 'no charset line').toBeGreaterThan(-1);
  expect(lines[charset + 1].trim()).toBe(cspMetaTag(policy));
  expect(html.split('Content-Security-Policy').length - 1).toBe(1);
  expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
}

/**
 * Every place the document names an app-served file: the build base (what
 * resolveAssetUrl prefixes — `/` under vitest) followed by one of the folders
 * the app serves files from. In a SANDBOXED document each must be a classic
 * `<script src>` — the one load the policy leaves alone.
 */
const SCRIPT_SRC = '<script src="';
function appUrlSites(html: string, base: string): { tag: string; context: string }[] {
  const escaped = base.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp(escaped + '(?:js|models|images)/', 'g');
  return [...html.matchAll(re)].map((m) => ({
    tag: html.slice(Math.max(0, m.index - SCRIPT_SRC.length), m.index),
    context: html.slice(Math.max(0, m.index - 40), m.index + 60),
  }));
}

const BASE = import.meta.env.BASE_URL;

describe('the editor preview documents', () => {
  const sandboxed: [string, PreviewOptions][] = [
    ['sphere', { geometry: 'sphere' }],
    ['cube', { geometry: 'cube' }],
    ['plane', { geometry: 'plane' }],
    ['teapot', { geometry: 'teapot' }],
    ['bunny', { geometry: 'bunny' }],
    ['march window', { geometry: 'marchSphere', marchWindow: 2 }],
    ['the checker room', { geometry: 'sphere', stage: 'room' }],
    ['the grid', { geometry: 'teapot', stage: 'grid' }],
    ['dropped glb', { geometry: 'custom', customModel: { kind: 'glb', id: 1 } }],
    ['dropped obj', { geometry: 'custom', customModel: { kind: 'obj', id: 2 } }],
    ['dropped splat', { geometry: 'custom', customModel: { kind: 'splat', id: 3 } }],
    ['dropped spz', { geometry: 'custom', customModel: { kind: 'spz', id: 4 } }],
  ];

  it.each(sandboxed)('%s: SANDBOX_CSP right after the charset', (_name, opts) => {
    expectPolicyFirst(tslToPreviewHTML(TSL, opts), SANDBOX_CSP);
  });

  // The ONE other place a URL appears: the bunny document's geometry DEDUP key
  // (`__lastGeometryKey`, a string compared, never loaded). Its `isObj` branch
  // would set obj-model by URL — refused by the policy — and stays dead only
  // because the parent never hot-swaps a model (pinned below).
  const withoutDedupKey = (html: string): string => {
    const out = html.replace(/^ *var __lastGeometryKey = .*;$/m, '');
    expect(out.length, 'the dedup key line moved — re-read this test').toBeLessThan(html.length);
    return out;
  };

  it.each(sandboxed)('%s: the app is named only by <script src> — models and decoders arrive as posted bytes', (_name, opts) => {
    const html = withoutDedupKey(tslToPreviewHTML(TSL, opts));
    const sites = appUrlSites(html, BASE);
    expect(sites.length, 'the bundles load by URL').toBeGreaterThanOrEqual(3);
    for (const s of sites) expect(s.tag, s.context).toBe(SCRIPT_SRC);
    expect(html).not.toContain(getBunnyModelUrl());
    for (const f of Object.values(DECODER_FILES)) expect(html).not.toContain(decoderAssetUrl(f));
  });

  it('the parent never hot-swaps a model by URL into the sandboxed document (fs:geometry is primitives only)', () => {
    const posts = [...preview.matchAll(/type: 'fs:geometry',\s*\n\s*isObj: (\w+)/g)].map((m) => m[1]);
    expect(posts.length).toBeGreaterThan(0);
    expect(new Set(posts)).toEqual(new Set(['false']));
    expect(preview).not.toMatch(/objModel:/);
  });

  const xr: [string, PreviewOptions][] = [
    ['sphere', { geometry: 'sphere', xr: true, title: 'A <b>name</b>' }],
    ['bunny', { geometry: 'bunny', xr: true }],
    ['dropped glb', { geometry: 'custom', xr: true, customModel: { kind: 'glb', id: 4, url: 'blob:https://app.test/x' } }],
    ['dropped splat', { geometry: 'custom', xr: true, customModel: { kind: 'splat', id: 5, url: 'blob:https://app.test/y' } }],
  ];
  it.each(xr)('VR popup, %s: XR_CSP right after the charset, never the sandbox policy', (_name, opts) => {
    const html = tslToPreviewHTML(TSL, opts);
    expectPolicyFirst(html, XR_CSP);
    expect(html).not.toContain(SANDBOX_CSP);
  });

  it("the VR popup's same-origin reads are what `'self'` admits: the bunny and the decoders by URL", () => {
    // The scene markup rides JSON-encoded inside a script, so the attribute's quotes are escaped there.
    expect(withoutDedupKey(tslToPreviewHTML(TSL, { geometry: 'bunny', xr: true }))).toContain(`obj-model=\\"obj: url(${getBunnyModelUrl()})\\"`);
    const glb = tslToPreviewHTML(TSL, { geometry: 'custom', xr: true, customModel: { kind: 'glb', id: 6, url: 'blob:https://app.test/z' } });
    for (const f of Object.values(DECODER_FILES)) expect(glb).toContain(decoderAssetUrl(f));
  });
});

/* ── podest's twins, built by podest's own builders ───────────────────────── */

/** A top-level function of the page, up to its closing `  }` line. */
function topLevelFunction(name: string): string {
  const start = podest.indexOf(`\n  function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = podest.indexOf('\n  }\n', start);
  expect(end).toBeGreaterThan(start);
  return podest.slice(start, end + 4);
}

const PODEST_DIR = 'https://podest.test/FastShaders/';

/** Run one of podest's document builders against a stubbed page scope (podestSplat.test.ts's harness). */
function build(fn: 'buildStageDoc' | 'buildXrDoc', state: Record<string, unknown>): string {
  const RealURL = URL;
  // A function, not an arrow: podest calls it with `new`.
  const UrlStub = Object.assign(function (a: string, b?: string) { return new RealURL(a, b); }, {
    createObjectURL: () => 'blob:https://podest.test/model',
    revokeObjectURL() {},
  });
  const scope: Record<string, unknown> = {
    state: { bgColor: '#303540', spinning: false, spinSpeed: 1, values: {}, ...state },
    window: { location: { href: `${PODEST_DIR}podest.html`, origin: 'https://podest.test' } },
    URL: UrlStub,
    Blob: class {},
    isHex6: (s: unknown) => /^#[0-9a-fA-F]{6}$/.test(String(s)),
    esc: (s: unknown) => String(s),
    DEFAULT_BG: '#303540',
    spinDur: () => 12000,
    pushFitBounds: (L: string[]) => L.push('<!--fit-bounds-->'),
    pushGltfAnim: (L: string[]) => L.push('<!--gltf-anim-->'),
    pushVrNav: (L: string[]) => L.push('<!--vr-nav-->'),
    STUDIO_LIGHTS: ['<a-light></a-light>'],
    jsonForScript: (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c'),
    DECODER_FILES: ['draco_wasm_wrapper.js'],
    DECODER_MAX_BYTES: 1048576,
    STAGE_BEAT_MS: 5000,
    ROTATIONS: { sphere: '45 45 0', model: '0 0 0' },
    primAttr: () => 'primitive: sphere',
    isObjKey: () => false,
    NAV_RADIUS: 30,
    NAV_INNER: 1.2,
    NAV_HOME: 2.5,
    vrModelUrl: null,
    isSplatExt: (k: unknown) => /^(splat|spz|ply|ksplat)$/.test(String(k)),
    stageSplat: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function('scope', `with (scope) { return (function () {${topLevelFunction(fn)}\nreturn ${fn};})(); }`);
  return (make(scope) as () => string)();
}

const STATES: [string, Record<string, unknown>][] = [
  ['no model', { geometry: 'sphere', modelKind: null, modelBytes: null }],
  ['a glb', { geometry: 'model', modelKind: 'gltf', modelBytes: new ArrayBuffer(32), modelName: 'robot.glb' }],
  ['a splat', { geometry: 'model', modelKind: 'splat', modelBytes: new ArrayBuffer(32), modelName: 'garden.splat' }],
];

/** podest's builders start with ONE `<!DOCTYPE …><meta charset>` line; the policy is the next one. */
function podestPolicyLine(html: string): string {
  const lines = html.split('\n');
  expect(lines[0]).toBe('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />');
  expect(html.split('Content-Security-Policy').length - 1).toBe(1);
  return lines[1];
}

describe("podest's documents are byte-equal twins of the editor's", () => {
  it.each(STATES)('the stage document, %s: the editor’s sandbox meta, byte for byte', (_name, state) => {
    expect(podestPolicyLine(build('buildStageDoc', state))).toBe(cspMetaTag(SANDBOX_CSP));
  });

  it.each(STATES)('the stage document, %s: the page is named only by <script src>', (_name, state) => {
    const sites = appUrlSites(build('buildStageDoc', state), PODEST_DIR);
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const s of sites) expect(s.tag, s.context).toBe(SCRIPT_SRC);
  });

  it.each(STATES)('the VR popup, %s: the editor’s XR meta, byte for byte', (_name, state) => {
    const html = build('buildXrDoc', state);
    expect(podestPolicyLine(html)).toBe(cspMetaTag(XR_CSP));
    expect(html).not.toContain(SANDBOX_CSP);
  });
});

describe('the embedders', () => {
  it("podest's page refuses frame navigations, before the stage iframe exists", () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'">`;
    const head = podest.slice(0, podest.indexOf('</head>'));
    expect(head).toContain(meta);
    // Right after the charset (comments between are fine), and the page's only policy.
    expect(head.indexOf(meta)).toBeGreaterThan(head.indexOf('<meta charset="UTF-8" />'));
    expect(head.indexOf(meta)).toBeLessThan(head.indexOf('<meta name="viewport"'));
    const pageLevel = podest.split('\n').filter((l) => /^<meta http-equiv="Content-Security-Policy"/.test(l));
    expect(pageLevel).toEqual([meta]);
    expect(podest.indexOf(meta)).toBeLessThan(podest.indexOf('<iframe id="stage"'));
  });

  it("podest's stage iframe is sandboxed to scripts only, and loads by srcdoc (which frame-src does not govern)", () => {
    expect(podest).toMatch(/<iframe id="stage" sandbox="allow-scripts" /);
    expect(podest).toContain('stage.setAttribute("srcdoc", buildStageDoc());');
    expect(podest).not.toMatch(/stage\.(src|setAttribute\("src")\b/);
  });

  it('the preview iframe is sandboxed to scripts only and carries the policy as its csp attribute', () => {
    const at = preview.indexOf('<iframe');
    expect(at).toBeGreaterThan(-1);
    expect(preview.indexOf('<iframe', at + 1), 'a second iframe in ShaderPreview — pin it too').toBe(-1);
    const el = preview.slice(at, preview.indexOf('/>', at));
    expect(el.match(/\bsandbox="[^"]*"/g)).toEqual(['sandbox="allow-scripts"']);
    expect(el).toContain('{...{ csp: SANDBOX_CSP }}');
    // No sandbox attribute anywhere in the app grants same-origin.
    expect(preview).not.toMatch(/sandbox="[^"]*allow-same-origin/);
    expect(podest).not.toMatch(/sandbox="[^"]*allow-same-origin/);
    expect(read('./intro/IntroPreview.tsx')).not.toMatch(/sandbox="[^"]*allow-same-origin/);
  });
});
