/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { cpSync, readFileSync } from 'fs';

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

export default defineConfig({
  base: '/FastShaders/',
  plugins: [react(), versionHtmlPlugin(), cspHtmlPlugin(), shaderCarouselCopyPlugin()],
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
