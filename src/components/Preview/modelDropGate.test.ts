/**
 * The preview's PRE-READ model gate, pinned from SOURCE (the vitest env is
 * `node`; ShaderPreview has never had a rendering test — see
 * modelDropNotices.test.ts for the pattern). The gate itself is tested for real
 * in utils/previewMesh.test.ts; this file pins that the drop path really asks
 * it, before the read, and with which argument.
 *
 * Phase 5 Step 9 (the build dialog) edits the third-argument pin below to its
 * predicate, `!isEvalMode()`: in a study session the gate stays today's.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PREVIEW = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');

/** The text of a `const name = useCallback(` … up to its first `}, [` dep list. */
function callbackBody(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at, `${name} was renamed`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('}, [', at));
}

describe('ShaderPreview: the pre-read model gate', () => {
  const load = callbackBody(PREVIEW, 'loadMeshFile');

  it('asks the ONE gate with the dropped file’s kind and size', () => {
    expect(load).toContain('preReadModelGate(detectMeshKind(file.name), file.size,');
  });

  it('asks it BEFORE the bytes are read', () => {
    const gate = load.indexOf('preReadModelGate(');
    const read = load.indexOf('file.arrayBuffer()');
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(gate);
  });

  it('no longer carries its own copy of the model cap', () => {
    expect(load).not.toContain('file.size > MESH_MAX_BYTES');
    expect(load).not.toContain('MESH_MAX_BYTES');
    expect(PREVIEW).not.toMatch(/import \{[^}]*\bMESH_MAX_BYTES\b[^}]*\} from '@\/utils\/previewMesh'/);
  });

  it('passes the OFFER predicate: never in a study session, never for a paired model, only a glTF', () => {
    expect(load).toMatch(/preReadModelGate\(detectMeshKind\(file\.name\), file\.size, offer\)/);
    // The predicate is decided BEFORE the gate and the read.
    const offerAt = load.indexOf('const offer =');
    expect(offerAt).toBeGreaterThan(-1);
    expect(offerAt).toBeLessThan(load.indexOf('preReadModelGate('));
    const offer = load.slice(offerAt, load.indexOf(';', offerAt));
    expect(offer).toContain('!isEvalMode()');
    expect(offer).toContain("opts?.offerBuild !== false");
    expect(offer).toMatch(/kind === 'glb' \|\| kind === 'gltf'/);
  });

  it('translates the gate’s refusal like every other model refusal', () => {
    expect(load).toContain('meshRefusalMessage(preRead, language)');
  });
});
