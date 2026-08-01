import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { codeToGraph } from './codeToGraph';
import { getNodeValues } from '@/types';

describe('codeToGraph — empty / malformed input', () => {
  it('returns an empty result for empty / whitespace input', () => {
    expect(codeToGraph('')).toEqual({ nodes: [], edges: [], errors: [] });
    expect(codeToGraph('   \n\t  ')).toEqual({ nodes: [], edges: [], errors: [] });
  });

  it('reports a parse error for syntactically broken code', () => {
    const result = codeToGraph('const x = (((;');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toHaveProperty('message');
  });
});

describe('codeToGraph — output node lifecycle', () => {
  it('adds an unconnected output node when the snippet has no return / output =', () => {
    const result = codeToGraph(`
      import { Fn, float } from 'three/tsl';
      const shader = Fn(() => {
        const x = float(1);
      });
      export default shader;
    `);
    const outputs = result.nodes.filter((n) => n.data.registryType === 'output');
    expect(outputs).toHaveLength(1);
    // No edge wired to the output channel
    expect(result.edges.filter((e) => e.target === outputs[0].id)).toEqual([]);
  });

  it('wires a single-value return to output.color', () => {
    const result = codeToGraph(`
      import { Fn, color } from 'three/tsl';
      const shader = Fn(() => {
        const c = color(0xff0000);
        return c;
      });
      export default shader;
    `);
    const color = result.nodes.find((n) => n.data.registryType === 'color');
    const output = result.nodes.find((n) => n.data.registryType === 'output');
    expect(color).toBeDefined();
    expect(output).toBeDefined();
    const edge = result.edges.find(
      (e) => e.source === color!.id && e.target === output!.id && e.targetHandle === 'color',
    );
    expect(edge).toBeDefined();
  });

  it('wires a return-object into the corresponding output channels', () => {
    const result = codeToGraph(`
      import { Fn, color, float } from 'three/tsl';
      const shader = Fn(() => {
        const c = color(0x00ff00);
        const o = float(0.5);
        return { color: c, opacity: o };
      });
      export default shader;
    `);
    const output = result.nodes.find((n) => n.data.registryType === 'output')!;
    const channelTargets = result.edges
      .filter((e) => e.target === output.id)
      .map((e) => e.targetHandle);
    expect(channelTargets).toContain('color');
    expect(channelTargets).toContain('opacity');
  });

  it('also recognises `output = X` (three.js TSL editor compatible form)', () => {
    const result = codeToGraph(`
      import { color } from 'three/tsl';
      const c = color(0x123456);
      output = c;
    `);
    const colorNode = result.nodes.find((n) => n.data.registryType === 'color');
    const outputNode = result.nodes.find((n) => n.data.registryType === 'output');
    expect(colorNode).toBeDefined();
    expect(outputNode).toBeDefined();
    expect(
      result.edges.find(
        (e) => e.source === colorNode!.id && e.target === outputNode!.id && e.targetHandle === 'color',
      ),
    ).toBeDefined();
  });
});

describe('codeToGraph — literal extraction', () => {
  it('captures hex color literals as `#rrggbb` in node values', () => {
    const result = codeToGraph(`
      import { Fn, color } from 'three/tsl';
      const shader = Fn(() => {
        const c = color(0xabcdef);
        return c;
      });
      export default shader;
    `);
    const color = result.nodes.find((n) => n.data.registryType === 'color')!;
    expect(getNodeValues(color).hex).toBe('#abcdef');
  });

  it('clamps out-of-range / negative colour literals to a safe hex (adversarial input)', () => {
    // `.fastshader`/pasted source is adversarial: a literal beyond 24 bits or a
    // negative would otherwise store a malformed hex ('#1000000', '#0000-1').
    const oob = codeToGraph(`
      import { Fn, color } from 'three/tsl';
      const shader = Fn(() => {
        const c = color(0x1000000);
        return c;
      });
      export default shader;
    `);
    const cOob = oob.nodes.find((n) => n.data.registryType === 'color')!;
    expect(getNodeValues(cOob).hex).toBe('#000000');

    // property_color path (uniform(color(...))) shares the same guard.
    const neg = codeToGraph(`
      import { Fn, uniform, color } from 'three/tsl';
      const shader = Fn(() => {
        const p = uniform(color(-1));
        return p;
      });
      export default shader;
    `);
    const pNeg = neg.nodes.find((n) => n.data.registryType === 'property_color')!;
    expect(getNodeValues(pNeg).hex).toBe('#000000');
  });

  it('captures a float literal as a numeric value', () => {
    const result = codeToGraph(`
      import { Fn, float } from 'three/tsl';
      const shader = Fn(() => {
        const x = float(2.5);
        return x;
      });
      export default shader;
    `);
    const fnode = result.nodes.find((n) => n.data.registryType === 'float')!;
    expect(getNodeValues(fnode).value).toBe(2.5);
  });

  it('captures negative float literals via UnaryExpression', () => {
    const result = codeToGraph(`
      import { Fn, float } from 'three/tsl';
      const shader = Fn(() => {
        const x = float(-3.5);
        return x;
      });
      export default shader;
    `);
    const fnode = result.nodes.find((n) => n.data.registryType === 'float')!;
    expect(getNodeValues(fnode).value).toBe(-3.5);
  });
});

describe('codeToGraph — chained method calls', () => {
  it('treats the receiver as the first input of the chained function', () => {
    const result = codeToGraph(`
      import { Fn, time } from 'three/tsl';
      const shader = Fn(() => {
        const t = time;
        const s = t.mul(2);
        return s;
      });
      export default shader;
    `);
    const mulNode = result.nodes.find((n) => n.data.registryType === 'mul');
    const timeNode = result.nodes.find((n) => n.data.registryType === 'time');
    expect(mulNode).toBeDefined();
    expect(timeNode).toBeDefined();
    // Edge from time → mul.a (the receiver becomes the first input)
    expect(
      result.edges.find(
        (e) => e.source === timeNode!.id && e.target === mulNode!.id && e.targetHandle === 'a',
      ),
    ).toBeDefined();
  });

  it('looks through .toVar() / .toConst() as graph-level pass-throughs', () => {
    const result = codeToGraph(`
      import { Fn, time, sin } from 'three/tsl';
      const shader = Fn(() => {
        const blink = sin(time).toVar();
        return blink;
      });
      export default shader;
    `);
    // toVar should NOT appear as its own node
    const toVarNode = result.nodes.find((n) => {
      const vals = getNodeValues(n);
      return vals.functionName === 'toVar';
    });
    expect(toVarNode).toBeUndefined();
    expect(result.nodes.find((n) => n.data.registryType === 'sin')).toBeDefined();
  });
});

describe('codeToGraph — unknown functions', () => {
  it('creates an unknown node and emits a warning, preserving the raw call', () => {
    const result = codeToGraph(`
      import { Fn } from 'three/tsl';
      const shader = Fn(() => {
        const x = mysteryFn(1, 2, 3);
        return x;
      });
      export default shader;
    `);
    const unknown = result.nodes.find((n) => n.data.registryType === 'unknown');
    expect(unknown).toBeDefined();
    const vals = getNodeValues(unknown!);
    expect(vals.functionName).toBe('mysteryFn');
    expect(vals.rawExpression).toBe('mysteryFn(1, 2, 3)');

    expect(result.errors.length).toBeGreaterThan(0);
    const warning = result.errors.find((e) => e.severity === 'warning');
    expect(warning?.message).toMatch(/Unknown function: mysteryFn/);
  });
});

describe('codeToGraph — UV tiling pattern', () => {
  it('collapses `mul(uv(), vec2(a, b))` into a UV node with stored tiling values', () => {
    const result = codeToGraph(`
      import { Fn, uv, mul, vec2 } from 'three/tsl';
      const shader = Fn(() => {
        const u = mul(uv(), vec2(4, 2));
        return u;
      });
      export default shader;
    `);
    const uvNode = result.nodes.find((n) => n.data.registryType === 'uv');
    expect(uvNode).toBeDefined();
    const vals = getNodeValues(uvNode!);
    expect(vals.tilingU).toBe(4);
    expect(vals.tilingV).toBe(2);
    // The mul wrapper should NOT show up as its own node
    expect(result.nodes.find((n) => n.data.registryType === 'mul')).toBeUndefined();
  });
});

describe('codeToGraph — member-init declarations (const f1 = worley.x)', () => {
  it('wires a swizzle declaration through a split node instead of dropping it', () => {
    const result = codeToGraph(`
      import { Fn, mx_worley_noise_vec3, positionGeometry, sub } from 'three/tsl';
      const shader = Fn(() => {
        const worley = mx_worley_noise_vec3(positionGeometry);
        const f1 = worley.x;
        const f2 = worley.y;
        const edge = sub(f2, f1);
        return edge;
      });
      export default shader;
    `);
    const worley = result.nodes.find((n) => n.data.registryType === 'voronoiVec3')!;
    const split = result.nodes.find((n) => n.data.registryType === 'split')!;
    const subNode = result.nodes.find((n) => n.data.registryType === 'sub')!;
    expect(worley).toBeDefined();
    expect(split).toBeDefined();
    // One shared split node fed by the worley output
    expect(result.nodes.filter((n) => n.data.registryType === 'split')).toHaveLength(1);
    expect(
      result.edges.find((e) => e.source === worley.id && e.target === split.id && e.targetHandle === 'v'),
    ).toBeDefined();
    // sub(f2, f1) → split.y → sub.a, split.x → sub.b (NOT two disconnected operands)
    expect(
      result.edges.find(
        (e) => e.source === split.id && e.sourceHandle === 'y' && e.target === subNode.id && e.targetHandle === 'a',
      ),
    ).toBeDefined();
    expect(
      result.edges.find(
        (e) => e.source === split.id && e.sourceHandle === 'x' && e.target === subNode.id && e.targetHandle === 'b',
      ),
    ).toBeDefined();
    expect(result.errors).toEqual([]);
  });

  it('maps color-channel swizzle aliases (.r/.g/.b/.a) onto the xyzw split handles', () => {
    const result = codeToGraph(`
      import { Fn, vec3, sin } from 'three/tsl';
      const shader = Fn(() => {
        const v = vec3(1, 2, 3);
        const red = v.r;
        const s = sin(red);
        return s;
      });
      export default shader;
    `);
    const split = result.nodes.find((n) => n.data.registryType === 'split')!;
    const sinNode = result.nodes.find((n) => n.data.registryType === 'sin')!;
    expect(
      result.edges.find(
        (e) => e.source === split.id && e.sourceHandle === 'x' && e.target === sinNode.id && e.targetHandle === 'x',
      ),
    ).toBeDefined();
  });

  it('warns (without blocking sync) on a swizzle that has no graph representation', () => {
    const result = codeToGraph(`
      import { Fn, vec3 } from 'three/tsl';
      const shader = Fn(() => {
        const v = vec3(1, 2, 3);
        const xy = v.xy;
        return v;
      });
      export default shader;
    `);
    const warning = result.errors.find((e) => e.severity === 'warning');
    expect(warning?.message).toMatch(/v\.xy/);
    expect(result.errors.every((e) => e.severity === 'warning')).toBe(true);
  });

  it('imports Tests/morph-triangles-watercolor.tsl.js without dropping the worley split wiring', () => {
    const fixture = readFileSync(
      fileURLToPath(new URL('../../Tests/morph-triangles-watercolor.tsl.js', import.meta.url)),
      'utf8',
    );
    const result = codeToGraph(fixture);

    // The `const f1 = worley.x; const f2 = worley.y; sub(f2, f1)` pattern must
    // wire through a split node — historically both operands were silently
    // dropped and the graph degraded to sub(0, 0).
    const worley = result.nodes.find((n) => n.data.registryType === 'voronoiVec3')!;
    const split = result.nodes.find((n) => n.data.registryType === 'split')!;
    const subNode = result.nodes.find((n) => n.data.registryType === 'sub')!;
    expect(worley).toBeDefined();
    expect(split).toBeDefined();
    expect(subNode).toBeDefined();
    expect(
      result.edges.find((e) => e.source === worley.id && e.target === split.id && e.targetHandle === 'v'),
    ).toBeDefined();
    const subInputs = result.edges.filter((e) => e.target === subNode.id);
    expect(subInputs.map((e) => e.targetHandle).sort()).toEqual(['a', 'b']);
    expect(subInputs.every((e) => e.source === split.id)).toBe(true);
    // Nothing in this fixture should degrade silently OR loudly
    expect(result.errors).toEqual([]);
  });
});

describe('codeToGraph — .toVar() chain deduplication', () => {
  it('sin(time).toVar() produces exactly one sin node (no orphaned duplicate)', () => {
    const result = codeToGraph(`
      import { Fn, time, sin } from 'three/tsl';
      const shader = Fn(() => {
        const blink = sin(time).toVar();
        return blink;
      });
      export default shader;
    `);
    expect(result.nodes.filter((n) => n.data.registryType === 'sin')).toHaveLength(1);
    expect(result.nodes.filter((n) => n.data.registryType === 'time')).toHaveLength(1);
    // time → sin.x is wired exactly once
    const sinNode = result.nodes.find((n) => n.data.registryType === 'sin')!;
    expect(result.edges.filter((e) => e.target === sinNode.id)).toHaveLength(1);
  });

  it('a.mul(b).toVar() produces exactly one mul node with both operands wired', () => {
    const result = codeToGraph(`
      import { Fn, float } from 'three/tsl';
      const shader = Fn(() => {
        const a = float(2);
        const b = float(3);
        const m = a.mul(b).toVar();
        return m;
      });
      export default shader;
    `);
    const muls = result.nodes.filter((n) => n.data.registryType === 'mul');
    expect(muls).toHaveLength(1);
    const handles = result.edges
      .filter((e) => e.target === muls[0].id)
      .map((e) => e.targetHandle)
      .sort();
    expect(handles).toEqual(['a', 'b']);
    // The toVar alias resolves — the return wires from the mul node
    const output = result.nodes.find((n) => n.data.registryType === 'output')!;
    expect(
      result.edges.find((e) => e.source === muls[0].id && e.target === output.id && e.targetHandle === 'color'),
    ).toBeDefined();
  });
});

describe('codeToGraph — bare-global member args and computed constants', () => {
  it('wires positionGeometry.y as a call argument via an input node + split', () => {
    const result = codeToGraph(`
      import { Fn, sin, positionGeometry } from 'three/tsl';
      const shader = Fn(() => {
        const s = sin(positionGeometry.y);
        return s;
      });
      export default shader;
    `);
    const posNode = result.nodes.find((n) => n.data.registryType === 'positionGeometry')!;
    const split = result.nodes.find((n) => n.data.registryType === 'split')!;
    const sinNode = result.nodes.find((n) => n.data.registryType === 'sin')!;
    expect(posNode).toBeDefined();
    expect(split).toBeDefined();
    expect(
      result.edges.find((e) => e.source === posNode.id && e.target === split.id && e.targetHandle === 'v'),
    ).toBeDefined();
    expect(
      result.edges.find(
        (e) => e.source === split.id && e.sourceHandle === 'y' && e.target === sinNode.id && e.targetHandle === 'x',
      ),
    ).toBeDefined();
    // Correctly wired — no warning needed
    expect(result.errors).toEqual([]);
  });

  it('wires a swizzle chain receiver (pos.x.mul(2)) through the split node', () => {
    const result = codeToGraph(`
      import { Fn, positionGeometry } from 'three/tsl';
      const shader = Fn(() => {
        const pos = positionGeometry;
        const m = pos.x.mul(2);
        return m;
      });
      export default shader;
    `);
    const split = result.nodes.find((n) => n.data.registryType === 'split')!;
    const mulNode = result.nodes.find((n) => n.data.registryType === 'mul')!;
    expect(
      result.edges.find(
        (e) => e.source === split.id && e.sourceHandle === 'x' && e.target === mulNode.id && e.targetHandle === 'a',
      ),
    ).toBeDefined();
    // The literal 2 lands on port b, not a
    expect(getNodeValues(mulNode).b).toBe(2);
  });

  it('folds simple constant BinaryExpressions of numeric literals (1/6)', () => {
    const result = codeToGraph(`
      import { Fn, time, mul } from 'three/tsl';
      const shader = Fn(() => {
        const m = mul(time, 1 / 6);
        return m;
      });
      export default shader;
    `);
    const mulNode = result.nodes.find((n) => n.data.registryType === 'mul')!;
    expect(getNodeValues(mulNode).b).toBe(1 / 6);
    expect(result.errors).toEqual([]);
  });

  it('warns (severity warning) on unfoldable computed args like Math.PI', () => {
    const result = codeToGraph(`
      import { Fn, time, mul } from 'three/tsl';
      const shader = Fn(() => {
        const m = mul(time, Math.PI);
        return m;
      });
      export default shader;
    `);
    const warning = result.errors.find((e) => e.severity === 'warning');
    expect(warning?.message).toMatch(/Math\.PI/);
    // Warnings must not block sync
    expect(result.errors.every((e) => e.severity === 'warning')).toBe(true);
    // The mul node still exists with time wired
    const mulNode = result.nodes.find((n) => n.data.registryType === 'mul')!;
    expect(result.edges.some((e) => e.target === mulNode.id && e.targetHandle === 'a')).toBe(true);
  });
});

describe('codeToGraph — module-local helpers', () => {
  it('skips the hsl/toHsl helper Fn definitions emitted by graphToCode', () => {
    // Synthetic helper definitions — these should not pollute the graph with
    // standalone mul/sub/clamp nodes from their bodies.
    const result = codeToGraph(`
      import { Fn, mul, sub, abs, clamp, mod, add, float, vec3 } from 'three/tsl';
      const hsl = Fn(([h, s, l]) => {
        const h6 = mul(h, float(6));
        return vec3(h6, h6, h6);
      });
      const shader = Fn(() => {
        return vec3(0, 0, 0);
      });
      export default shader;
    `);
    // None of the helper's interior names (h6, h, s, l) should produce nodes
    const mulNode = result.nodes.find((n) => n.data.registryType === 'mul');
    expect(mulNode).toBeUndefined();
  });
});

describe('codeToGraph — time node speed', () => {
  const wrap = (body: string, imports = 'Fn, time') =>
    `import { ${imports} } from 'three/tsl';\nconst shader = Fn(() => {\n${body}\n});\nexport default shader;`;
  const timeNodes = (r: ReturnType<typeof codeToGraph>) =>
    r.nodes.filter((n) => n.data.registryType === 'time');
  const mulNodes = (r: ReturnType<typeof codeToGraph>) =>
    r.nodes.filter((n) => n.data.registryType === 'mul');

  // --- guard: ensureBareInputNode must still admit the time def now that it
  // carries defaultValues, or a bare `time` silently loses its node AND edge ---

  it('auto-creates a Time node from a bare `time` argument', () => {
    const result = codeToGraph(wrap('  const a = sin(time);\n  return a;', 'Fn, time, sin'));
    expect(timeNodes(result)).toHaveLength(1);
    const sinNode = result.nodes.find((n) => n.data.registryType === 'sin')!;
    expect(
      result.edges.some((e) => e.source === timeNodes(result)[0].id && e.target === sinNode.id),
    ).toBe(true);
    // createNode seeds values from defaultValues
    expect(getNodeValues(timeNodes(result)[0]).speed).toBe(1);
  });

  it('auto-creates a Time node from a bare `time` inside a variadic call', () => {
    const result = codeToGraph(
      wrap(
        '  const s = add(positionLocal, time, normalLocal);\n  return s;',
        'Fn, time, add, positionLocal, normalLocal',
      ),
    );
    expect(timeNodes(result)).toHaveLength(1);
  });

  // --- collapse: positive ---

  it('collapses `time.mul(<literal>)` into one Time node carrying speed', () => {
    const result = codeToGraph(wrap('  const a = time.mul(2.5);\n  return a;'));
    expect(timeNodes(result)).toHaveLength(1);
    expect(getNodeValues(timeNodes(result)[0]).speed).toBe(2.5);
    expect(mulNodes(result)).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });

  it('folds constant expressions and negative literals into speed', () => {
    const a = codeToGraph(wrap('  const a = time.mul(1 / 6);\n  return a;'));
    expect(getNodeValues(timeNodes(a)[0]).speed).toBe(1 / 6);
    const b = codeToGraph(wrap('  const a = time.mul(-0.5);\n  return a;'));
    expect(getNodeValues(timeNodes(b)[0]).speed).toBe(-0.5);
  });

  it('gives two collapse sites two independent Time nodes', () => {
    // ensureBareInputNode caches under the bare name; the detector must NOT,
    // or both sites would alias onto one node and share a single speed.
    const result = codeToGraph(
      wrap(
        '  const a = time.mul(0.5);\n  const b = time.mul(3);\n  return add(a, b);',
        'Fn, time, add',
      ),
    );
    expect(timeNodes(result).map((n) => getNodeValues(n).speed).sort()).toEqual([0.5, 3]);
  });

  it('collapses only the inner call of `time.mul(a).mul(b)`', () => {
    const result = codeToGraph(wrap('  const a = time.mul(0.5).mul(2);\n  return a;'));
    expect(timeNodes(result)).toHaveLength(1);
    expect(getNodeValues(timeNodes(result)[0]).speed).toBe(0.5);
    expect(mulNodes(result)).toHaveLength(1);
    expect(getNodeValues(mulNodes(result)[0]).b).toBe(2);
  });

  // --- collapse: negative. Each of these is a shape real users or fixtures
  // write, and folding it would delete a Multiply node the author meant. ---

  it('does NOT collapse the direct-call form mul(time, k)', () => {
    const result = codeToGraph(wrap('  const a = mul(time, 0.5);\n  return a;', 'Fn, time, mul'));
    expect(mulNodes(result)).toHaveLength(1);
    expect(timeNodes(result)).toHaveLength(1);
  });

  it('does NOT collapse a variable receiver (the Tests/ corpus idiom)', () => {
    const result = codeToGraph(
      wrap(
        '  const time1 = time;\n  const m1 = mul(time1, 5);\n  const m2 = mul(time1, -4.4);\n  return add(m1, m2);',
        'Fn, time, mul, add',
      ),
    );
    expect(timeNodes(result)).toHaveLength(1);
    expect(mulNodes(result)).toHaveLength(2);
  });

  it('does NOT collapse `mul(t, speed)` — the idiom the fixtures actually write', () => {
    // builtinTextures' Static Noise and every time-using preset alias
    // `const t = time` and then call the FUNCTION form. That is a real
    // Multiply and must stay one. (This is the shape the collapse guard was
    // always protecting — the bare-`time` receiver below is a different one.)
    const result = codeToGraph(
      wrap(
        '  const t = time;\n  const s = uniform(30);\n  const a = mul(t, s);\n  return a;',
        'Fn, time, uniform, mul',
      ),
    );
    expect(mulNodes(result)).toHaveLength(1);
    expect(timeNodes(result)).toHaveLength(1);
  });

  // --- collapse: the WIRED `speed` socket ---

  it('collapses a variable multiplier into a wired `speed` socket', () => {
    // `speed` is an opt-in input socket, so `time.mul(<var>)` is exactly what
    // graphToCode emits for a Time node whose speed is WIRED. It has to
    // collapse back to one node + one edge, or every code→graph pass would
    // grow another Multiply.
    const result = codeToGraph(
      wrap('  const s = uniform(30);\n  const a = time.mul(s);\n  return a;', 'Fn, time, uniform'),
    );
    expect(mulNodes(result)).toHaveLength(0);
    expect(timeNodes(result)).toHaveLength(1);
    const timeNode = timeNodes(result)[0];
    const speedEdge = result.edges.find(
      (e) => e.target === timeNode.id && e.targetHandle === 'speed',
    );
    expect(speedEdge).toBeDefined();
    // An edge may never point at a hidden socket.
    expect((timeNode.data as { exposedPorts?: string[] }).exposedPorts).toContain('speed');
  });

  it('does NOT collapse a multiplier that resolves to no node', () => {
    // `k` is a plain JS number, not a graph node — there is nothing to wire, so
    // this must stay a Multiply rather than silently dropping the operand.
    const result = codeToGraph(
      wrap('  const a = time.mul(k);\n  return a;', 'Fn, time'),
    );
    expect(mulNodes(result)).toHaveLength(1);
  });

  it('rejects a non-finite literal instead of storing Infinity as speed', () => {
    // `1e999` parses to a NumericLiteral holding Infinity. Storing it would
    // survive in memory but the fs:graph autosave (JSON.stringify) rewrites
    // Infinity to null, which then coerces to a real 0 — silently freezing the
    // shader on the next load. foldNumericConstant must refuse it up front.
    const result = codeToGraph(wrap('  const a = time.mul(1e999);\n  return a;'));
    for (const n of timeNodes(result)) {
      expect(Number.isFinite(Number(getNodeValues(n).speed ?? 1))).toBe(true);
    }
    expect(JSON.stringify(result.nodes)).not.toContain('null');
  });

  it('does NOT collapse a multi-argument time.mul', () => {
    const result = codeToGraph(wrap('  const a = time.mul(0.5, 2);\n  return a;'));
    expect(mulNodes(result)).toHaveLength(1);
  });
});
