import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { tslToShaderModule } from './tslToShaderModule';
import { codeToGraph } from './codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';
import { liveAudioVarBaseOf, MIC_VAR_BASE, AUDIO_VAR_BASE } from '@/utils/micAnalysis';

/**
 * The Audio Input node emits the SAME shape as the Mic node — four
 * `uniform(0)` lines — and differs only in its variable base. These tests pin
 * the two things that follow from that:
 *
 *   1. everything micNode.test.ts proves about the mic holds here too, so the
 *      shared emission branch cannot regress for one node and not the other;
 *   2. the two bases stay DISTINCT and a graph holding both nodes keeps them
 *      separable, which is what lets the preview pump drive each from its own
 *      capture. A regression there is silent: the shader still compiles, still
 *      renders, and simply reacts to the wrong sound.
 */

function audioGraph(channels: string[], values: Record<string, unknown> = {}) {
  const aud = makeNode('a1', 'audioInput', { smoothing: 0.8, gain: 1, fftSize: 1024, ...values });
  const out = makeNode('out', 'output');
  return { nodes: [aud, out], edges: channels.map((ch) => makeEdge('a1', ch, 'out', 'color')) };
}

describe('graphToCode — audio input emission', () => {
  it('emits one numeric uniform per CONSUMED channel, named aud1_<channel>', () => {
    const { nodes, edges } = audioGraph(['bass']);
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const aud1_bass = uniform(0);');
    // Unwired channels must not ship: they would become dead sliders in the
    // exported schema and in podest's auto-generated uniform list.
    expect(code).not.toContain('aud1_level');
    expect(code).not.toContain('aud1_mid');
    expect(code).not.toContain('aud1_treble');
  });

  it('emits channels in socket order regardless of edge order', () => {
    const { nodes, edges } = audioGraph(['treble', 'level']);
    const { code } = graphToCode(nodes, edges);
    const iLevel = code.indexOf('aud1_level');
    const iTreble = code.indexOf('aud1_treble');
    expect(iLevel).toBeGreaterThan(-1);
    expect(iTreble).toBeGreaterThan(iLevel);
  });

  it('requests the `uniform` import even though tslFunction is empty', () => {
    const { nodes, edges } = audioGraph(['level']);
    const { importStatements } = graphToCode(nodes, edges);
    expect(importStatements.join('\n')).toContain('uniform');
  });

  it('emits nothing at all for an unwired node', () => {
    const aud = makeNode('a1', 'audioInput', {});
    const out = makeNode('out', 'output');
    const { code } = graphToCode([aud, out], []);
    expect(code).not.toContain('aud1');
    expect(code).not.toContain('uniform(');
  });

  it('does not fall through to the generic defaultValues constructor branch', () => {
    // The branch below this one would emit `audioInput(0.8)` from the analyser
    // settings — the trap the Time node documents.
    const { nodes, edges } = audioGraph(['level']);
    const { code } = graphToCode(nodes, edges);
    expect(code).not.toMatch(/audioInput\s*\(/);
    expect(code).not.toContain('(0.8)');
  });

  it('applies gain as a SEPARATE statement so the uniform line stays bare', () => {
    // Folding the multiply into `uniform(0).mul(g)` stops buildShaderModule's
    // whole-line `uniformLineRe` matching, which drops the export schema
    // property AND the live uniform binding.
    const { nodes, edges } = audioGraph(['bass'], { gain: 2 });
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const aud1_bass = uniform(0);');
    expect(code).toContain('const _aud1_bass = aud1_bass.mul(2);');
  });

  it('emits byte-identically to the ungained form at gain 1', () => {
    const plain = graphToCode(...Object.values(audioGraph(['bass'])) as [never, never]).code;
    const gain1 = graphToCode(...Object.values(audioGraph(['bass'], { gain: 1 })) as [never, never]).code;
    expect(gain1).toBe(plain);
    expect(plain).not.toContain('_aud1_bass');
  });
});

describe('the two live-audio nodes stay separable', () => {
  /**
   * The load-bearing one. Both nodes in one graph must emit two INDEPENDENT
   * sets of uniforms, because the preview pump routes them to two different
   * captures by prefix. If they ever shared a base, this graph would compile
   * and render exactly as before while one node's sound drove the other's
   * uniforms — a failure with no error anywhere.
   */
  it('emits disjoint uniform names for a graph holding both', () => {
    const mic = makeNode('m1', 'micNode', {});
    const aud = makeNode('a1', 'audioInput', {});
    const out = makeNode('out', 'output');
    const { code } = graphToCode(
      [mic, aud, out],
      [makeEdge('m1', 'bass', 'out', 'color'), makeEdge('a1', 'bass', 'out', 'emissive')],
    );
    expect(code).toContain('const mic1_bass = uniform(0);');
    expect(code).toContain('const aud1_bass = uniform(0);');
    // Each Output channel reads its OWN node's uniform.
    expect(code).toMatch(/color:\s*vec3\(mic1_bass\)/);
    expect(code).toMatch(/emissive:\s*vec3\(aud1_bass\)/);
  });

  it('routes every emitted name back to the node that produced it', () => {
    const mic = makeNode('m1', 'micNode', {});
    const aud = makeNode('a1', 'audioInput', {});
    const out = makeNode('out', 'output');
    const { code } = graphToCode(
      [mic, aud, out],
      [makeEdge('m1', 'level', 'out', 'color'), makeEdge('a1', 'level', 'out', 'emissive')],
    );
    const names = [...code.matchAll(/const ((?:mic|aud)\d*_\w+) = uniform\(/g)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    expect(names.map(liveAudioVarBaseOf).sort()).toEqual([AUDIO_VAR_BASE, MIC_VAR_BASE].sort());
  });

  it('numbers the two node kinds independently', () => {
    // Separate bases mean separate counters: the first of each is `1`.
    const mic = makeNode('m1', 'micNode', {});
    const aud = makeNode('a1', 'audioInput', {});
    const out = makeNode('out', 'output');
    const { code } = graphToCode(
      [mic, aud, out],
      [makeEdge('m1', 'bass', 'out', 'color'), makeEdge('a1', 'bass', 'out', 'emissive')],
    );
    expect(code).toContain('mic1_bass');
    expect(code).toContain('aud1_bass');
    expect(code).not.toContain('aud2_');
    expect(code).not.toContain('mic2_');
  });
});

describe('name claiming', () => {
  /**
   * The node emits `<var>_<channel>` identifiers, not `<var>`, so claiming only
   * the base would leave `aud1_bass` free for a user property to take — and the
   * duplicate `const` is a SyntaxError that kills the WHOLE module, not just
   * this node.
   */
  it('reserves each emitted channel against a same-named user property', () => {
    const aud = makeNode('a1', 'audioInput', {});
    const prop = makeNode('p1', 'property_float', { name: 'aud1_bass', value: 3 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode(
      [prop, aud, out],
      [makeEdge('a1', 'bass', 'out', 'color'), makeEdge('p1', 'out', 'out', 'roughness')],
    );
    const decls = [...code.matchAll(/const (\w+) = uniform\(/g)].map((m) => m[1]);
    expect(new Set(decls).size).toBe(decls.length);
  });

  it('reserves the GAINED twin too', () => {
    // `_aud1_bass` shares the Fn-body namespace with the uniform itself.
    const aud = makeNode('a1', 'audioInput', { gain: 2 });
    const prop = makeNode('p1', 'property_float', { name: '_aud1_bass', value: 3 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode(
      [prop, aud, out],
      [makeEdge('a1', 'bass', 'out', 'color'), makeEdge('p1', 'out', 'out', 'roughness')],
    );
    const decls = [...code.matchAll(/const (\w+) =/g)].map((m) => m[1]);
    expect(new Set(decls).size).toBe(decls.length);
  });
});

describe('exported module', () => {
  it('becomes a real number schema property', () => {
    const { nodes, edges } = audioGraph(['level']);
    const mod = tslToShaderModule(graphToCode(nodes, edges).code);
    expect(mod).toMatch(/aud1_level:\s*\{[^}]*type:\s*'number'/);
    expect(mod).toContain('params.aud1_level');
  });

  it('names the properties and the capture caveat in the header', () => {
    const { nodes, edges } = audioGraph(['bass']);
    const mod = tslToShaderModule(graphToCode(nodes, edges).code);
    expect(mod).toContain('LIVE AUDIO INPUT — this file does NOT capture audio.');
    expect(mod).toContain('aud1_bass');
    // The `aud*` path needs getDisplayMedia, which the mic snippet alone does
    // not show — an embedder following only that would capture the wrong sound.
    expect(mod).toContain('getDisplayMedia');
  });

  /** The downloaded file must never itself open a capture. */
  it('contains no capture call of its own', () => {
    const { nodes, edges } = audioGraph(['level']);
    const mod = tslToShaderModule(graphToCode(nodes, edges).code);
    const executable = mod.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(executable).not.toContain('getUserMedia');
    expect(executable).not.toContain('getDisplayMedia');
  });
});

describe('code-panel Apply degradation', () => {
  /**
   * One-way through codeToGraph (empty tslFunction), exactly like the Mic node:
   * an Apply demotes it to ordinary float properties. The shader keeps
   * rendering and no error appears, but the node stops driving it. Pinned as a
   * KNOWN shape so a change is a visible diff rather than a surprise.
   */
  it('re-parses as plain property nodes', () => {
    const { nodes, edges } = audioGraph(['level']);
    const { code } = graphToCode(nodes, edges);
    const parsed = codeToGraph(code);
    expect(parsed.nodes.some((n) => n.data.registryType === 'audioInput')).toBe(false);
    expect(parsed.nodes.some((n) => n.data.registryType === 'property_float')).toBe(true);
  });
});
