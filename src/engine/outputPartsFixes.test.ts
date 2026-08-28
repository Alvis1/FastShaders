/**
 * Regressions for the per-mesh materials review (2026-08-27).
 *
 * Each case here is a defect that shipped in 7b4ea0b..da85de0 and was found by
 * review rather than by a test — which is the point: every one of them was
 * silent. The emitted module looked right, the graph looked right, `errors` was
 * empty, and the picture was wrong (or the page was someone else's).
 */

import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { buildShaderModule } from './tslCodeProcessor';
import { tslToPreviewHTML } from './tslToPreviewHTML';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

const outputNode = (id: string, ...meshes: string[]): AppNode => {
  const n = makeNode(id, 'output');
  if (meshes.length > 0) {
    (n.data as Record<string, unknown>).materials = meshes.map((name) => ({
      meshTargets: [name],
    }));
  }
  return n;
};

/** One Output whose single ADDED material shades SEVERAL meshes at once. */
const multiMeshOutput = (id: string, meshes: string[]): AppNode => {
  const n = makeNode(id, 'output');
  (n.data as Record<string, unknown>).materials = [{ meshTargets: meshes }];
  return n;
};

/**
 * A colour feeding the ONE Output — into its per-mesh material when `target`
 * is given, into the default material otherwise.
 */
const graphWith = (target?: string): { nodes: AppNode[]; edges: AppEdge[] } => {
  const color = makeNode('c1', 'color');
  (color.data as Record<string, unknown>).values = { color: '#3388ff' };
  const handle = target ? 'm1:color' : 'color';
  return {
    nodes: [color, target ? outputNode('o1', target) : outputNode('o1')],
    edges: [makeEdge('c1', 'out', 'o1', handle)],
  };
};

describe('a hostile mesh name cannot break out of the HTML script context', () => {
  // The XR popup is a TOP-LEVEL document at the app's REAL origin (the
  // sandboxed preview is not), so markup executing there runs with the user's
  // localStorage and IndexedDB. `meshTarget` reaches emission straight from a
  // shared `.fastshader`, and `isUsableMeshName` deliberately admits `<` and
  // `/` (an OBJ mesh really can be called that).
  const HOSTILE = 'x</script><img src=x onerror=alert(1)>';

  it('the emitted parts key carries no raw tag-open', () => {
    const { nodes, edges } = graphWith(HOSTILE);
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('parts:');
    expect(code).not.toContain('</script>');
    expect(code).not.toContain('<img');
    // …while still naming the same mesh: the escape is an encoding, not a
    // rewrite, so the loader's exact-name dispatch is unaffected.
    const key = /parts: \{ ("(?:[^"\\]|\\.)*")/.exec(code)?.[1];
    expect(key).toBeTruthy();
    expect(JSON.parse(key!)).toBe(HOSTILE);
  });

  it('survives into the built module and the generated preview document', () => {
    const { nodes, edges } = graphWith(HOSTILE);
    const { code } = graphToCode(nodes, edges);
    const mod = buildShaderModule(code);
    expect(mod).not.toContain('</script>');

    for (const xr of [false, true]) {
      const html = tslToPreviewHTML(code, { xr });
      // The ONLY `</script` sequences in the document are its own real tag
      // closers — never one carried inside the inlined module string.
      const inlined = /var __shaderCode = ("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
      expect(inlined, `xr=${xr}`).toBeTruthy();
      expect(inlined!, `xr=${xr}`).not.toContain('</script');
      expect(inlined!, `xr=${xr}`).not.toContain('<img');
      // The blob the module is built from still decodes to the real source.
      expect(JSON.parse(inlined!)).toContain('parts:');
    }
  });

  it('the sink protects strings the source-side escape never sees', () => {
    // `partKeyLiteral` is one call site; the embed covers every OTHER string
    // that can reach the document (an `unknown` node's raw expression, an
    // image asset's file name…). Asserted independently so removing either
    // half of the defence fails a test.
    //
    // An `unknown` node is the vehicle: codeToGraph keeps an unrecognised call
    // verbatim, so this really is a string the emitter never inspects.
    const parsed = codeToGraph('const u = notARealTslFunction(1.0);\nreturn vec3(u);');
    const unknown = parsed.nodes.find((n) => n.data.registryType === 'unknown');
    expect(unknown, 'needs an unknown node to carry the payload').toBeTruthy();
    (unknown!.data as { values?: Record<string, unknown> }).values = {
      functionName: 'notARealTslFunction',
      rawExpression: 'notARealTslFunction(1.0) /* </script><img src=x onerror=alert(1)> */',
    };
    const { code } = graphToCode(parsed.nodes, parsed.edges);

    // Precondition: the payload really does reach the module. Without this the
    // assertion below would pass for the wrong reason if emission ever started
    // stripping it.
    expect(code, 'payload must reach the generated module').toContain('<img src=x');

    const html = tslToPreviewHTML(code);
    const inlined = /var __shaderCode = ("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
    expect(inlined).toBeTruthy();
    expect(inlined!).not.toContain('</script');
    expect(inlined!).not.toContain('<img');
    // …and the module the blob is built from is byte-identical.
    expect(JSON.parse(inlined!)).toContain('<img src=x');
  });
});

describe('a parts-only module round-trips without inventing a default', () => {
  // Adding a mesh material while wiring nothing to the main output is the
  // ordinary way to shade one mesh and leave the rest of the model on its
  // authored glTF materials.
  const emitOnly = () => graphToCode(...Object.values(graphWith('Glass')) as [AppNode[], AppEdge[]]).code;

  it('emits the parts-only form', () => {
    const code = emitOnly();
    expect(code).toContain('parts:');
    expect(code).not.toMatch(/return \{ color:/);
  });

  it('parses back to ONE Output whose default material stays empty', () => {
    const parsed = codeToGraph(emitOnly());
    const outs = parsed.nodes.filter((n) => n.data.registryType === 'output');
    expect(outs).toHaveLength(1);
    expect((outs[0].data as Record<string, unknown>).materials).toEqual([
      { meshTargets: ['Glass'] },
    ]);
    // Nothing wired to the default, so nothing STORED on it either — which is
    // what makes the re-emission parts-only again.
    expect(
      Object.keys(((outs[0].data as { values?: object }).values) ?? {}),
    ).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  it('round-trips byte-identically and does not grow across two Applies', () => {
    // The failure this pins: an invented default made the next emission write
    // `color: vec3(1, 0, 0)`, so every unclaimed mesh went solid red in the
    // preview, the export and the XR popup — with errors: [] throughout.
    const first = emitOnly();
    const p1 = codeToGraph(first);
    const second = graphToCode(p1.nodes, p1.edges).code;
    expect(second).toBe(first);
    expect(second).not.toContain('vec3(1, 0, 0)');

    const p2 = codeToGraph(second);
    expect(p2.nodes.length).toBe(p1.nodes.length);
    expect(graphToCode(p2.nodes, p2.edges).code).toBe(first);
  });

  it('still mints an Output when a parts-only module has no usable part', () => {
    // Otherwise the graph has no Output at all and cannot be wired.
    const parsed = codeToGraph('return { parts: { "": { color: vec3(1.0) } } };');
    const outs = parsed.nodes.filter((n) => n.data.registryType === 'output');
    expect(outs).toHaveLength(1);
    expect((outs[0].data as Record<string, unknown>).materials).toBeUndefined();
  });

  it('a module-level Discard belongs to the DEFAULT material, not a mesh', () => {
    // A `Discard()` STATEMENT is the module's, so it lands on material 0's
    // bare handle — never on a `m<n>:discard` one.
    const parsed = codeToGraph(
      'const c = float(0.5);\nDiscard(c);\nreturn { parts: { "Glass": { color: vec3(1.0) } } };',
    );
    const discardEdge = parsed.edges.find(
      (e) => typeof e.targetHandle === 'string' && e.targetHandle.endsWith('discard'),
    );
    expect(discardEdge).toBeTruthy();
    expect(discardEdge!.targetHandle).toBe('discard');
  });
});

describe('a mesh name containing a colon still reaches the module', () => {
  // OBJ names never pass through three's `sanitizeNodeName`, so a Maya-style
  // `g Char:Body` really does land in the scene as `Char:Body`.
  it('emits the part instead of silently dropping it', () => {
    const { nodes, edges } = graphWith('Char:Body');
    const mod = buildShaderModule(graphToCode(nodes, edges).code);
    expect(mod).toContain('parts:');
    expect(mod).toContain('Char:Body');
    expect(mod).toMatch(/"Char:Body":\s*\{\s*colorNode:/);
  });

  it('an UNQUOTED part key is honoured too, not silently skipped', () => {
    // graphToCode always quotes, but the code panel is a real editing surface
    // and `parts: { Glass: {…} }` is valid JS that codeToGraph accepts — so
    // skipping it made the part vanish from the preview until the user
    // happened to press Apply.
    const { nodes, edges } = graphWith('Glass');
    nodes.push(outputNode('o2')); // a default, so the object form is kept
    const emitted = graphToCode(nodes, edges).code;
    // Exactly what hand-editing the key in the code panel produces.
    const handEdited = emitted.replace('"Glass":', 'Glass:');
    expect(handEdited, 'the unquote must actually have applied').not.toBe(emitted);
    expect(buildShaderModule(handEdited)).toMatch(/"Glass":\s*\{\s*colorNode:/);
  });

  it('and round-trips through the parse', () => {
    const { nodes, edges } = graphWith('Char:Body');
    const code = graphToCode(nodes, edges).code;
    const parsed = codeToGraph(code);
    const out = parsed.nodes.find((n) => n.data.registryType === 'output')!;
    expect((out.data as Record<string, unknown>).materials).toEqual([
      { meshTargets: ['Char:Body'] },
    ]);
  });
});

describe('a part discard falls back to the part\'s emissive, not to white', () => {
  /**
   * The ordinary glow-cutout wiring — Emissive + Discard, no Colour — on a
   * TARGETED Output. Built through the graph so the module under test is the
   * one the app really emits.
   */
  const glowCutout = (withEmissive: boolean) => {
    const out = outputNode('o1', 'Glass');
    // The MATERIAL's exposed set, not the node's.
    (out.data as unknown as { materials: Record<string, unknown>[] }).materials[0].exposedPorts =
      ['color', 'emissive', 'discard'];
    const nodes: AppNode[] = [makeNode('f1', 'float'), out];
    const edges: AppEdge[] = [makeEdge('f1', 'out', 'o1', 'm1:discard')];
    if (withEmissive) {
      const emissive = makeNode('c1', 'color');
      (emissive.data as Record<string, unknown>).values = { color: '#00ff00' };
      nodes.unshift(emissive);
      edges.push(makeEdge('c1', 'out', 'o1', 'm1:emissive'));
    }
    return buildShaderModule(graphToCode(nodes, edges).code);
  };

  it('routes emissive through the part wrapper when no colour is wired', () => {
    const mod = glowCutout(true);
    const partCall = /__partPixel0\(([^)]*)\)/.exec(mod)?.[1];
    expect(partCall, mod).toBeTruthy();
    // The emissive ref, not the lit-white last resort.
    expect(partCall).not.toContain('vec3(1, 1, 1)');
    expect(partCall).toMatch(/color\(0x00ff00\)|color1/);
  });

  it('still falls to white when the part has neither colour nor emissive', () => {
    const mod = glowCutout(false);
    expect(mod, mod).toMatch(/__partPixel0\([^,]+, vec3\(1, 1, 1\)\)/);
  });
});

describe('the parse reports what it drops, and agrees with the runtime', () => {
  it('a duplicate part key keeps the LAST, as the JS object literal does', () => {
    const parsed = codeToGraph(
      'const a = vec3(1.0, 0.0, 0.0);\n'
      + 'const b = vec3(0.0, 1.0, 0.0);\n'
      + 'return { color: vec3(0.2), parts: { "Glass": { color: a }, "Glass": { color: b } } };',
    );
    const out = parsed.nodes.find((n) => n.data.registryType === 'output')!;
    // The material's own handle — `m1:color`, never the default's `color`.
    const fed = parsed.edges.find(
      (e) => e.target === out.id && e.targetHandle === 'm1:color',
    )!;
    const source = parsed.nodes.find((n) => n.id === fed.source)!;
    // `b` is the surviving key at runtime, so it must be the one wired here.
    expect(source.data.label).toBe('b');
  });

  it('warns rather than silently deleting a non-object part', () => {
    const parsed = codeToGraph(
      'const a = vec3(1.0);\nreturn { color: vec3(0.2), parts: { "Glass": a } };',
    );
    expect(parsed.errors.some((e) => /not a channel object/i.test(e.message))).toBe(true);
    expect(parsed.errors.every((e) => e.severity === 'warning')).toBe(true);
  });

  it('warns rather than silently dropping an unusable part name', () => {
    const parsed = codeToGraph(
      'return { color: vec3(0.2), parts: { "": { color: vec3(1.0) } } };',
    );
    expect(parsed.errors.some((e) => /unusable mesh name/i.test(e.message))).toBe(true);
  });
});

describe('the resync has ONE Output to pair, so materials ride with it', () => {
  // While each targeted mesh had its own Output NODE, `mergeMatch`'s pass-1 key
  // had to fold the mesh in: every parsed Output is labelled literally
  // "Output", so they all landed in one bucket and paired by ARRAY ORDER —
  // one Apply could move a material's stored values, exposed ports and
  // settings onto a different mesh, with nothing erroring. Materials living
  // inside the single node removes that class rather than guarding it, and
  // this pins the property the removal depends on.
  it('an Apply keeps each material\'s own values on its own mesh', () => {
    const out = outputNode('o1', 'Glass', 'Body');
    const mats = (out.data as unknown as { materials: Record<string, unknown>[] }).materials;
    mats[0].values = { roughness: 0.25 };
    mats[0].exposedPorts = ['color', 'roughness'];
    mats[1].values = { roughness: 0.75 };
    mats[1].exposedPorts = ['color', 'roughness'];

    const code = graphToCode([out], []).code;
    const parsed = codeToGraph(code);
    const after = parsed.nodes.find((n) => n.data.registryType === 'output')!;
    const got = (after.data as unknown as { materials: Record<string, unknown>[] }).materials;
    expect(got[0].meshTargets).toEqual(['Glass']);
    expect((got[0].values as Record<string, number>).roughness).toBe(0.25);
    expect(got[1].meshTargets).toEqual(['Body']);
    expect((got[1].values as Record<string, number>).roughness).toBe(0.75);
  });
});

describe('a user variable is never hijacked by a channel temp name', () => {
  it('a deferred Discard still resolves to the user\'s own variable', () => {
    // `_part0_color` is the synthetic name the parts path uses; a module may
    // legitimately declare it, and the deferred Discard resolves AFTER the
    // return, so a clobbered mapping sent the cull to the wrong node.
    const parsed = codeToGraph(
      'const _part0_color = float(0.25);\n'
      + 'Discard(_part0_color);\n'
      + 'return { color: vec3(0.5), parts: { "Glass": { color: mix(vec3(0.0), vec3(1.0), float(0.5)) } } };',
    );
    const discardEdge = parsed.edges.find((e) => e.targetHandle === 'discard')!;
    const source = parsed.nodes.find((n) => n.id === discardEdge.source)!;
    expect(source.data.label).toBe('_part0_color');
    expect(source.data.registryType).toBe('float');
  });
});

/* ============================================================
 * Material 0 may name a mesh of its own (2026-08-27)
 * ============================================================ */

/** The ONE Output, with material 0 pointed at `name` and a colour wired to its
 *  BARE handle — material 0 keeps those whether or not it is targeted. */
const graphWithDefaultTargeted = (name: string): { nodes: AppNode[]; edges: AppEdge[] } => {
  const color = makeNode('c1', 'color');
  (color.data as Record<string, unknown>).values = { hex: '#3388ff' };
  const out = outputNode('o1');
  (out.data as Record<string, unknown>).meshTarget = { name };
  return { nodes: [color, out], edges: [makeEdge('c1', 'out', 'o1', 'color')] };
};

describe('material 0 can name a mesh instead of being the default', () => {
  it('emits it as a part, with NO default material beside it', () => {
    const { nodes, edges } = graphWithDefaultTargeted('Body');
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('parts: { "Body": {');
    expect(code).toContain('0x3388ff');
    // The whole point: unclaimed meshes keep the materials the model was
    // authored with, so nothing may leak out of `parts` at the top level.
    expect(code).not.toMatch(/return \{ color:/);
    expect(code).not.toContain('vec3(1, 0, 0)');
  });

  it('keeps the BARE handles, so wiring survives being re-pointed', () => {
    // Material 0 is the node's own channel state whether or not it names a
    // mesh. If targeting it had moved its channels onto `m0:` handles, every
    // existing edge would have gone dark the moment the picker was touched.
    const { nodes, edges } = graphWithDefaultTargeted('Body');
    expect(edges[0].targetHandle).toBe('color');
    expect(graphToCode(nodes, edges).code).toContain('parts: { "Body"');
  });

  it('a document with no target is untouched — the byte-stability guarantee', () => {
    const plain = graphWith();
    const targeted = graphWithDefaultTargeted('Body');
    expect(graphToCode(plain.nodes, plain.edges).code).not.toContain('parts:');
    expect(graphToCode(targeted.nodes, targeted.edges).code).toContain('parts:');
  });

  it('an Apply NORMALIZES it back to "empty default + that material"', () => {
    // A `parts` map has nowhere to record which material was the default, so a
    // parts-only module is indistinguishable from an empty default beside the
    // same parts — and codeToGraph resolves it the historical way (pinned
    // above). This documents the consequence rather than pretending there is
    // none: the wiring is re-created from the code, the module re-emits
    // byte-identically, and the shape is stable from then on.
    const first = graphToCode(...Object.values(graphWithDefaultTargeted('Body')) as [AppNode[], AppEdge[]]).code;
    const p1 = codeToGraph(first);
    const out = p1.nodes.find((n) => n.data.registryType === 'output')!;
    expect((out.data as { meshTarget?: unknown }).meshTarget).toBeUndefined();
    expect((out.data as { materials?: unknown }).materials).toEqual([
      { meshTargets: ['Body'] },
    ]);
    // Nothing is LOST: same module, and stable across a second Apply.
    const second = graphToCode(p1.nodes, p1.edges).code;
    expect(second).toBe(first);
    const p2 = codeToGraph(second);
    expect(graphToCode(p2.nodes, p2.edges).code).toBe(first);
    expect(p2.nodes.length).toBe(p1.nodes.length);
  });
});

describe('two materials may name ONE mesh, and the first claim wins', () => {
  const duplicate = (): { nodes: AppNode[]; edges: AppEdge[] } => {
    const a = makeNode('c1', 'color');
    (a.data as Record<string, unknown>).values = { hex: '#111111' };
    const b = makeNode('c2', 'color');
    (b.data as Record<string, unknown>).values = { hex: '#222222' };
    const out = outputNode('o1', 'Glass', 'Glass');
    return {
      nodes: [a, b, out],
      edges: [makeEdge('c1', 'out', 'o1', 'm1:color'), makeEdge('c2', 'out', 'o1', 'm2:color')],
    };
  };

  it('emits ONE entry for the mesh — the earlier material', () => {
    // Selecting a duplicate is legal (it is how two materials swap meshes), so
    // this state reaches emission routinely. A `parts` map has one slot per
    // mesh, so the later material is shadowed rather than emitted as a second
    // key that would silently win at runtime.
    const { code } = graphToCode(...Object.values(duplicate()) as [AppNode[], AppEdge[]]);
    expect((code.match(/"Glass":/g) ?? []).length).toBe(1);
    // The var each colour got, so the assertion is about which one the PART
    // references — both nodes still emit their `const` (every node does,
    // wired or not), so matching the hex against the whole module proves
    // nothing.
    const varOf = (hex: string) =>
      new RegExp(`const (\\w+) = color\\(${hex}\\)`).exec(code)?.[1];
    expect(code).toMatch(new RegExp(`"Glass": \\{ color: ${varOf('0x111111')} \\}`));
    expect(code).not.toMatch(new RegExp(`"Glass": \\{ color: ${varOf('0x222222')} \\}`));
  });

  it('material 0 competes on the same terms', () => {
    const { nodes, edges } = duplicate();
    (nodes[2].data as Record<string, unknown>).meshTarget = { name: 'Glass' };
    const { code } = graphToCode(nodes, edges);
    expect((code.match(/"Glass":/g) ?? []).length).toBe(1);
    // Material 0 is first, so ITS channels are what the mesh gets — and here it
    // has none wired, so the entry is empty and BOTH added materials are
    // shadowed. (Their nodes still emit their own `const`; every node does.)
    expect(code).toContain('"Glass": {  }');
  });
});

/* ============================================================
 * One material, SEVERAL meshes (2026-08-27)
 * ============================================================ */

describe('a material may shade several meshes at once', () => {
  it('emits one `parts` entry per mesh, all pointing at the same channels', () => {
    const color = makeNode('c1', 'color');
    (color.data as Record<string, unknown>).values = { hex: '#3388ff' };
    const out = multiMeshOutput('o1', ['Body', 'Glass', 'Wheels']);
    const { code } = graphToCode([color, out], [makeEdge('c1', 'out', 'o1', 'm1:color')]);
    // `parts` is keyed by mesh, so N meshes are N entries — the material is
    // what they share, not a key they can collapse into.
    for (const mesh of ['Body', 'Glass', 'Wheels']) {
      expect(code).toContain(`"${mesh}": { color: color1 }`);
    }
    expect((code.match(/color1 \}/g) ?? []).length).toBe(3);
  });

  it('round-trips: identical part bodies MERGE back into one material', () => {
    // Without the merge the feature would not survive its own round trip — a
    // three-mesh material would split into three sections on the first Apply,
    // each with its own copy of the wiring.
    const color = makeNode('c1', 'color');
    (color.data as Record<string, unknown>).values = { hex: '#3388ff' };
    const out = multiMeshOutput('o1', ['Body', 'Glass']);
    const first = graphToCode([color, out], [makeEdge('c1', 'out', 'o1', 'm1:color')]).code;

    const p1 = codeToGraph(first);
    const mats = (p1.nodes.find((n) => n.data.registryType === 'output')!
      .data as unknown as { materials: { meshTargets: string[] }[] }).materials;
    expect(mats).toHaveLength(1);
    expect(mats[0].meshTargets).toEqual(['Body', 'Glass']);
    // …and the wiring landed once, on that one material's handles.
    expect(p1.edges.filter((e) => e.targetHandle === 'm1:color')).toHaveLength(1);
    expect(p1.edges.filter((e) => e.targetHandle === 'm2:color')).toHaveLength(0);

    expect(graphToCode(p1.nodes, p1.edges).code).toBe(first);
    const p2 = codeToGraph(graphToCode(p1.nodes, p1.edges).code);
    expect(p2.nodes.length).toBe(p1.nodes.length);
  });

  it('DIFFERENT bodies stay separate materials', () => {
    const a = makeNode('c1', 'color');
    (a.data as Record<string, unknown>).values = { hex: '#111111' };
    const b = makeNode('c2', 'color');
    (b.data as Record<string, unknown>).values = { hex: '#222222' };
    const out = outputNode('o1', 'Body', 'Glass');
    const code = graphToCode([a, b, out], [
      makeEdge('c1', 'out', 'o1', 'm1:color'),
      makeEdge('c2', 'out', 'o1', 'm2:color'),
    ]).code;
    const mats = (codeToGraph(code).nodes.find((n) => n.data.registryType === 'output')!
      .data as unknown as { materials: { meshTargets: string[] }[] }).materials;
    expect(mats.map((m) => m.meshTargets)).toEqual([['Body'], ['Glass']]);
  });

  it('EMPTY bodies are never merged', () => {
    // Two freshly added mesh materials, neither wired yet, are exactly the pair
    // a body-text merge would collapse — and they are the pair most likely to
    // be about to get different wiring.
    const code = graphToCode([outputNode('o1', 'Body', 'Glass')], []).code;
    const mats = (codeToGraph(code).nodes.find((n) => n.data.registryType === 'output')!
      .data as unknown as { materials: { meshTargets: string[] }[] }).materials;
    expect(mats.map((m) => m.meshTargets)).toEqual([['Body'], ['Glass']]);
  });

  it('a duplicate ACROSS materials is still first-claim, per mesh', () => {
    const a = makeNode('c1', 'color');
    (a.data as Record<string, unknown>).values = { hex: '#111111' };
    const b = makeNode('c2', 'color');
    (b.data as Record<string, unknown>).values = { hex: '#222222' };
    const out = makeNode('o1', 'output');
    (out.data as Record<string, unknown>).materials = [
      { meshTargets: ['Body', 'Glass'] },
      { meshTargets: ['Glass', 'Wheels'] },
    ];
    const { code } = graphToCode([a, b, out], [
      makeEdge('c1', 'out', 'o1', 'm1:color'),
      makeEdge('c2', 'out', 'o1', 'm2:color'),
    ]);
    // Glass belongs to the FIRST material that named it; Wheels still gets the
    // second one, so a partial overlap does not cost the whole material.
    expect((code.match(/"Glass":/g) ?? []).length).toBe(1);
    const varOf = (hex: string) =>
      new RegExp(`const (\\w+) = color\\(${hex}\\)`).exec(code)?.[1];
    expect(code).toMatch(new RegExp(`"Glass": \\{ color: ${varOf('0x111111')} \\}`));
    expect(code).toMatch(new RegExp(`"Wheels": \\{ color: ${varOf('0x222222')} \\}`));
  });
});
