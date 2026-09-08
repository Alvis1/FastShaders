import { describe, it, expect } from 'vitest';
import { migrateLegacyNodeTypes, LEGACY_NODE_TYPES } from './legacyNodeTypes';
import { NODE_REGISTRY, getFlowNodeType } from './nodeRegistry';
import { graphToCode } from '@/engine/graphToCode';
import { getNodeValues } from '@/types';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

/**
 * THE AUDIO FOLD (2026-09-08): a graph holding the retired `audioInput` node
 * must come back as a Sound node — same wiring, same stored settings, drawn by
 * the same component, emitting the `mic*` uniforms.
 *
 * This is the one migration in the table that also changes `flow`, and it is
 * the only one whose failure is SILENT. The SDF folds (`sdBox2`, `smoothUnion`,
 * …) are covered by engine/sdfModes.test.ts, where a missed migration shows up
 * immediately as an unknown node and broken codegen. Here every failure mode
 * still renders something:
 *
 *   - miss the migration and the node keeps `registryType: 'audioInput'`, which
 *     resolves to no definition at all;
 *   - miss the `flow` half and `node.type` stays `'audio'`, a React Flow type
 *     nothing registers any more — React Flow silently falls back to its own
 *     default node, a bare white box with top/bottom handles, and the shader
 *     goes on compiling around it;
 *   - miss the values or the edges and the shader compiles, renders, and simply
 *     stops reacting to sound.
 *
 * The file that used to hold these assertions was engine/audioInputNode.test.ts,
 * which pinned the two nodes' uniform bases as DISJOINT. That claim died with
 * the fold — there is one base now, pinned in utils/soundAnalysis.test.ts — so
 * the emission assertions worth keeping moved here, aimed at the migrated node.
 */

/** An `audioInput` node exactly as a pre-fold `.fastshader` would carry it. */
function legacyAudioNode(id: string, values: Record<string, string | number> = {}): AppNode {
  const n = makeNode(id, 'audioInput', { smoothing: 0.8, gain: 1, fftSize: 1024, ...values });
  // makeNode's `type` convention predates the flow types this fold rewrites, so
  // spell out the one a pre-fold graph really holds — that is the field the
  // migration has to fix, and starting from 'shader' would let a broken
  // migration pass by accident.
  return { ...n, type: 'audio' } as unknown as AppNode;
}

describe('the audio fold — audioInput becomes the Sound node', () => {
  it('rewrites the registry type', () => {
    const [n] = migrateLegacyNodeTypes([legacyAudioNode('a1')]);
    expect(n.data.registryType).toBe('soundNode');
    expect(NODE_REGISTRY.get('soundNode')).toBeTruthy();
  });

  it('rewrites the React Flow type to the component that still exists', () => {
    // Without this the node renders as React Flow's default box. `mic` is not
    // a literal chosen here: it is what the registry itself says draws a
    // soundNode, so the migration cannot drift from the component dispatch.
    const before = legacyAudioNode('a1');
    expect(before.type, 'the fixture must start on the retired flow type').toBe('audio');
    const [n] = migrateLegacyNodeTypes([before]);
    expect(n.type).toBe('sound');
    expect(n.type).toBe(getFlowNodeType(NODE_REGISTRY.get('soundNode')!));
  });

  it('keeps the analyser settings the user had tuned', () => {
    // The two defs were identical in ports and defaults, so nothing needs
    // translating — but a migration that dropped `values` would silently reset
    // gain and smoothing to their defaults on load.
    const [n] = migrateLegacyNodeTypes([legacyAudioNode('a1', { gain: 2.5, smoothing: 0.3 })]);
    expect(getNodeValues(n)).toEqual({ gain: 2.5, smoothing: 0.3, fftSize: 1024 });
  });

  it('leaves every edge untouched, because the port ids were kept', () => {
    // Migration rewrites nodes only; the edges array is the caller's. This pins
    // the reason that is safe — both defs declared the same four output ids and
    // the same two param ids, so no edge can be left pointing at a socket the
    // surviving node lacks.
    const micDef = NODE_REGISTRY.get('soundNode')!;
    const ports = [...micDef.outputs.map((p) => p.id), ...micDef.inputs.map((p) => p.id)];
    expect(ports).toEqual(['level', 'bass', 'mid', 'treble', 'smoothing', 'gain']);
  });

  it('returns the SAME array when there is nothing to migrate', () => {
    // Identity is load-bearing on the restore paths: the autosave subscriber
    // and selectionOnlyGraphChange compare by reference.
    const clean = [makeNode('m1', 'soundNode'), makeNode('out', 'output')];
    expect(migrateLegacyNodeTypes(clean)).toBe(clean);
  });

  it('normalizes a tampered `values` instead of spreading junk keys out of it', () => {
    // This runs on every restore path, so it is one of the first things to
    // touch a graph out of a `.fastshader` / `fs:graph` / `fs:savedGroups`,
    // where `values` is attacker-shaped. The migration must go through
    // `getNodeValues`, which answers `{}` for anything that is not a plain
    // object — a raw `{ ...n.data.values }` does not throw, which is exactly
    // why this is easy to get wrong: it SUCCEEDS and produces indexed
    // character keys (`{...'ab'}` is `{0:'a',1:'b'}`, `{...['x']}` is
    // `{0:'x'}`), so the node loads carrying invented settings.
    for (const junk of [5, 'ab', ['x'], null, true]) {
      const poisoned = legacyAudioNode('a1');
      (poisoned.data as { values: unknown }).values = junk;
      const [n] = migrateLegacyNodeTypes([poisoned]);
      expect(n.data.registryType, String(junk)).toBe('soundNode');
      expect(getNodeValues(n), String(junk)).toEqual({});
    }
  });
});

describe('a migrated node emits as a Sound node', () => {
  /** Migrate first, exactly as every restore path does, then compile. */
  function compileLegacy(channels: string[], values: Record<string, string | number> = {}) {
    const nodes = migrateLegacyNodeTypes([legacyAudioNode('a1', values), makeNode('out', 'output')]);
    const edges = channels.map((ch) => makeEdge('a1', ch, 'out', 'color'));
    return graphToCode(nodes, edges);
  }

  it('emits the mic base, and never the retired `aud` one', () => {
    // `sound1_bass` is the persisted contract — it is inside every module the app
    // has exported and inside podest's own SOUND_RE. A migrated node joining the
    // same counter (mic1, not aud1) is what makes a pre-fold shader keep
    // working after a reload.
    const { code } = compileLegacy(['bass']);
    expect(code).toContain('const sound1_bass = uniform(0);');
    expect(code).not.toContain('aud1');
    expect(code).not.toContain('audioInput');
  });

  it('emits one uniform per CONSUMED channel, in socket order', () => {
    const { code } = compileLegacy(['treble', 'level']);
    const iLevel = code.indexOf('sound1_level');
    const iTreble = code.indexOf('sound1_treble');
    expect(iLevel).toBeGreaterThan(-1);
    expect(iTreble).toBeGreaterThan(iLevel);
    // Unwired channels must not ship: they would become dead sliders in the
    // exported schema and in podest's auto-generated uniform list.
    expect(code).not.toContain('sound1_bass');
    expect(code).not.toContain('sound1_mid');
  });

  it('applies a stored gain as a SEPARATE statement', () => {
    // Folding the multiply into `uniform(0).mul(g)` stops buildShaderModule's
    // whole-line `uniformLineRe` matching, which drops the export schema
    // property AND the live uniform binding.
    const { code } = compileLegacy(['bass'], { gain: 2 });
    expect(code).toContain('const sound1_bass = uniform(0);');
    expect(code).toContain('const _sound1_bass = sound1_bass.mul(2);');
  });

  it('is byte-identical to a graph authored as a Sound node today', () => {
    // The strongest statement available: after migration there is no trace of
    // where the node came from, so a pre-fold file and a fresh one produce the
    // same module rather than merely equivalent ones.
    const migrated = compileLegacy(['level'], { gain: 2 }).code;
    const native = graphToCode(
      [makeNode('a1', 'soundNode', { smoothing: 0.8, gain: 2, fftSize: 1024 }), makeNode('out', 'output')],
      [makeEdge('a1', 'level', 'out', 'color')],
    ).code;
    expect(migrated).toBe(native);
  });
});

describe('the fold table stays coherent', () => {
  it('every legacy type maps onto a definition that exists', () => {
    for (const [from, to] of LEGACY_NODE_TYPES) {
      expect(NODE_REGISTRY.get(to.type), `${from} → ${to.type}`).toBeTruthy();
    }
  });

  it('no legacy type is still a live definition', () => {
    // A folded type that came back as its own def would make the migration
    // silently destructive — it would rewrite a node the registry can resolve.
    for (const from of LEGACY_NODE_TYPES.keys()) {
      expect(NODE_REGISTRY.get(from), from).toBeUndefined();
    }
  });

  it('declares `flow` exactly where the fold changes which component draws it', () => {
    // `node.type` is persisted, so omitting `flow` on a fold that crosses
    // components leaves a node rendering through one that no longer exists;
    // declaring it where the component is unchanged would be noise that later
    // reads as meaningful.
    for (const [from, to] of LEGACY_NODE_TYPES) {
      const flow = getFlowNodeType(NODE_REGISTRY.get(to.type)!);
      // Every SDF fold is shader → shader; the audio fold is the one that moves.
      const crossesComponents = from === 'audioInput';
      expect(to.flow, from).toBe(crossesComponents ? flow : undefined);
    }
  });
});
