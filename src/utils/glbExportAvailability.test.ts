/**
 * Can one `.glb` be exported from the loaded model, and which format does
 * EXPORT take (utils/glbExportAvailability.ts)? Pure, so this is the whole
 * decision — the surfaces only render it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  effectiveExportFormat,
  glbExportAvailability,
  type GlbExportMesh,
} from './glbExportAvailability';
import type { GltfPreviewFacts } from './gltfReader';

const FACTS: GltfPreviewFacts = { signature: ['Body'], meshMaterials: new Map() };

const mesh = (o: Partial<NonNullable<GlbExportMesh>>): GlbExportMesh =>
  ({ kind: 'glb', name: 'statue.glb', gltf: FACTS, ...o }) as GlbExportMesh;

describe('glbExportAvailability', () => {
  it('no model, an .obj, and a readable glTF', () => {
    expect(glbExportAvailability(null)).toEqual({ ok: false, reason: 'no-model' });
    expect(glbExportAvailability(mesh({ kind: 'obj', name: 'bunny.obj' }))).toEqual({
      ok: false,
      reason: 'obj',
      name: 'bunny.obj',
    });
    expect(glbExportAvailability(mesh({}))).toEqual({ ok: true });
    expect(glbExportAvailability(mesh({ kind: 'gltf', name: 'scene.gltf' }))).toEqual({ ok: true });
  });

  it('a refused glTF: external data is its own reason, everything else is unreadable', () => {
    expect(
      glbExportAvailability(mesh({ kind: 'gltf', name: 'scene.gltf', gltf: null, gltfReadRefusal: 'external-data' })),
    ).toEqual({ ok: false, reason: 'external-data', name: 'scene.gltf' });
    for (const r of ['too-large', 'unreadable', 'too-complex', 'invalid-model'] as const) {
      expect(glbExportAvailability(mesh({ gltf: null, gltfReadRefusal: r })), r).toEqual({
        ok: false,
        reason: 'unreadable',
        name: 'statue.glb',
      });
    }
    // Facts never computed (an older session, a hand-built mesh): unreadable,
    // the safe direction — the export would have to parse it anyway.
    expect(glbExportAvailability(mesh({ gltf: undefined }))).toEqual({
      ok: false,
      reason: 'unreadable',
      name: 'statue.glb',
    });
  });
});

describe('effectiveExportFormat', () => {
  it('is .glb only for a packable model, outside a study session, with the flag exactly true', () => {
    expect(effectiveExportFormat(true, mesh({}), false)).toBe('glb');
    expect(effectiveExportFormat(true, mesh({}), true)).toBe('bundle');
    expect(effectiveExportFormat(true, mesh({ kind: 'obj' }), false)).toBe('bundle');
    expect(effectiveExportFormat(true, null, false)).toBe('bundle');
    expect(effectiveExportFormat(false, mesh({}), false)).toBe('bundle');
  });

  it('never coerces the flag', () => {
    for (const junk of [1, 'true', {}, null, undefined]) {
      expect(effectiveExportFormat(junk as unknown as boolean, mesh({}), false), String(junk)).toBe('bundle');
    }
  });
});

describe('the module is a leaf', () => {
  it('imports only types, so no surface can pull the store in through it', () => {
    const src = readFileSync(path.join(__dirname, 'glbExportAvailability.ts'), 'utf8');
    for (const line of src.split('\n')) {
      if (/^\s*import\s/.test(line)) expect(line, line).toMatch(/^import type /);
    }
  });
});
