import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * A property whose output feeds nothing emits nothing.
 *
 * It used to emit its `uniform(...)` line regardless, so an orphaned property
 * reached the module body, `export const schema` and the usage header —
 * advertising an `<a-entity shader="…; myKnob: 2">` attribute and a
 * `params.myKnob` on the exported module that cannot change a single pixel.
 * `utils/connectedUniforms.ts` was already hiding those rows from the preview's
 * Uniforms overlay for exactly that reason; this applies the same judgement at
 * the thing the overlay was compensating for.
 */
describe('an orphaned property emits nothing', () => {
  const out = () => makeNode('out', 'output');

  it('float: no consumer, no uniform line', () => {
    const { code } = graphToCode(
      [makeNode('p', 'property_float', { name: 'knob', value: 2 }), out()],
      [],
    );
    expect(code).not.toContain('knob');
    expect(code).not.toContain('uniform');
  });

  it('colour: no consumer, no uniform line', () => {
    const { code } = graphToCode(
      [makeNode('c', 'property_color', { name: 'tint', hex: '#ff8800' }), out()],
      [],
    );
    expect(code).not.toContain('tint');
    expect(code).not.toContain('uniform');
  });

  it('one consumer is enough — the test is NOT "reaches the Output"', () => {
    // Deliberately the weaker rule. A property feeding a half-built branch is
    // scaffolding, not litter, and codegen also runs on graphs that have no
    // Output node at all (see the built-ins case below), where the stronger
    // rule would delete every property they own.
    const { code } = graphToCode(
      [
        makeNode('p', 'property_float', { name: 'knob', value: 2 }),
        makeNode('m', 'mul'),
        out(),
      ],
      [makeEdge('p', 'out', 'm', 'a')],
    );
    expect(code).toContain('const knob = uniform(2);');
  });

  it('every built-in preset keeps its properties, though none has an Output node', () => {
    // buildCodeGroup strips the Output — these are sub-graphs. Under a
    // "reaches an emitting Output" rule every one of them would come out with
    // its uniforms deleted, and builtinByteStability's snapshots would all move.
    const presets = getBuiltinPresets();
    expect(presets.length).toBeGreaterThan(20);
    for (const p of presets) {
      const props = p.nodes.filter(
        (n) =>
          n.data.registryType === 'property_float' || n.data.registryType === 'property_color',
      );
      if (props.length === 0) continue;
      const { code } = graphToCode(p.nodes, p.edges);
      expect(code, `${p.id} lost its uniforms`).toContain('uniform(');
    }
  });

  it('still CLAIMS its name, so wiring it up later cannot rename the schema key', () => {
    // The pre-pass reserves the name even though nothing is emitted. Without
    // that, an ordinary node could take `speed` while the property was unwired,
    // and connecting it would silently publish `speed2` as the public key.
    const nodes = [
      makeNode('p', 'property_float', { name: 'knob', value: 2 }),
      makeNode('q', 'property_float', { name: 'knob', value: 3 }),
      makeNode('m', 'mul'),
      makeNode('out', 'output'),
    ];
    const { varNames } = graphToCode(nodes, [makeEdge('q', 'out', 'm', 'a')]);
    expect(varNames.get('p')).toBe('knob');
    expect(varNames.get('q')).toBe('knob2');
  });
});

describe('the round trip does not lose the node', () => {
  it('an orphaned property is absent from the code, so codeToGraph cannot rebuild it', () => {
    // Stated plainly because it is the whole reason useSyncEngine carries these
    // across an Apply — the code text genuinely does not contain them.
    const { code } = graphToCode(
      [
        makeNode('p', 'property_float', { name: 'knob', value: 2 }),
        makeNode('q', 'property_float', { name: 'live', value: 1 }),
        makeNode('out', 'output'),
      ],
      [makeEdge('q', 'out', 'out', 'opacity')],
    );
    const back = codeToGraph(code);
    const names = back.nodes
      .filter((n) => n.data.registryType === 'property_float')
      .map((n) => (n.data as { values?: Record<string, unknown> }).values?.name);
    expect(names).toEqual(['live']);
  });

  it('useSyncEngine carries the orphan across the resync', () => {
    // A source pin: useSyncEngine is a React hook and the vitest env is `node`,
    // so the behaviour cannot be driven here. What CAN be pinned is that the
    // carry exists, that it is precise about why the node is missing (no
    // consumer + not in the parse), and that it reads UNWRAPPED edges — a raw
    // read would treat a property feeding out of a COLLAPSED group as an orphan
    // and duplicate a node the parse legitimately produced.
    const src = readFileSync(
      fileURLToPath(new URL('../hooks/useSyncEngine.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/orphanProps/);
    expect(src).toMatch(/hasConsumer/);
    expect(src).toMatch(/realOldEdges = unwrapCollapsedGroupEdges\(oldNodes, oldEdges\)/);
    expect(src).toMatch(/!survivingIds\.has\(n\.id\)/);
  });
});
