/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { cpSync, readFileSync, writeFileSync, existsSync } from 'fs';

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
 *   - `https://cdn.jsdelivr.net` — @monaco-editor/react loads the Monaco
 *     loader.js + workers from there at runtime, and exported A-Frame
 *     HTML pulls the shaderloader bundle from there too.
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
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' blob: https://cdn.jsdelivr.net https://alvis1.github.io",
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
const shaderCarouselCopyPlugin = (): Plugin => ({
  name: 'fs-copy-shadercarousel',
  apply: 'build',
  closeBundle() {
    const src = path.resolve(__dirname, 'ShaderCarousel');
    const dst = path.resolve(__dirname, 'dist', 'ShaderCarousel');
    cpSync(src, dst, {
      recursive: true,
      filter: (s) => !SHADER_CAROUSEL_EXCLUDE.has(path.basename(s)),
    });
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
const nodeDesignerSyncPlugin = (): Plugin => ({
  name: 'fs-node-designer-sync',
  buildStart() {
    try {
      if (!existsSync(ND_ROOT)) return;
      // Compare before writing: skips no-op copies (no mtime churn) and writes
      // in place via writeFileSync (no unlink — cpSync's unlink can EPERM on
      // restricted mounts). Never let a sync hiccup kill dev/test startup.
      const src = readFileSync(ND_ROOT, 'utf-8');
      const dst = existsSync(ND_PUBLIC) ? readFileSync(ND_PUBLIC, 'utf-8') : null;
      if (src !== dst) writeFileSync(ND_PUBLIC, src, 'utf-8');
    } catch (e) {
      console.warn('[fs-node-designer-sync] sync skipped:', (e as Error).message);
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
  base: '/FastShaders/',
  plugins: [react(), versionHtmlPlugin(), cspHtmlPlugin(), shaderCarouselCopyPlugin(), nodeDesignerSyncPlugin(), nodeDesignerEndpointPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    'process.env': { NODE_ENV: JSON.stringify('production') },
    __APP_VERSION__: JSON.stringify(pkg.version),
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
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
