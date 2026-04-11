import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

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

export default defineConfig({
  base: '/FastShaders/',
  plugins: [react(), versionHtmlPlugin()],
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
