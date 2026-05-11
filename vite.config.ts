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
  plugins: [react(), versionHtmlPlugin(), shaderCarouselCopyPlugin()],
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
  },
  build: {
    target: 'esnext',
  },
});
