import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { tslToShaderModule } from './tslToShaderModule';
import { codeToGraph } from './codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';
import { effectiveExposedPorts, SOUND_DEFAULT_EXPOSED } from '@/utils/exposedPorts';

/**
 * The Sound node's whole design rests on one claim: emitting `uniform(0)` means
 * the value rides the EXISTING fs:uniform channel in the preview AND becomes a
 * real `{type:'number'}` schema property in the downloaded module, with no new
 * transport and no shaderloader change. These tests pin that claim end to end —
 * a change that quietly breaks it would otherwise only show up as a shader that
 * silently stops reacting.
 *
 * The node is called "Sound" and hears a microphone, another input device or
 * the machine's own audio (the Audio Input node was folded into it on
 * 2026-09-08). Every `mic` identifier below is the RETAINED CONTRACT, not a
 * stale name: `soundNode` is the key inside every saved `.fastshader`, and the
 * `sound1_*` uniform base is inside every module the app has ever exported and
 * inside podest's own `SOUND_RE`. Renaming either would orphan existing work for
 * a cosmetic gain, so the assertions spell them out on purpose.
 */

function micGraph(channels: string[]) {
  const mic = makeNode('m1', 'soundNode', { smoothing: 0.8, gain: 1, fftSize: 1024 });
  const out = makeNode('out', 'output');
  const nodes = [mic, out];
  const edges = channels.map((ch) => makeEdge('m1', ch, 'out', 'color'));
  return { nodes, edges };
}

describe('graphToCode — Sound node emission', () => {
  it('emits one numeric uniform per CONSUMED channel, named <var>_<channel>', () => {
    const { nodes, edges } = micGraph(['bass']);
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const sound1_bass = uniform(0);');
    // Unwired channels must not ship: they would become dead sliders in the
    // exported schema and in podest's auto-generated uniform list.
    expect(code).not.toContain('sound1_level');
    expect(code).not.toContain('sound1_mid');
    expect(code).not.toContain('sound1_treble');
  });

  it('emits channels in socket order regardless of edge order', () => {
    const { nodes, edges } = micGraph(['treble', 'level']);
    const { code } = graphToCode(nodes, edges);
    const iLevel = code.indexOf('sound1_level');
    const iTreble = code.indexOf('sound1_treble');
    expect(iLevel).toBeGreaterThan(-1);
    expect(iTreble).toBeGreaterThan(iLevel);
  });

  it('requests the `uniform` import even though tslFunction is empty', () => {
    // The generic import collector keys off def.tslFunction, which is '' here,
    // so a missing explicit addImport would emit a ReferenceError module.
    const { nodes, edges } = micGraph(['level']);
    const { importStatements } = graphToCode(nodes, edges);
    expect(importStatements.join('\n')).toContain('uniform');
  });

  it('emits nothing at all for an unwired Sound node', () => {
    const mic = makeNode('m1', 'soundNode', {});
    const out = makeNode('out', 'output');
    const { code } = graphToCode([mic, out], []);
    expect(code).not.toContain('mic1');
    expect(code).not.toContain('uniform(');
  });

  it('does NOT emit a constructor call from the generic defaultValues branch', () => {
    // soundNode has defaultValues (the analyser settings) and an empty
    // tslFunction, so the generic `inputs.length === 0 && defaultValues` branch
    // would emit `(0.8)` — the exact trap the Time node's branch ordering
    // exists to avoid.
    const { nodes, edges } = micGraph(['level']);
    const { code } = graphToCode(nodes, edges);
    expect(code).not.toMatch(/=\s*\(0\.8\)/);
    expect(code).not.toContain('(1024)');
  });

  it('gives each Sound node its own variable base', () => {
    const a = makeNode('m1', 'soundNode', {});
    const b = makeNode('m2', 'soundNode', {});
    const out = makeNode('out', 'output');
    const edges = [makeEdge('m1', 'level', 'out', 'color'), makeEdge('m2', 'level', 'out', 'opacity')];
    const { code } = graphToCode([a, b, out], edges);
    expect(code).toContain('const sound1_level = uniform(0);');
    expect(code).toContain('const sound2_level = uniform(0);');
  });

  it('resolves a hand-edited/unknown source handle to a variable that EXISTS', () => {
    // `.fastshader` files are adversarial, so a bogus sourceHandle must not
    // produce a reference to an undeclared variable (a module-load
    // ReferenceError = blank preview, no useful message). Emitter and resolver
    // share micChannelForHandle, which falls back to `level`.
    const mic = makeNode('m1', 'soundNode', {});
    const out = makeNode('out', 'output');
    const { code } = graphToCode([mic, out], [makeEdge('m1', 'bogus', 'out', 'color')]);
    expect(code).toContain('const sound1_level = uniform(0);');
    expect(code).not.toContain('sound1_bogus');
  });

  it('never declares the same const twice when a property is NAMED like a sound uniform', () => {
    // A property's name is user-controlled and is claimed FIRST (bareFirst), so
    // without alias reservation the Sound node would happily claim base `mic1`
    // and emit `const sound1_bass = uniform(0);` next to the property's own
    // `const sound1_bass = uniform(0.5);` — a duplicate declaration, i.e. a
    // SyntaxError that fails the WHOLE module, not just this node.
    const prop = makeNode('p', 'property_float', { name: 'sound1_bass', value: 0.5 });
    const mic = makeNode('m1', 'soundNode', {});
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('p', 'out', 'out', 'opacity'),
      makeEdge('m1', 'bass', 'out', 'color'),
    ];
    const { code } = graphToCode([prop, mic, out], edges);

    const declared = [...code.matchAll(/\bconst\s+(\w+)\s*=/g)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(declared.length);
    // The property keeps the name it asked for; the Sound node moves aside.
    expect(code).toContain('const sound1_bass = uniform(0.5);');
    expect(code).toContain('const sound2_bass = uniform(0);');
  });

  it('reserves aliases only for channels it actually emits', () => {
    // Claiming all four unconditionally would push the base along for names
    // the node is never going to declare.
    const prop = makeNode('p', 'property_float', { name: 'sound1_treble', value: 0.25 });
    const mic = makeNode('m1', 'soundNode', {});
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('p', 'out', 'out', 'opacity'),
      makeEdge('m1', 'bass', 'out', 'color'),
    ];
    const { code } = graphToCode([prop, mic, out], edges);
    // `sound1_bass` is free, so the Sound node keeps base `mic1`.
    expect(code).toContain('const sound1_bass = uniform(0);');
    const declared = [...code.matchAll(/\bconst\s+(\w+)\s*=/g)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('widens a scalar sound channel to vec3 on an alpha-bearing channel', () => {
    // A 1-channel source on Color splats across all four components, so the
    // level would silently become diffuseColor.a and the surface would vanish.
    const { nodes, edges } = micGraph(['level']);
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('vec3(sound1_level)');
  });
});

describe('Sound node — exported module', () => {
  it('becomes a real number property in the schema, driveable by a host page', () => {
    const { nodes, edges } = micGraph(['level', 'bass']);
    const { code } = graphToCode(nodes, edges);
    const mod = tslToShaderModule(code);

    // The schema entry is what makes the download useful: on an A-Frame page
    // these are ordinary a-entity properties, indistinguishable from a user's
    // own sliders, applied by shaderloader 0.5 with no recompile.
    expect(mod).toMatch(/sound1_level:\s*\{[^}]*type:\s*'number'/);
    expect(mod).toMatch(/sound1_bass:\s*\{[^}]*type:\s*'number'/);
    // Default 0 = silence, so an undriven download renders a defined state.
    expect(mod).toMatch(/sound1_level:\s*\{[^}]*default:\s*0/);
    // And the body must read the param, not the literal.
    expect(mod).toContain('params.sound1_level');

    // Nothing CAPTURES audio in the exported file — that is deliberate, and it
    // is what keeps a shared shader from opening a recipient's microphone on a
    // page FastShaders does not control. Comment lines are excluded because the
    // header deliberately DOCUMENTS the capture snippet a host page would need.
    const executable = mod
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(executable).not.toContain('getUserMedia');
    expect(executable).not.toContain('AudioContext');
    expect(executable).not.toContain('createAnalyser');
  });

  it('names the sound properties and the secure-context caveat in the header', () => {
    // An undriven download renders as permanent silence with no error, so the
    // file has to explain itself — naming the actual properties, not just
    // "this uses a microphone".
    const { nodes, edges } = micGraph(['bass']);
    const mod = tslToShaderModule(graphToCode(nodes, edges).code);
    expect(mod).toContain('LIVE AUDIO INPUT — this file does NOT capture audio.');
    expect(mod).toContain('sound1_bass');
    expect(mod).toContain('secure context');
  });

  it('adds no microphone header to a shader without a Sound node', () => {
    const color = makeNode('c', 'color', { hex: '#ff8800' });
    const out = makeNode('out', 'output');
    const mod = tslToShaderModule(
      graphToCode([color, out], [makeEdge('c', 'out', 'out', 'color')]).code,
    );
    expect(mod).not.toContain('LIVE AUDIO INPUT');
  });
});

describe('Sound node — code-panel Apply degradation (KNOWN SHAPE)', () => {
  it('re-parses as plain property nodes, not a Sound node', () => {
    // The Sound node is one-way through codeToGraph (empty tslFunction), so an
    // Apply demotes it to ordinary float properties: the shader keeps
    // rendering and no error appears, but the mic stops driving it. Pinned
    // here so the degradation is a documented shape rather than a surprise —
    // if this ever starts round-tripping, that is a deliberate improvement and
    // this test should be updated, not deleted.
    const { nodes, edges } = micGraph(['level']);
    const { code } = graphToCode(nodes, edges);
    const parsed = codeToGraph(code);
    expect(parsed.nodes.some((n) => n.data.registryType === 'soundNode')).toBe(false);
    expect(parsed.nodes.some((n) => n.data.registryType === 'property_float')).toBe(true);
  });
});

describe('Sound node — gain as an exposed input', () => {
  it('emits the bare uniform unchanged when gain is 1 and unwired', () => {
    const { nodes, edges } = micGraph(['bass']);
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const sound1_bass = uniform(0);');
    expect(code).not.toContain('_sound1_bass');
  });

  it('applies a stored gain as a SEPARATE statement, keeping the uniform line bare', () => {
    // Folding it into `uniform(0).mul(2)` would stop uniformLineRe matching,
    // which silently drops the schema property AND unbinds the live uniform.
    const mic = makeNode('m1', 'soundNode', { gain: 2 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([mic, out], [makeEdge('m1', 'bass', 'out', 'color')]);
    expect(code).toContain('const sound1_bass = uniform(0);');
    expect(code).toContain('const _sound1_bass = sound1_bass.mul(2);');
    // Downstream must read the SCALED value.
    expect(code).toContain('vec3(_sound1_bass)');
  });

  it('keeps the export schema property when gain is applied', () => {
    const mic = makeNode('m1', 'soundNode', { gain: 3 });
    const out = makeNode('out', 'output');
    const mod = tslToShaderModule(
      graphToCode([mic, out], [makeEdge('m1', 'level', 'out', 'color')]).code,
    );
    expect(mod).toMatch(/sound1_level:\s*\{[^}]*type:\s*'number'/);
    expect(mod).toContain('params.sound1_level');
  });

  it('lets a wired gain edge override the stored number', () => {
    const mic = makeNode('m1', 'soundNode', { gain: 2 });
    const speed = makeNode('t', 'time', {});
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('t', 'out', 'm1', 'gain'),
      makeEdge('m1', 'bass', 'out', 'color'),
    ];
    const { code } = graphToCode([speed, mic, out], edges);
    expect(code).toContain('const _sound1_bass = sound1_bass.mul(time1);');
    expect(code).not.toContain('sound1_bass.mul(2)');
  });

  it('clamps an adversarial stored gain instead of emitting it verbatim', () => {
    const mic = makeNode('m1', 'soundNode', { gain: 1e9 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([mic, out], [makeEdge('m1', 'bass', 'out', 'color')]);
    expect(code).not.toContain('1000000000');
    expect(code).toContain('const _sound1_bass = sound1_bass.mul(8);');
  });

  it('survives a self-looping gain edge without recursing forever', () => {
    // The editor never offers a cycle, but a hand-edited .fastshader can.
    // topologicalSort already drops nodes in a cycle, so the Sound node simply
    // does not reach emission and the shader falls back — what matters is that
    // resolving the gain does not re-enter resolveEdgeRef on the same node.
    const mic = makeNode('m1', 'soundNode', { gain: 2 });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('m1', 'level', 'm1', 'gain'),
      makeEdge('m1', 'bass', 'out', 'color'),
    ];
    expect(() => graphToCode([mic, out], edges)).not.toThrow();
    // A cyclic node is dropped rather than emitted — no dangling reference to
    // a variable that was never declared.
    const { code } = graphToCode([mic, out], edges);
    expect(code).not.toContain('_sound1_bass');
  });

  it('reserves the gained variable name against a colliding property', () => {
    const prop = makeNode('p', 'property_float', { name: '_sound1_bass', value: 0.5 });
    const mic = makeNode('m1', 'soundNode', { gain: 2 });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('p', 'out', 'out', 'opacity'),
      makeEdge('m1', 'bass', 'out', 'color'),
    ];
    const { code } = graphToCode([prop, mic, out], edges);
    const declared = [...code.matchAll(/\bconst\s+(\w+)\s*=/g)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe('Sound node — smoothing is CPU-only and must not leak into the shader', () => {
  it('emits no shader reference for a wired smoothing edge', () => {
    // smoothing sets the AnalyserNode's smoothingTimeConstant on the CPU.
    // ShaderPreview resolves a wired edge by evaluating it with cpuEvaluator;
    // codegen must stay out of it entirely, or the uniform line would gain a
    // multiplier that has nothing to do with smoothing.
    const f = makeNode('f', 'float', { value: 0.5 });
    const mic = makeNode('m1', 'soundNode', {});
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('f', 'out', 'm1', 'smoothing'),
      makeEdge('m1', 'bass', 'out', 'color'),
    ];
    const { code } = graphToCode([f, mic, out], edges);
    expect(code).toContain('const sound1_bass = uniform(0);');
    // No gain wired and gain === 1, so no scaled twin and no stray multiply.
    expect(code).not.toContain('_sound1_bass');
    expect(code).not.toContain('sound1_bass.mul');
  });

  it('still applies gain when smoothing is also wired', () => {
    const f = makeNode('f', 'float', { value: 0.5 });
    const mic = makeNode('m1', 'soundNode', { gain: 4 });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('f', 'out', 'm1', 'smoothing'),
      makeEdge('m1', 'bass', 'out', 'color'),
    ];
    const { code } = graphToCode([f, mic, out], edges);
    expect(code).toContain('const _sound1_bass = sound1_bass.mul(4);');
  });
});

describe('Sound node — its params are exposed by DEFAULT', () => {
  it('a fresh node shows both input sockets without anything stored', () => {
    // The node has no other inputs, so with these hidden it was four outputs
    // and no way in but a settings checkbox or a drag-reveal you had to know
    // about. `exposedPorts` is undefined on a fresh node — the defaults are
    // IMPLICIT, which is why effectiveExposedPorts answers rather than the
    // stored value.
    const node = makeNode('sound1', 'soundNode');
    expect((node.data as { exposedPorts?: unknown }).exposedPorts).toBeUndefined();
    expect(effectiveExposedPorts(node)).toEqual(['smoothing', 'gain']);
    expect(SOUND_DEFAULT_EXPOSED).toEqual(['smoothing', 'gain']);
  });

  it('an explicit stored list still wins, including an empty one', () => {
    // Hiding both is a real choice the settings checkboxes can express, and it
    // must survive: falling back to the defaults on `[]` would make the
    // checkboxes look broken.
    const hidden = makeNode('sound1', 'soundNode');
    (hidden.data as { exposedPorts?: string[] }).exposedPorts = [];
    expect(effectiveExposedPorts(hidden)).toEqual([]);
    const one = makeNode('sound2', 'soundNode');
    (one.data as { exposedPorts?: string[] }).exposedPorts = ['gain'];
    expect(effectiveExposedPorts(one)).toEqual(['gain']);
  });

  it('changes NOTHING about the emitted code — the sockets are free when unwired', () => {
    // This is what makes defaulting them on safe. `gain` at its default with no
    // edge emits the bare uniform (graphToCode skips the multiply), and
    // `smoothing` never reaches codegen at all — it configures the AnalyserNode
    // on the CPU. So every graph saved before this generates identical text.
    const { nodes, edges } = micGraph(['bass']);
    const withDefaults = graphToCode(nodes, edges).code;

    const hiddenNodes = nodes.map((n) =>
      n.data.registryType === 'soundNode'
        ? { ...n, data: { ...n.data, exposedPorts: [] } }
        : n,
    );
    const withHidden = graphToCode(hiddenNodes as typeof nodes, edges).code;

    expect(withDefaults).toBe(withHidden);
    expect(withDefaults).toContain('const sound1_bass = uniform(0);');
    // No gain multiply anywhere: an exposed-but-unwired param is not a wire.
    expect(withDefaults).not.toContain('_sound1_bass');
  });
});
