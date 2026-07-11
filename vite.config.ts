/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { cpSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, './package.json'), 'utf-8'));

/**
 * Substitute %APP_VERSION% in index.html with the current package version.
 * Lets the deployed HTML self-report its build via a <meta name="version">
 * tag, so anyone debugging a stale tab can see immediately whether they're
 * running the latest code without opening DevTools and stepping into JS.
 */
const versionHtmlPlugin = (): Plugin => ({
  name: 'fs-version-html',
  transformIndexHtml(html) {
    return html.replace(/%APP_VERSION%/g, pkg.version);
  },
});

/**
 * Inject a Content-Security-Policy meta tag into the production index.html.
 *
 * Build-only on purpose: Vite's dev server uses a WebSocket for HMR and
 * inline scripts for client injection that a strict CSP would break.
 * Adding the meta only at build time keeps `npm run dev` working while the
 * deployed bundle gets the policy.
 *
 * Why each directive is permissive in places:
 *   - `'unsafe-eval'` — Three.js TSL and Monaco compile dynamic code via
 *     `new Function`; without it the editor and live preview don't render.
 *   - `'wasm-unsafe-eval'` — A-Frame's WebGPU build instantiates Wasm.
 *   - `'unsafe-inline'` for script-src — the preview iframe is loaded via
 *     `srcdoc`, which inherits the parent CSP, and the generated preview
 *     HTML uses several inline <script> blocks (shader-blob setup,
 *     fit-bounds component, postMessage glue). Hashing them all is
 *     brittle because they change with every render. The iframe sandbox
 *     (allow-scripts only, no allow-same-origin) is what actually
 *     contains user code; 'unsafe-inline' here just lets the
 *     bench-authored inline scripts run.
 *   - `'unsafe-inline'` for style-src — Monaco and React inject inline
 *     style attributes for theming and layout.
 *   - `blob:` — preview HTML, shader modules, and Monaco workers are loaded
 *     from blob URLs created at runtime.
 *   - Monaco and the Inter/JetBrains Mono fonts are BUNDLED (monacoSetup.ts,
 *     @fontsource imports in main.tsx) — no CDN origins in the policy. The
 *     app must work fully offline (and in the desktop build), so never
 *     reintroduce cdn.jsdelivr.net / fonts.googleapis.com here.
 *   - `https://alvis1.github.io` — the sandboxed preview iframe has an
 *     opaque origin, so `'self'` resolves to `null` for fetches it makes
 *     under the inherited CSP. The deployed prod origin therefore has to
 *     be listed explicitly so the iframe can fetch /FastShaders/models/*
 *     OBJs across the sandbox boundary. Update this list (or move CSP
 *     emission behind a build-time env var) if the deploy URL changes.
 *
 * `frame-src 'self' blob:` authorizes the user-shader iframe;
 * `worker-src 'self' blob:` covers Monaco's web workers.
 */
// Deploy-target overrides so one repo builds for both GitHub Pages and self-hosting.
//   FS_BASE           — path the app is served under (default keeps the GitHub Pages build identical)
//   FS_PREVIEW_ORIGIN — extra origin(s) the sandboxed preview iframe may fetch from at the deploy domain
//                       (space-separated; the iframe's opaque origin means each must be listed explicitly)
//   FS_DESKTOP=1      — desktop (Tauri) build profile: base defaults to '/', the CSP meta is
//                       suppressed (the wrapper's own CSP config governs; WebKit handles
//                       custom-scheme origins in meta CSPs unreliably), and the WebGPU-only
//                       ShaderCarousel suite is left out of dist — instead it is copied into
//                       src-tauri/carousel-dist/ and bundled as a Tauri resource, which the
//                       in-app LAN bench server (src-tauri/src/bench_server.rs, "VR" toolbar
//                       popover) serves to headsets on the local network. Also exposed to the
//                       app as __FS_DESKTOP__ so desktop-irrelevant UI (Local download button,
//                       SC link) can hide itself.
// Example self-host build:
//   FS_BASE=/fastshaders/ FS_PREVIEW_ORIGIN='https://alvismisjuns.lv https://www.alvismisjuns.lv' npm run build
// Desktop build:
//   FS_DESKTOP=1 npm run build
// The Tauri CLI exports TAURI_ENV_* for its beforeDev/beforeBuild hooks, so
// `tauri dev` / `tauri build` (and tauri-action in CI) get the desktop
// profile automatically — no cross-platform env-prefix headaches on Windows.
const FS_DESKTOP = process.env.FS_DESKTOP === '1' || !!process.env.TAURI_ENV_PLATFORM;
const FS_BASE = process.env.FS_BASE ?? (FS_DESKTOP ? '/' : '/FastShaders/');
const FS_PREVIEW_ORIGIN = process.env.FS_PREVIEW_ORIGIN ?? '';

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  `connect-src 'self' blob: https://alvis1.github.io${FS_PREVIEW_ORIGIN ? ' ' + FS_PREVIEW_ORIGIN : ''}`,
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const cspHtmlPlugin = (): Plugin => ({
  name: 'fs-csp-html',
  apply: 'build',
  transformIndexHtml(html) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP_DIRECTIVES}" />`;
    return html.replace('<head>', `<head>\n    ${meta}`);
  },
});

/**
 * Strip the legacy `.woff` fallback src from the vendored @fontsource CSS at
 * build time. Every woff2 subset rule survives untouched — only the trailing
 * `, url(...woff) format('woff')` alternative is removed, so no browser that
 * FastShaders supports loses anything while dist stops shipping a second copy
 * of every font subset. Fonts stay fully LOCAL (@fontsource files bundled by
 * Vite) — this only trims which local files get emitted.
 *
 * Build-only + `enforce: 'pre'`: dev serves the vendor CSS untouched, and at
 * build the strip must land before vite:css resolves the url() references
 * (which is what emits the font assets).
 */
const fontsourceWoff2OnlyPlugin = (): Plugin => ({
  name: 'fs-fontsource-woff2-only',
  apply: 'build',
  enforce: 'pre',
  transform(code, id) {
    if (!/@fontsource\/.*\.css(\?.*)?$/.test(id)) return null;
    // `[^)]*\.woff\)` cannot match a `.woff2` url (that ends in `woff2)`),
    // so only the legacy-format alternative is dropped.
    return { code: code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, ''), map: null };
  },
});

/**
 * Copy the ShaderCarousel/ sibling suite into dist/ShaderCarousel/ so the
 * SC link in the toolbar resolves on the deployed site. ShaderCarousel is
 * served as plain static HTML (it has its own import maps and A-Frame
 * pipeline) and is intentionally outside Vite's module graph.
 *
 * Excludes benchmark output (sphere/benchData) and incidental dev files
 * (Untitled-2.ipynb, .DS_Store, .vscode, .git*) from the deploy.
 */
const SHADER_CAROUSEL_EXCLUDE = new Set([
  'benchData',
  'https', // local dev TLS material — never ship the private key
  '.DS_Store',
  '.vscode',
  '.git',
  '.gitignore',
  '.gitattributes',
  'Untitled-2.ipynb',
]);
// The web dist already ships this exact bundle at dist/js/ (synced from the
// same a-frame-shaderloader source into public/js/), so the web carousel copy
// drops its duplicate and points bench-inout at the app's copy instead. The
// desktop staging keeps its own — the LAN bench server serves the carousel
// tree standalone, without dist/js next to it.
const AFRAME_BUNDLE_REL = path.join('components', 'three', 'a-frame-180-a-01.min.js');
const copyShaderCarousel = (dst: string, opts?: { shareAppAFrameBundle?: boolean }) => {
  const src = path.resolve(__dirname, 'ShaderCarousel');
  const dstAbs = path.resolve(__dirname, dst);
  // The desktop copy lives outside dist/ and persists between builds, so
  // clear it first — stale files must not ride into the bundled resources.
  rmSync(dstAbs, { recursive: true, force: true });
  cpSync(src, dstAbs, {
    recursive: true,
    filter: (s) =>
      !SHADER_CAROUSEL_EXCLUDE.has(path.basename(s)) &&
      !(opts?.shareAppAFrameBundle && path.relative(src, s) === AFRAME_BUNDLE_REL),
  });
  if (opts?.shareAppAFrameBundle) {
    // Rewrite only the COPIED bench-inout page — the source file must keep
    // working standalone and in the desktop staging, which has its own copy.
    const benchInout = path.join(dstAbs, 'bench-inout', 'index.html');
    const from = '../components/three/a-frame-180-a-01.min.js';
    const to = '../../js/a-frame-180-a-01.min.js';
    const html = readFileSync(benchInout, 'utf-8');
    if (!html.includes(from)) {
      // Fail the build rather than deploy a bench page whose A-Frame 404s.
      throw new Error(
        `[fs-copy-shadercarousel] bench-inout/index.html no longer references ${from} — update the dedupe rewrite`
      );
    }
    writeFileSync(benchInout, html.split(from).join(to));
  }
};
const shaderCarouselCopyPlugin = (): Plugin => ({
  name: 'fs-copy-shadercarousel',
  apply: 'build',
  closeBundle() {
    copyShaderCarousel('dist/ShaderCarousel', { shareAppAFrameBundle: true });
  },
});
/**
 * Desktop variant: stage the carousel where tauri.conf.json's
 * `bundle.resources` picks it up (`carousel-dist/` → resource dir
 * `ShaderCarousel/`), for the in-app LAN bench server. Runs at buildStart —
 * which fires for `vite build` AND the dev server — so `tauri dev` (whose
 * beforeDevCommand never runs a build) also gets fresh staged assets after
 * the vendor sync. The dir is gitignored.
 */
const shaderCarouselDesktopStagePlugin = (): Plugin => ({
  name: 'fs-stage-shadercarousel-desktop',
  buildStart() {
    copyShaderCarousel('src-tauri/carousel-dist');
    // Restore the tracked .gitkeep the rmSync inside copyShaderCarousel just
    // wiped, so staging never dirties the working tree. The placeholder
    // exists because tauri-build resolves bundle.resources on every cargo
    // build/check/test — a missing carousel-dist/ fails the build script on
    // fresh checkouts before any staging has run (empty dir = skipped).
    writeFileSync(path.resolve(__dirname, 'src-tauri/carousel-dist/.gitkeep'), '');
  },
});

/**
 * Dev-only save/load endpoint for the Node Designer (`node-designer.html`).
 *
 * The designer's File System Access path (`showDirectoryPicker`) is
 * Chromium-only; this endpoint lets it persist `customGlyphs.ts` through the
 * dev server instead, so saving works in ANY browser at
 * http://localhost:5173/FastShaders/node-designer.html.
 *
 *   GET  /__nd/glyphs → { content } — current customGlyphs.ts text ('' if absent)
 *   GET  /__nd/costs  → { content } — complexity.json text (cost parity refresh)
 *   POST /__nd/glyphs { content }   — rewrite customGlyphs.ts
 *
 * Serve-only (`apply: 'serve'`) — never part of a production build. Writes
 * exactly one hard-coded path; client-supplied paths are never honored.
 * Mounted at server root (outside the Vite base) so the tool can call
 * absolute `/__nd/*` URLs.
 */
const ND_GLYPHS = path.resolve(__dirname, 'src/components/NodeEditor/nodes/glyphs/customGlyphs.ts');
const ND_COSTS = path.resolve(__dirname, 'src/registry/complexity.json');

/**
 * Keep `public/node-designer.html` in sync with the repo-root source.
 *
 * The Node Designer is authored at the repo root (`node-designer.html`), but
 * Vite only serves / ships files under `public/`, so the running tool is
 * `public/node-designer.html` (dev URL /FastShaders/node-designer.html and the
 * copy emitted to dist/). Without a sync step the two were byte-identical
 * untracked copies that would silently diverge on the next edit. Treat the
 * root file as the single source of truth and regenerate the public copy at
 * the start of every dev server and every build (runs in both via buildStart).
 */
const ND_ROOT = path.resolve(__dirname, 'node-designer.html');
const ND_PUBLIC = path.resolve(__dirname, 'public/node-designer.html');

/**
 * Copy `srcPath` → `dstPath` only when their bytes differ. Compare-before-write
 * skips no-op copies (no mtime churn) and writes in place (no unlink — cpSync's
 * unlink can EPERM on restricted mounts). The dest dir is created if missing so
 * a fresh/partial checkout doesn't ENOENT. Buffer comparison is binary-safe, so
 * the same helper serves both the HTML and the minified-JS vendored files.
 */
const syncVendoredFile = (srcPath: string, dstPath: string): void => {
  const src = readFileSync(srcPath);
  const dst = existsSync(dstPath) ? readFileSync(dstPath) : null;
  if (dst && src.equals(dst)) return;
  mkdirSync(path.dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, src);
};

const nodeDesignerSyncPlugin = (): Plugin => ({
  name: 'fs-node-designer-sync',
  buildStart() {
    try {
      if (!existsSync(ND_ROOT)) return;
      // Treat the root file as the single source of truth. Never let a sync
      // hiccup kill dev/test startup.
      syncVendoredFile(ND_ROOT, ND_PUBLIC);
    } catch (e) {
      console.warn('[fs-node-designer-sync] sync skipped:', (e as Error).message);
    }
  },
});

/**
 * Vendor the shared A-Frame preview scripts from a SINGLE source of truth.
 *
 * The canonical copies live in the `a-frame-shaderloader/` submodule's `js/`
 * dir — that's where `build/build.mjs` emits the A-Frame IIFE bundle
 * (`a-frame-180-a-01.min.js`, r184) and where the shaderloader component +
 * orbit-controls are maintained (and what the jsdelivr CDN serves for exported
 * shaders). The FastShaders app (preview iframe) loads them from `public/js/`,
 * and the ShaderCarousel `bench-inout` page loads the bundle from
 * `ShaderCarousel/components/three/`.
 *
 * Rather than hand-maintaining three copies (which silently drift and pick up
 * version skew), this plugin copies the canonical files into both consumer
 * locations at dev/build start. **Edit only the submodule source; the copies
 * are generated.** `src/vendorSync.test.ts` fails if any copy diverges, so a
 * stale consumer copy can't ship. Compare-before-write avoids mtime churn and
 * keeps startup from EPERM-ing on restricted mounts (no unlink).
 *
 * Runs at buildStart — before `shaderCarouselCopyPlugin`'s closeBundle copy, so
 * the carousel deploy picks up the freshly-synced bundle.
 */
const VENDOR_SRC = path.resolve(__dirname, 'a-frame-shaderloader/js');
const VENDOR_TARGETS: { file: string; dests: string[] }[] = [
  { file: 'a-frame-180-a-01.min.js', dests: ['public/js', 'ShaderCarousel/components/three'] },
  { file: 'a-frame-shaderloader-0.4.js', dests: ['public/js'] },
  { file: 'aframe-orbit-controls.min.js', dests: ['public/js'] },
];
const vendorSyncPlugin = (): Plugin => ({
  name: 'fs-vendor-sync',
  buildStart() {
    for (const { file, dests } of VENDOR_TARGETS) {
      const srcPath = path.join(VENDOR_SRC, file);
      if (!existsSync(srcPath)) {
        console.warn(`[fs-vendor-sync] missing source ${file} — skipped`);
        continue;
      }
      // Per-dest try/catch so a failure copying to one consumer location can't
      // skip the others (which would ship a silently-stale copy past the drift
      // test).
      for (const dest of dests) {
        const dstPath = path.resolve(__dirname, dest, file);
        try {
          syncVendoredFile(srcPath, dstPath);
        } catch (e) {
          console.warn(`[fs-vendor-sync] ${dest}/${file} skipped:`, (e as Error).message);
        }
      }
    }
  },
});
const nodeDesignerEndpointPlugin = (): Plugin => ({
  name: 'fs-node-designer-endpoint',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__nd', (req, res) => {
      const send = (code: number, obj: unknown) => {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      try {
        if (req.method === 'GET' && req.url === '/glyphs') {
          send(200, { content: existsSync(ND_GLYPHS) ? readFileSync(ND_GLYPHS, 'utf-8') : '' });
        } else if (req.method === 'GET' && req.url === '/costs') {
          send(200, { content: readFileSync(ND_COSTS, 'utf-8') });
        } else if (req.method === 'POST' && req.url === '/glyphs') {
          // CSRF / cross-origin write guard. While `npm run dev` runs, any
          // other tab in the developer's browser could fire a CORS "simple"
          // POST at localhost and overwrite customGlyphs.ts — whose SVG is
          // rendered via dangerouslySetInnerHTML — yielding dev-origin stored
          // XSS / source injection. Two cheap, independent checks close it:
          //   1. Reject any request whose Origin isn't a loopback host. A
          //      cross-site page's Origin (set by the browser, unforgeable)
          //      is its own domain; same-origin requests omit Origin or send
          //      a localhost one.
          const origin = req.headers.origin;
          if (origin) {
            let loopback = false;
            try {
              const h = new URL(origin).hostname;
              loopback = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
            } catch { loopback = false; }
            if (!loopback) { send(403, { error: 'forbidden origin' }); return; }
          }
          //   2. Require application/json. A true cross-origin POST with this
          //      content-type is a "non-simple" request, so the browser must
          //      preflight it — and this endpoint answers no preflight, so the
          //      write never fires. The same-origin tool already sends JSON.
          if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
            send(415, { error: 'content-type must be application/json' });
            return;
          }
          let body = '';
          req.on('data', (c) => {
            body += c;
            if (body.length > 5_000_000) req.destroy(); // sanity cap
          });
          req.on('end', () => {
            try {
              const { content } = JSON.parse(body) as { content?: unknown };
              if (typeof content !== 'string' || !content.includes('export const CUSTOM_GLYPHS')) {
                send(400, { error: 'unexpected content' });
                return;
              }
              writeFileSync(ND_GLYPHS, content, 'utf-8');
              send(200, { ok: true });
            } catch (e) {
              send(500, { error: String((e as Error).message) });
            }
          });
        } else {
          send(404, { error: 'not found' });
        }
      } catch (e) {
        send(500, { error: String((e as Error).message) });
      }
    });
  },
});

export default defineConfig({
  base: FS_BASE,
  plugins: [
    react(),
    versionHtmlPlugin(),
    fontsourceWoff2OnlyPlugin(),
    ...(FS_DESKTOP ? [] : [cspHtmlPlugin()]),
    vendorSyncPlugin(),
    ...(FS_DESKTOP ? [shaderCarouselDesktopStagePlugin()] : [shaderCarouselCopyPlugin()]),
    nodeDesignerSyncPlugin(),
    nodeDesignerEndpointPlugin(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    'process.env': { NODE_ENV: JSON.stringify('production') },
    __APP_VERSION__: JSON.stringify(pkg.version),
    __FS_DESKTOP__: JSON.stringify(FS_DESKTOP),
  },
  server: {
    port: 5173,
    open: true,
    // The preview iframe is sandboxed without `allow-same-origin`, so its
    // origin is `null` and fetches into the dev server for static assets
    // (OBJ models, A-Frame bundle) are cross-origin. Vite's default cors
    // config only covers HMR/module endpoints — explicitly emit
    // Access-Control-Allow-Origin: * on every response so OBJ previews
    // load in dev too. GitHub Pages already does this in production.
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // Monaco is rarely-changing vendor code — its own chunk keeps the app
        // chunk small and lets browsers cache Monaco across deploys. Function
        // form (not `{ monaco: ['monaco-editor'] }`): monacoSetup.ts now
        // cherry-picks deep ESM entries instead of the editor.main package
        // entry, and the object form would force the full editor.main module
        // (all language clients + tokenizers) back into the bundle.
        manualChunks(id) {
          if (id.includes('node_modules/monaco-editor/') && !id.endsWith('.css')) return 'monaco';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
