/**
 * THE BOOT HOLD: a reload with a dropped model must build ONE document.
 *
 * The bug this pins (owner, 2026-09-19): a dropped multi-mesh GLB came back as
 * a SPHERE after a reload while the Model dropdown still read "Model: <file>",
 * it never self-corrected, and picking another model and coming back cured it.
 * That state is only reachable while boot attaches a sphere document and then
 * rewrites `srcdoc` on the same, still-loading iframe — see bootMeshWait.ts for
 * the full ordering.
 *
 * Half of this is the pure rule; the other half are SOURCE pins, for the reason
 * previewRebuild.test.ts and previewGeometryPref.test.ts both state — the vitest
 * env is `node` and ShaderPreview has never had a rendering test. The pins are
 * drift guards, not restatements: the gate is worthless if the `srcDoc`
 * expression stops consulting it, and the cold-rebuild effect is worse than
 * worthless if the flag gates it without also being a DEP (the document that
 * finally attaches would run with its refs never seeded).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOOT_MESH_WAIT_MS, shouldWaitForBootMesh } from './bootMeshWait';

const SRC = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');

describe('shouldWaitForBootMesh', () => {
  it('holds only while a boot that EXPECTS a model has none yet', () => {
    expect(shouldWaitForBootMesh(true, false, false)).toBe(true);
  });

  it('never holds a session that did not boot with a model preference', () => {
    // The overwhelmingly common boot. It must not pay a millisecond: every
    // other combination below is irrelevant once this is false.
    expect(shouldWaitForBootMesh(false, false, false)).toBe(false);
    expect(shouldWaitForBootMesh(false, true, false)).toBe(false);
    expect(shouldWaitForBootMesh(false, false, true)).toBe(false);
  });

  it('ends the hold the moment a mesh exists by ANY route', () => {
    // A drop / zip / GLB import landing during the hold is synchronous, so the
    // predicate is read per render rather than captured.
    expect(shouldWaitForBootMesh(true, true, false)).toBe(false);
  });

  it('ends the hold once the read has settled, mesh or no mesh', () => {
    // The cache being EMPTY is the case that would hang forever on a naive
    // "wait until a mesh arrives" — the read settling is what releases it.
    expect(shouldWaitForBootMesh(true, false, true)).toBe(false);
    expect(shouldWaitForBootMesh(true, true, true)).toBe(false);
  });

  it('caps the hold well under idbSafe IDB_TIMEOUT_MS', () => {
    // A blocked/absent IndexedDB only resolves on that 5 s timeout, and an
    // empty pane for that long is worse than the throwaway document the hold
    // avoids. Past the cap the preview attaches exactly what it attaches
    // today, so the degradation is to the OLD behaviour, never to something
    // worse.
    expect(BOOT_MESH_WAIT_MS).toBeGreaterThan(0);
    expect(BOOT_MESH_WAIT_MS).toBeLessThan(5000);
  });
});

describe('ShaderPreview consults the hold', () => {
  it('gates srcDoc on it, alongside containerReady', () => {
    expect(SRC).toMatch(/srcDoc=\{containerReady && !waitingForBootMesh \? previewHtml : undefined\}/);
  });

  it('settles the hold on EVERY exit of the cache read', () => {
    // The early return (a mesh is already loaded), the cap, and a `finally`
    // that covers a throw anywhere in the chain. Miss one and a boot that
    // finds no cached mesh holds its document for the full cap.
    const at = SRC.indexOf('const [bootMeshSettled, setBootMeshSettled]');
    expect(at).toBeGreaterThan(-1);
    const effect = SRC.slice(at, SRC.indexOf('const waitingForBootMesh', at));
    expect(effect).toContain('if (useAppStore.getState().previewMesh) { setBootMeshSettled(true); return; }');
    expect(effect).toContain('BOOT_MESH_WAIT_MS');
    expect(effect).toContain('.finally(');
    // Three settle sites: the early return, the cap timer, the finally.
    expect(effect.match(/setBootMeshSettled\(true\)/g)).toHaveLength(3);
  });

  it('keeps the flag a DEP of the cold-rebuild effect, not just a gate', () => {
    // When the hold lifts, nothing else in that dep list moves — so a gate
    // without the dep leaves `runningModuleRef` / `sentAssetKeysRef` unseeded
    // for the document that then attaches, and the first edit after boot would
    // bail as "already running".
    const at = SRC.indexOf('if (!containerReady || waitingForBootMesh) return;');
    expect(at).toBeGreaterThan(-1);
    const deps = SRC.slice(at, SRC.indexOf('clearHotSwapWait]', at));
    expect(deps).toContain('waitingForBootMesh');
  });

  it('replaces the iframe on a cold rebuild rather than rewriting srcdoc on it', () => {
    // The hold cannot cover a mesh that lands after its cap — the LARGEST
    // models, i.e. exactly the reported one. `key` is what makes that residue
    // degrade to a guaranteed second navigation instead of to the bug, so it
    // is load-bearing and not tidy-up-able.
    expect(SRC).toMatch(/key=\{coldDocKey\}\s*\n\s*ref=\{iframeRef\}/);
  });

  it('holds the hot swap too, so nothing is posted into about:blank', () => {
    const at = SRC.indexOf('if (!HOT_SWAP_ENABLED) return;');
    expect(at).toBeGreaterThan(-1);
    const effect = SRC.slice(at, SRC.indexOf('}, [previewModule', at));
    expect(effect).toContain('waitingForBootMesh');
  });
});
