import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * The canonical Latvian node/category labels live in `src/i18n/node-i18n.json`
 * (imported by the React app). The `fs-i18n-sync` vite plugin copies that file
 * to `public/node-i18n.json` at dev/build start so the standalone Node Designer
 * (node-designer.html) can fetch the SAME data — one source, no duplicate table.
 *
 * This test fails on DRIFT between the two. Fix drift by editing the source
 * (`src/i18n/node-i18n.json`) and re-running `vite` (dev or build), never by
 * hand-editing the public copy.
 */
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src/i18n/node-i18n.json');
const PUBLIC = path.join(ROOT, 'public/node-i18n.json');

describe('node-i18n.json stays in sync between src and public', () => {
  it('public/node-i18n.json is byte-identical to src/i18n/node-i18n.json', () => {
    expect(existsSync(PUBLIC), `copy missing — sync did not run: ${PUBLIC}`).toBe(true);
    expect(
      readFileSync(PUBLIC).equals(readFileSync(SRC)),
      'drift: public/node-i18n.json differs from src/i18n/node-i18n.json — edit the source, not the copy',
    ).toBe(true);
  });

  it('is valid JSON with the expected shape', () => {
    const data = JSON.parse(readFileSync(SRC, 'utf-8'));
    expect(data).toHaveProperty('nodes');
    expect(data).toHaveProperty('categories');
    expect(typeof data.nodes).toBe('object');
    expect(typeof data.categories).toBe('object');
  });
});
