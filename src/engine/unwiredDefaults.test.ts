import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { getAllDefinitions, NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * What every node emits when the user drops it and wires NOTHING.
 *
 * This is the state a half-built graph spends most of its life in, and it was
 * unguarded: `resolveArguments` falls back to the bare string '0' for any input
 * with no `defaultValues` entry, so a node could emit an argument its function
 * is not defined at. Found this way, in ascending order of damage:
 *   clamp(x, 0, 0)          → output pinned to the constant 0
 *   remap(x, 0, 0, 0, 0)    → (x-0)/(0-0), a division by zero
 *   hsl(0, 0, 0)            → black, beside a node card showing red
 *   mix(0, 0, 0)            → constant 0, and a wired B was discarded
 *   log2(0)                 → -Infinity, and a hard WGSL compile error
 *   smoothstep(0, 0, x)     → undefined in GLSL, a hard WGSL compile error
 *
 * The assertions below state the RULE ("log2's argument is never 0") rather
 * than the current numbers, so they keep their meaning if a default is retuned.
 */

/** Emit one unwired node, wired only to Output.color. */
function emitBare(type: string): string {
  const n = makeNode('n', type);
  const out = makeNode('out', 'output');
  return graphToCode([n, out], [makeEdge('n', 'out', 'out', 'color')]).code;
}

/** The emitted argument list of `call(...)`, or null when absent. */
function argsOf(code: string, call: string): string[] | null {
  const m = new RegExp(`\\b${call}\\(([^)]*)\\)`).exec(code);
  return m ? m[1].split(',').map((a) => a.trim()) : null;
}

describe('a freshly dropped node never emits a toxic argument', () => {
  it('log2 is never called at 0 (-Infinity, and WGSL rejects it outright)', () => {
    const args = argsOf(emitBare('log2'), 'log2');
    expect(args).not.toBeNull();
    expect(Number(args![0])).not.toBe(0);
  });

  it('smoothstep never gets edge0 === edge1 (undefined in GLSL, a WGSL error)', () => {
    const args = argsOf(emitBare('smoothstep'), 'smoothstep');
    expect(args).not.toBeNull();
    expect(args![0]).not.toBe(args![1]);
  });

  it('hsl gets a non-zero saturation AND lightness (either alone forces black)', () => {
    const args = argsOf(emitBare('hsl'), 'hsl');
    expect(args).not.toBeNull();
    expect(Number(args![1])).not.toBe(0);
    expect(Number(args![2])).not.toBe(0);
  });

  it('mix keeps a non-zero endpoint, so a wired Factor still does something', () => {
    const args = argsOf(emitBare('mix'), 'mix');
    expect(args).not.toBeNull();
    // mix(a, b, t) with a === b renders a constant whatever t is.
    expect(args![0]).not.toBe(args![1]);
  });

  it('clamp never gets min === max (that pins the output to a constant)', () => {
    const args = argsOf(emitBare('clamp'), 'clamp');
    expect(args).not.toBeNull();
    expect(args![1]).not.toBe(args![2]);
  });

  it('remap never gets inLow === inHigh (a division by zero)', () => {
    const args = argsOf(emitBare('remap'), 'remap');
    expect(args).not.toBeNull();
    expect(args![1]).not.toBe(args![2]);
  });
});

describe('the unwired emission of every node is pinned', () => {
  // A snapshot over the whole registry, so ANY future default change shows up
  // in review as a diff rather than silently altering what a dropped node does.
  it('matches the recorded per-type emission', () => {
    const emissions: Record<string, string> = {};
    for (const def of getAllDefinitions()) {
      if (def.inputs.length === 0) continue;
      // Hand-emitted branches (dataviz family, image/data/mic) and the Output
      // node never reach resolveArguments; they carry their own substitution
      // rules and are covered by their own suites.
      if (!def.tslFunction) continue;
      const code = emitBare(def.type);
      const line = code.split('\n').find((l) => l.includes(`const ${def.type}1`));
      emissions[def.type] = (line ?? '(not emitted)').trim();
    }
    expect(emissions).toMatchSnapshot();
  });
});

describe('every declared default is a finite number codegen can emit', () => {
  it('has no NaN, no Infinity, and no stray string outside the documented ones', () => {
    // `resolveArguments` coerces with Number() and drops anything non-finite to
    // the registry default and then to '0', so a non-numeric default is a
    // silent no-op. The two documented exceptions are the noise `pos`
    // identifier and the colour hexes on the dataviz ramp ends.
    const STRING_OK = new Set(['pos', 'lowColor', 'highColor', 'name', 'hex']);
    for (const def of getAllDefinitions()) {
      for (const [key, value] of Object.entries(def.defaultValues ?? {})) {
        if (typeof value === 'string') {
          expect(STRING_OK.has(key), `${def.type}.${key} is a string`).toBe(true);
          continue;
        }
        expect(Number.isFinite(value), `${def.type}.${key}`).toBe(true);
      }
    }
  });

  it('declares defaults only for ports the node actually has', () => {
    // A key that is not an input id is appended by buildRows as an EXTRA row,
    // which is how a typo becomes a phantom widget. The noise family and Time
    // are the documented exceptions: there, defaultValues IS the socket list.
    const SOCKET_LIST_NODES = new Set(['time', 'micNode']);
    for (const def of getAllDefinitions()) {
      if (def.category === 'noise' || SOCKET_LIST_NODES.has(def.type)) continue;
      const ids = new Set(def.inputs.map((i) => i.id));
      for (const key of Object.keys(def.defaultValues ?? {})) {
        if (NODE_REGISTRY.get(def.type)?.tslFunction === '') continue; // hand-emitted
        // Constructor-argument keys, not ports: the generic
        // `inputs.length === 0 && defaultValues` branch emits
        // `<tslFunction>(<first key>)`. `index` is vertexColor's colour-set
        // argument and is the very thing that keeps it OFF the bare-reference
        // branch (which would emit an uncalled function reference and render
        // black) — see the comment on its registry def.
        if (['name', 'hex', 'value', 'min', 'max', 'signed', 'index'].includes(key)) continue;
        expect(ids.has(key), `${def.type}.${key} is not an input port`).toBe(true);
      }
    }
  });
});
