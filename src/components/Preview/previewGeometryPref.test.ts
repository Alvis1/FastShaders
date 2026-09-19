/**
 * The preview geometry PREFERENCE survives a boot, and the picker agrees with
 * the viewport.
 *
 * The defect this pins (owner, 2026-09-18: "when refreshed the model
 * disappears and there is a sphere, although the top selection shows that it
 * is the mesh"): `validateGeometry` downgraded a stored 'custom' to 'sphere'
 * whenever no mesh was loaded, and `usePersistedState` writes its seeded value
 * straight back — so EVERY boot overwrote the stored preference for the length
 * of the asynchronous IndexedDB mesh restore (MEASURED in Chrome at ~250 ms:
 * 'sphere' at t=188 ms, 'custom' again at t=442 ms). A reload, a vite dev
 * full-reload or a crash inside that window lost the preference for good: the
 * mesh still came back from the cache — so the Model entry sat in the dropdown
 * named after the user's file — while the viewport rendered a sphere, on that
 * boot and on every boot after it.
 *
 * The behavioural half runs against the pure module; the rest are SOURCE pins,
 * because the vitest env is `node` and ShaderPreview has never had a rendering
 * test (previewRebuild.test.ts says so).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shownGeometry, validateGeometry } from './previewGeometryPref';
import { isModelGeometry } from '@/engine/tslToPreviewHTML';

const SRC = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');
/** SRC without comments — the removed effect is DESCRIBED in one, so a scan
 *  for the call it made has to look at code only. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the stored preference is kept verbatim', () => {
  it('accepts custom with no mesh loaded — it is a preference, not a claim', () => {
    // THE regression: the old validator answered 'sphere' here, and
    // usePersistedState wrote that answer back over the user's choice.
    expect(validateGeometry('custom')).toBe('custom');
  });

  it('keeps every other shipped value and refuses anything else', () => {
    for (const g of ['sphere', 'cube', 'plane', 'teapot', 'bunny']) {
      expect(validateGeometry(g)).toBe(g);
    }
    for (const junk of [null, '', 'marchSphere', 'Custom', '__proto__', 'sphere ']) {
      expect(validateGeometry(junk), String(junk)).toBe('sphere');
    }
  });

  it('is free of side effects and reads no store', () => {
    const at = SRC.indexOf('validateGeometry');
    expect(at, 'ShaderPreview no longer references validateGeometry').toBeGreaterThan(-1);
    // The imperative store read lived inside the validator; it is gone with it.
    expect(SRC).not.toMatch(/v === 'custom' && useAppStore\.getState\(\)\.previewMesh/);
    expect(SRC).toMatch(
      /^import \{ shownGeometry, validateGeometry \} from '\.\/previewGeometryPref';$/m,
    );
  });
});

describe('the shown geometry is DERIVED', () => {
  it('falls back to the sphere only while custom has no mesh', () => {
    expect(shownGeometry('custom', false)).toBe('sphere');
    expect(shownGeometry('custom', true)).toBe('custom');
  });

  it('passes every other preference through, mesh or not', () => {
    for (const g of ['sphere', 'cube', 'plane', 'teapot', 'bunny'] as const) {
      expect(shownGeometry(g, false)).toBe(g);
      expect(shownGeometry(g, true)).toBe(g);
    }
  });

  it('never yields a model geometry the pane cannot render', () => {
    expect(isModelGeometry(shownGeometry('custom', false))).toBe(false);
    expect(isModelGeometry(shownGeometry('custom', true))).toBe(true);
  });
});

describe('one derivation feeds the document, the picker and the Subd gate', () => {
  it('ShaderPreview derives it once, from the subscribed mesh', () => {
    expect(SRC).toContain(
      'const geometryShown = shownGeometry(geometry, previewMesh !== null);',
    );
    expect(SRC).toContain(
      "const previewGeometry: GeometryType = marchWindow !== null ? MARCH_WINDOW_GEOMETRY : geometryShown;",
    );
  });

  it('the Model select shows the SHOWN geometry, not the raw preference', () => {
    // `value={geometry}` with no matching <option> (the custom entry renders
    // only while a mesh is loaded) leaves the control displaying its first
    // entry while state says otherwise — the picker/viewport disagreement.
    expect(SRC).toContain('value={geometryShown}');
    expect(SRC).not.toMatch(/value=\{geometry\}/);
  });

  it('the Subd slider is gated on the same value', () => {
    expect(SRC).toContain('{!isModelGeometry(geometryShown) && !sdfDrives && (');
  });

  it('nothing writes the fallback back to the preference', () => {
    // The SECOND route to the same loss: an effect that answered "the mesh is
    // gone, so select the sphere" by calling setGeometry, which
    // usePersistedState then persisted. It fired on every boot inside the
    // restore window (MEASURED: a 'sphere' write at 219 ms, between the seed
    // and the restore). The derivation above replaces it; only the model drop
    // and the cache restore may write the preference now, and both write
    // 'custom'.
    expect(CODE).not.toMatch(/setGeometry\(\s*'sphere'\s*\)/);
    const writes = [...CODE.matchAll(/setGeometry\(\s*'([a-z]+)'\s*\)/gi)].map((m) => m[1]);
    expect(writes).toEqual(['custom', 'custom']);
  });
});
