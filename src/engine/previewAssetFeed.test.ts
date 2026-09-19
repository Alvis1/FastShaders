/**
 * The sandboxed preview's image-asset FEED (GLB Phase 6, S3): payloads cross
 * into the document once per key, the document resolves the placeholders at
 * the mint, and the module text the parent compares stays placeholder-only.
 *
 * The planner is pure and tested directly. The resolver is a `<script>` string
 * the vitest `node` env cannot run in a browser, so — the previewHotSwap.test.ts
 * technique — it is EXECUTED here against the real `Blob`, `URL.createObjectURL`
 * and `atob` (node 22 has all three; nothing is stubbed on the global, every
 * object is passed in as a parameter). The source pins hold the three surfaces
 * to the contract: the document bakes and resolves, the hot swap resolves at
 * its mint, ShaderPreview posts the feed before the swap and re-seeds it on a
 * fresh document, and the XR popup still inlines.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, makeEdge } from '../test-utils';
import { graphToCode } from './graphToCode';
import { IMAGE_ASSET_PREFIX, IMAGE_PLACEHOLDER_RE, collectImageAssets } from './imageAssets';
import {
  PREVIEW_ASSETS_MESSAGE,
  PREVIEW_ASSET_RESOLVER_SCRIPT,
  planPreviewAssetFeed,
} from './previewAssetFeed';
import { SHADER_SWAP_MESSAGE, tslToPreviewHTML } from './tslToPreviewHTML';

const PNG = `data:image/png;base64,${btoa('png!')}`;
const WEBP = `data:image/webp;base64,${btoa('webp')}`;
const TSL = "import { vec3 } from 'three/tsl';\nconst shader = Fn(() => { return vec3(1); });\nexport default shader;\n";

describe('planPreviewAssetFeed', () => {
  const assets = new Map([
    ['a-1', 'A'],
    ['b-2', 'B'],
    ['c-3', 'C'],
  ]);

  it('lists only the keys the code references, in first-occurrence order, each once', () => {
    const code = 'x "fs-asset:b-2" y "fs-asset:a-1" z "fs-asset:b-2"';
    const r = planPreviewAssetFeed(new Set(), assets, code);
    expect(r.entries).toEqual([
      { key: 'b-2', src: 'B' },
      { key: 'a-1', src: 'A' },
    ]);
    expect([...r.sent]).toEqual(['b-2', 'a-1']);
  });

  it('skips keys already sent to this document, and grows the sent set without mutating the input', () => {
    const sent = new Set(['a-1']);
    const r = planPreviewAssetFeed(sent, assets, '"fs-asset:a-1" "fs-asset:c-3"');
    expect(r.entries).toEqual([{ key: 'c-3', src: 'C' }]);
    expect([...r.sent].sort()).toEqual(['a-1', 'c-3']);
    expect([...sent]).toEqual(['a-1']);
  });

  it('skips a key that is not in the asset map (the document then keeps the placeholder and the 1x1 fallback)', () => {
    const r = planPreviewAssetFeed(new Set(), assets, '"fs-asset:zz-9" "fs-asset:a-1"');
    expect(r.entries).toEqual([{ key: 'a-1', src: 'A' }]);
    expect(r.sent.has('zz-9')).toBe(false);
  });

  it('an empty code yields no entries and the same sent set', () => {
    const r = planPreviewAssetFeed(new Set(['a-1']), assets, '');
    expect(r.entries).toEqual([]);
    expect([...r.sent]).toEqual(['a-1']);
  });

  it('never leaves the shared /g regex mid-scan', () => {
    planPreviewAssetFeed(new Set(), assets, '"fs-asset:a-1" "fs-asset:b-2"');
    expect(IMAGE_PLACEHOLDER_RE.lastIndex).toBe(0);
  });

  it('over real generated code: exactly the placeholders the module references', () => {
    const img = makeNode('img1', 'imageNode', { imageB64: WEBP, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' });
    const nodes = [img, makeNode('out1', 'output')];
    const { code } = graphToCode(nodes, [makeEdge('img1', 'out', 'out1', 'color')]);
    expect(code).toContain(IMAGE_ASSET_PREFIX);
    const r = planPreviewAssetFeed(new Set(), collectImageAssets(nodes), code);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].key).toMatch(/^img1-[0-9a-f]{8}$/);
    expect(r.entries[0].src).toBe(WEBP);
    expect(code).toContain(`"fs-asset:${r.entries[0].key}"`);
  });
});

/* ── the resolver, executed ─────────────────────────────────────────────── */

interface Listener { (ev: unknown): void }

const minted: string[] = [];
afterEach(() => {
  for (const u of minted.splice(0)) URL.revokeObjectURL(u);
});

/** Run the shipped resolver against the real Blob/URL/atob, with a parent window. */
function runResolver(boot?: unknown) {
  const body = PREVIEW_ASSET_RESOLVER_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const listeners: Listener[] = [];
  const parent = {};
  const win: Record<string, unknown> = {
    parent,
    __fsBootAssets: boot,
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'message') listeners.push(fn);
    },
  };
  const types: string[] = [];
  const URLStub = {
    createObjectURL: (b: Blob) => {
      types.push(b.type);
      const u = URL.createObjectURL(b);
      minted.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => URL.revokeObjectURL(u),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'URL', 'Blob', 'atob', body)(win, URLStub, Blob, atob);
  const resolveCode = win.__fsResolveAssets as (c: unknown) => unknown;
  return {
    win,
    types,
    resolve: resolveCode,
    send(data: unknown, source: unknown = parent) {
      for (const fn of listeners) fn({ source, data });
    },
    mints: () => types.length,
  };
}

describe('PREVIEW_ASSET_RESOLVER_SCRIPT, executed', () => {
  it('maps a referenced key to a blob: URL of the right MIME, and drops the boot list once seeded', () => {
    const h = runResolver([{ key: 'img1-abcd1234', src: PNG }]);
    const out = h.resolve('a("fs-asset:img1-abcd1234") b') as string;
    expect(out).toMatch(/^a\("blob:[^"]+"\) b$/);
    expect(out).not.toContain(IMAGE_ASSET_PREFIX);
    expect(h.types).toEqual(['image/png']);
    expect(h.win.__fsBootAssets).toBeNull();
  });

  it('adding the same key twice mints ONE URL, and the resolved text is stable', () => {
    const h = runResolver();
    h.send({ type: PREVIEW_ASSETS_MESSAGE, entries: [{ key: 'k-1', src: WEBP }] });
    const first = h.resolve('"fs-asset:k-1"');
    h.send({ type: PREVIEW_ASSETS_MESSAGE, entries: [{ key: 'k-1', src: PNG }] });
    expect(h.mints()).toBe(1);
    expect(h.resolve('"fs-asset:k-1"')).toBe(first);
    expect(h.types).toEqual(['image/webp']);
  });

  it('an unknown key stays verbatim; a non-string code comes back as it went', () => {
    const h = runResolver([{ key: 'k-1', src: PNG }]);
    expect(h.resolve('"fs-asset:nope" "fs-asset:k-1"')).toMatch(/^"fs-asset:nope" "blob:[^"]+"$/);
    expect(h.resolve(42)).toBe(42);
    expect(h.resolve(null)).toBeNull();
  });

  it('refuses anything but a data:image/(png|jpeg|webp);base64 payload of base64 characters', () => {
    const bad = [
      `data:text/html;base64,${btoa('<svg>')}`,
      `data:image/svg+xml;base64,${btoa('<svg/>')}`,
      `data:image/png;base64,${btoa('png!')} `,
      'data:image/png;base64,AB CD',
      'https://example.com/x.png',
      'blob:https://example.com/x',
      '',
    ];
    const h = runResolver(bad.map((src, i) => ({ key: `k-${i}`, src })));
    h.send({ type: PREVIEW_ASSETS_MESSAGE, entries: [{ key: 'k-9' }, { key: 5, src: PNG }, null, 'x'] });
    expect(h.mints()).toBe(0);
    for (let i = 0; i < bad.length; i++) expect(h.resolve(`"fs-asset:k-${i}"`)).toBe(`"fs-asset:k-${i}"`);
  });

  it('ignores a message whose source is not window.parent, and a malformed one', () => {
    const h = runResolver();
    h.send({ type: PREVIEW_ASSETS_MESSAGE, entries: [{ key: 'k-1', src: PNG }] }, { other: true });
    h.send({ type: 'fs:shader', entries: [{ key: 'k-1', src: PNG }] });
    h.send({ type: PREVIEW_ASSETS_MESSAGE, entries: 'nope' });
    h.send(null);
    expect(h.mints()).toBe(0);
    expect(h.resolve('"fs-asset:k-1"')).toBe('"fs-asset:k-1"');
    h.send({ type: PREVIEW_ASSETS_MESSAGE, entries: [{ key: 'k-1', src: PNG }] });
    expect(h.mints()).toBe(1);
  });

  it('a key spelling an Object.prototype name is an ordinary key (null-prototype map)', () => {
    const h = runResolver();
    expect(h.resolve('"fs-asset:constructor" "fs-asset:__proto__"')).toBe('"fs-asset:constructor" "fs-asset:__proto__"');
    h.send({ type: PREVIEW_ASSETS_MESSAGE, entries: [{ key: 'constructor', src: PNG }] });
    expect(h.resolve('"fs-asset:constructor"')).toMatch(/^"blob:/);
  });

  it('resolves a real generated module end to end: no placeholder left', () => {
    const img = makeNode('img1', 'imageNode', { imageB64: PNG, width: 2, height: 2, fileName: 'x.png', colorSpace: 'color' });
    const nodes = [img, makeNode('out1', 'output')];
    const { code } = graphToCode(nodes, [makeEdge('img1', 'out', 'out1', 'color')]);
    const feed = planPreviewAssetFeed(new Set(), collectImageAssets(nodes), code);
    const h = runResolver(feed.entries);
    const resolved = h.resolve(code) as string;
    expect(resolved).not.toContain(IMAGE_ASSET_PREFIX);
    expect(resolved).toMatch(/_image1_img\.src = "blob:[^"]+";/);
  });
});

/* ── the three surfaces, source-pinned ─────────────────────────────────── */

describe('the sandboxed document', () => {
  it('carries the resolver, and the boot list only when assets are given — in that order, before the module blob', () => {
    const bare = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    expect(bare).toContain('window.__fsResolveAssets = function');
    expect(bare).not.toContain('window.__fsBootAssets = [');

    const withAssets = tslToPreviewHTML(TSL, { geometry: 'sphere', imageAssets: [{ key: 'k-1', src: PNG }] });
    const boot = withAssets.indexOf('window.__fsBootAssets = [{"key":"k-1","src":"');
    const resolver = withAssets.indexOf('window.__fsResolveAssets = function');
    const blob = withAssets.indexOf('var __shaderCode = ');
    expect(boot).toBeGreaterThan(-1);
    expect(resolver).toBeGreaterThan(boot);
    expect(blob).toBeGreaterThan(resolver);
  });

  it('mints the boot blob through the resolver and keeps __shaderCode as the unresolved seed', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', shaderModule: 'x "fs-asset:k-1" y' });
    expect(html).toContain('var __shaderCode = "x \\"fs-asset:k-1\\" y";');
    expect(html).toContain(
      'var __shaderBlob = new Blob([window.__fsResolveAssets ? window.__fsResolveAssets(__shaderCode) : __shaderCode], { type: "text/javascript" });',
    );
    // The hot-swap receiver resolves at ITS mint too, and compares the placeholder text.
    const swap = html.slice(html.indexOf(`msg.type !== "${SHADER_SWAP_MESSAGE}"`) - 4000);
    expect(swap).toContain('new Blob([window.__fsResolveAssets ? window.__fsResolveAssets(code) : code], { type: "text/javascript" })');
    expect(html).toContain('var applied = window.__shaderCode;');
  });

  it('escapes < in the boot list, so a file-supplied key or payload cannot close the script', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', imageAssets: [{ key: 'a</script><b>', src: 'x' }] });
    expect(html).not.toContain('a</script><b>');
    expect(html).toContain('a\\u003C/script>\\u003Cb>');
  });

  it('the xr document has neither: it runs the inlined text as a top-level page', () => {
    const html = tslToPreviewHTML(TSL, { xr: true, imageAssets: [{ key: 'k-1', src: PNG }] });
    expect(html).not.toContain('__fsResolveAssets');
    expect(html).not.toContain('__fsBootAssets');
    expect(html).toContain('var __shaderBlob = new Blob([__shaderCode], { type: "text/javascript" });');
  });
});

describe('ShaderPreview', () => {
  const SRC = readFileSync(resolve(__dirname, '../components/Preview/ShaderPreview.tsx'), 'utf8');

  it('no longer inlines payloads into the module: the module is built from the placeholder code', () => {
    expect(SRC).not.toContain('inlinedPreviewCode');
    const at = SRC.indexOf('const previewModule = useMemo(');
    const decl = SRC.slice(at, SRC.indexOf('\n  );', at));
    expect(decl).toContain('buildPreviewShaderModule(\n      debouncedPreviewCode,');
    expect(decl).toContain('materialPartsMirrorPlanAcross(contributingOutputs(');
  });

  it('bakes the boot list into the document and seeds the sent set from it', () => {
    expect(SRC).toContain(
      'const boot = planPreviewAssetFeed(new Set(), collectImageAssets(useAppStore.getState().nodes), previewModule);',
    );
    expect(SRC).toContain('imageAssets: boot.entries,');
    expect(SRC).toContain('return [tslToPreviewHTML(debouncedPreviewCode, options), previewModule, boot.sent] as const;');
    const rebuild = SRC.slice(SRC.indexOf('A new srcDoc means a full document reload'));
    expect(rebuild.slice(0, rebuild.indexOf('}, [previewHtml, bakedModule, bootAssetKeys, containerReady'))).toContain(
      'sentAssetKeysRef.current = new Set(bootAssetKeys);',
    );
  });

  it('posts the feed BEFORE the swap it belongs to, and advances the sent set', () => {
    const at = SRC.indexOf('const postShaderSwap = useCallback(');
    const body = SRC.slice(at, SRC.indexOf('}, [clearHotSwapWait]);', at));
    const feed = body.indexOf('planPreviewAssetFeed(sentAssetKeysRef.current, collectImageAssets(useAppStore.getState().nodes), code)');
    const post = body.indexOf("win.postMessage({ type: PREVIEW_ASSETS_MESSAGE, entries: feed.entries }, '*')");
    const advance = body.indexOf('sentAssetKeysRef.current = feed.sent;');
    const swap = body.indexOf("win.postMessage({ type: SHADER_SWAP_MESSAGE, code, gen }, '*')");
    expect(feed).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(feed);
    expect(advance).toBeGreaterThan(post);
    expect(swap).toBeGreaterThan(advance);
  });

  it("re-seeds the sent set from the boot list on the fresh document's load, before the replay", () => {
    const at = SRC.indexOf('const handleIframeLoad = useCallback(');
    const body = SRC.slice(at, SRC.indexOf('if (!isModelGeometry(previewGeometry)) return;', at));
    const seed = body.indexOf('sentAssetKeysRef.current = new Set(bootAssetKeys);');
    expect(seed).toBeGreaterThan(-1);
    expect(body.indexOf('postShaderSwap(previewModule)')).toBeGreaterThan(seed);
  });

  it('the XR popup still inlines the payloads (a top-level document has no parent to feed it)', () => {
    const call = 'tslToPreviewHTML(inlineImageAssetsFromNodes(previewCode, useAppStore.getState().nodes), {';
    const at = SRC.indexOf(call);
    expect(at).toBeGreaterThan(-1);
    const xrOptions = SRC.slice(at, SRC.indexOf('w.document.write(html);', at));
    expect(xrOptions).toContain('xr: true,');
    expect(xrOptions).not.toContain('imageAssets');
    // The one `imageAssets:` option in the file is the sandboxed document's.
    expect(SRC.split('imageAssets:').length - 1).toBe(1);
  });
});
