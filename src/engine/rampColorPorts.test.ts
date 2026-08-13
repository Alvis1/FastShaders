import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { effectiveRampDef, RAMP_COLOR_NODES, usesExposedPorts } from '@/utils/exposedPorts';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

/**
 * The Data Stripes / Data Viz ramp ends as wireable colour sockets.
 *
 * The property that matters most is BYTE-STABILITY: a node with nothing wired
 * must emit exactly what it always did, or every already-exported shader
 * changes. The second is the widen — a colour port is a vec3, and the dataviz
 * family's usual `.x` narrowing is exactly backwards for it.
 */
function build(nodes: AppNode[], edges: AppEdge[]) {
  return graphToCode(nodes, edges).code;
}

/** A minimal Data node → ramp node → Output chain. */
function rampGraph(type: string, extra: AppNode[] = [], extraEdges: AppEdge[] = []) {
  const sig = makeNode('sig', 'float', { value: 0.5 });
  const n = makeNode('n', type);
  const out = makeNode('out', 'output');
  return {
    nodes: [sig, n, ...extra, out],
    edges: [makeEdge('sig', 'out', 'n', 'signal'), makeEdge('n', 'out', 'out', 'color'), ...extraEdges],
  };
}

describe('ramp colour ports — registry + exposure', () => {
  it('declares the ramp ends as REAL inputs on both nodes', () => {
    // A param that lives only in defaultValues can be ticked "expose as input
    // socket" and still render nothing — ShaderNode builds sockets from
    // def.inputs. The defaultValues entry is kept too, so an unexposed node
    // still draws its inline swatch.
    for (const type of RAMP_COLOR_NODES) {
      const def = NODE_REGISTRY.get(type)!;
      const ids = def.inputs.map((i) => i.id);
      expect(ids, type).toContain('lowColor');
      expect(ids, type).toContain('highColor');
      expect(def.defaultValues?.lowColor, type).toBe('#1b2a4a');
      expect(def.inputs.find((i) => i.id === 'lowColor')!.dataType, type).toBe('color');
    }
  });

  it('opts both nodes into the exposedPorts machinery', () => {
    for (const type of RAMP_COLOR_NODES) {
      expect(usesExposedPorts(NODE_REGISTRY.get(type)), type).toBe(true);
    }
  });

  it('hides the ramp ports until exposed but NEVER hides `signal`', () => {
    for (const type of RAMP_COLOR_NODES) {
      const def = NODE_REGISTRY.get(type)!;
      const fresh = effectiveRampDef(def, []);
      expect(fresh.inputs.map((i) => i.id), type).toEqual(['signal']);

      const one = effectiveRampDef(def, ['lowColor']);
      expect(one.inputs.map((i) => i.id), type).toEqual(['signal', 'lowColor']);

      // Fully exposed returns the def UNCHANGED (identity), so the memos
      // downstream don't churn in the common case.
      expect(effectiveRampDef(def, ['lowColor', 'highColor']), type).toBe(def);
    }
    // A non-ramp node is passed straight through.
    const mul = NODE_REGISTRY.get('mul')!;
    expect(effectiveRampDef(mul, [])).toBe(mul);
  });
});

describe('ramp colour ports — emission', () => {
  it('is byte-identical to the literal form when nothing is wired', () => {
    for (const type of RAMP_COLOR_NODES) {
      const g = rampGraph(type);
      const code = build(g.nodes, g.edges);
      expect(code, type).toContain('color(0x1b2a4a)');
      expect(code, type).toContain('color(0xffd24d)');
      expect(code, type).not.toContain('vec3(color1');
    }
  });

  it('uses a wired colour instead of the stored swatch', () => {
    for (const type of RAMP_COLOR_NODES) {
      const c = makeNode('c', 'color', { hex: '#00ff00' });
      const g = rampGraph(type, [c], [makeEdge('c', 'out', 'n', 'lowColor')]);
      const code = build(g.nodes, g.edges);
      // The low end now reads the Color node's variable; the high end keeps
      // its literal.
      expect(code, type).toMatch(/mix\(color1, color\(0xffd24d\)/);
      expect(code, type).not.toContain('color(0x1b2a4a)');
    }
  });

  it('WIDENS a scalar source to vec3 rather than narrowing it with .x', () => {
    // The dataviz family narrows non-scalars with `.x` for its scalar inputs;
    // doing that to a colour would throw away two channels. And three's
    // MathNode pads/truncates mix operands silently, so a scalar endpoint would
    // make the whole ramp a scalar with no error — which the Output node then
    // splats into alpha.
    for (const type of RAMP_COLOR_NODES) {
      const f = makeNode('f', 'float', { value: 0.25 });
      const g = rampGraph(type, [f], [makeEdge('f', 'out', 'n', 'highColor')]);
      const code = build(g.nodes, g.edges);
      expect(code, type).toMatch(/mix\(color\(0x1b2a4a\), vec3\(float\d+\)/);
      expect(code, type).not.toMatch(/float\d+\.x/);
    }
  });

  it('emits the ramp with the ENDPOINTS first and the factor last', () => {
    // Not `color(lo).mix(color(hi), t)`: TSL's `.mix` puts the RECEIVER in the
    // factor slot, so the chained spelling blended using the low colour as a
    // per-channel factor and left the ramp ~constant. Pinned structurally in
    // dataVizTslContract.test.ts too.
    const g = rampGraph('dataviz');
    const code = build(g.nodes, g.edges);
    expect(code).toMatch(/= mix\(color\(0x1b2a4a\), color\(0xffd24d\), /);
    expect(code).not.toMatch(/\)\.mix\(color\(/);
  });
});
