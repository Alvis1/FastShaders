import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import _traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { graphToCode, MARCH_IIFE_LOCALS } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { buildExportModule } from './exportShader';
import { computeReachableCost, nodeCostPoints, getCost } from '@/utils/nodeCost';
import { drivingMarchOutput, marchWindowRadius, MARCH_SCOPES } from '@/utils/sdfPartition';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeNode, makeEdge } from '@/test-utils';
import { getNodeValues } from '@/types';
import type { AppNode, AppEdge } from '@/types';

/**
 * Raymarch Output — surface and volume marcher in ONE node. Field sphere-
 * traces to a lit surface, Density integrates a self-lit volume, both may be
 * wired; Background is a function of the ray's FINAL direction. The march is
 * one IIFE returning one vec4 (final RGB + coverage), every channel emitted as
 * its own `rm1<Channel>` declarator so the parser reads them back.
 */
const surfaceGraph = () => ({
  nodes: [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('col', 'color'), makeNode('rm', 'raymarchOutput')],
  edges: [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field'), makeEdge('col', 'out', 'rm', 'color')],
});
const volumeGraph = () => ({
  nodes: [makeNode('pos', 'positionLocal'), makeNode('len', 'length'), makeNode('dens', 'oneMinus'), makeNode('rm', 'raymarchOutput', { steps: 32, stepSize: 0.05, bend: 0.2, horizon: 0.1, window: 40, fieldRadius: 1.5 })],
  edges: [makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'dens', 'x'), makeEdge('dens', 'out', 'rm', 'density')],
});

describe('Raymarch Output — surface', () => {
  it('sphere-traces a Field, shades the hit, and cuts away misses', () => {
    const { nodes, edges } = surfaceGraph();
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const rm1Field = Fn(([p]) => {');
    expect(code).toContain('    const positionLocal1 = p;');
    expect(code).toContain('    return sdCircle1;');
    expect(code).toContain("If(d.lessThan(eps), () => { surfHit.assign(1); hp.assign(pos); Break(); });");
    expect(code).toContain('      const adv = max(mul(max(d, eps), stepScale), gap);');
    expect(code).toContain('pos.addAssign(mul(rd, adv));');
    expect(code).toContain('const lam = add(mul(vec3(0.85, 0.85, 0.85), max(dot(nrm, key), float(0))), vec3(0.15, 0.15, 0.15));');
    expect(code).toContain('  const rm1Color = color1;');
    expect(code).toContain('const surf = mul(rm1Color, lam);');
    expect(code).toContain('  Discard(rm1.w.lessThan(0.01));');
    expect(code).toContain('  return { color: color(0x000000), emissive: rm1Col, roughness: float(1) };');
    expect(code).not.toContain('Density(');
  });

  it('round-trips byte-identically', () => {
    const { nodes, edges } = surfaceGraph();
    const { code } = graphToCode(nodes, edges);
    const r = codeToGraph(code);
    expect(r.errors).toEqual([]);
    expect(r.nodes.map((n) => n.data.registryType).sort()).toEqual(['color', 'positionLocal', 'raymarchOutput', 'sdCircle']);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('a stored colour swatch emits color(0x…) as the albedo and round-trips', () => {
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('rm', 'raymarchOutput', { color: '#2d6cdf' })];
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field')];
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('  const rm1Color = color(0x2d6cdf);');
    expect(code).toContain('const surf = mul(rm1Color, lam);');
    const r = codeToGraph(code);
    expect((r.nodes.find((n) => n.data.registryType === 'raymarchOutput')!.data as { values: Record<string, unknown> }).values.color).toBe('#2d6cdf');
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });
});

describe('Raymarch Output — volume', () => {
  it('integrates Density with a fixed step, bends, absorbs at the horizon, and carries its numbers', () => {
    const { nodes, edges } = volumeGraph();
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const rm1Density = Fn(([p]) => {');
    expect(code).toContain('const stepSize = float(0.05);');
    expect(code).toContain('const bend = float(0.2);');
    expect(code).toContain('const horizon = float(0.1);');
    expect(code).toContain('const win = float(40);');
    expect(code).toContain('const fieldR = float(1.5);');
    expect(code).toContain('Loop(int(32), () => {');
    expect(code).toContain('If(r.lessThan(horizon), () => { alpha.assign(1); surfHit.assign(0); Break(); });');
    expect(code).toContain('rd.assign(normalize(sub(rd, steer)));');
    expect(code).toContain('col.addAssign(mul(vec3(1, 1, 1), w));');
    expect(code).toContain('      const adv = max(stepSize, gap);');
    expect(code).toContain('pos.addAssign(mul(rd, adv));');
    expect(code).not.toContain('Field(');
    expect(code).toContain('  Discard(rm1.w.lessThan(0.01));');
  });

  it('round-trips byte-identically, numbers included', () => {
    const { nodes, edges } = volumeGraph();
    const { code } = graphToCode(nodes, edges);
    const r = codeToGraph(code);
    expect(r.errors).toEqual([]);
    const rm = r.nodes.find((n) => n.data.registryType === 'raymarchOutput')!;
    expect((rm.data as { values: Record<string, number> }).values).toMatchObject({ steps: 32, stepSize: 0.05, bend: 0.2, horizon: 0.1, window: 40, fieldRadius: 1.5 });
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('a Background over Ray Direction is a function of the FINAL direction, fills the window, and round-trips', () => {
    const { nodes, edges } = volumeGraph();
    nodes.push(makeNode('dir', 'rayDirection'), makeNode('sky', 'length'));
    edges.push(makeEdge('dir', 'out', 'sky', 'v'), makeEdge('sky', 'out', 'rm', 'background'));
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('  const rayDirection1 = rayDirection();');
    expect(code).toContain('const rm1Background = Fn(([dir]) => {');
    expect(code).toContain('    const rayDirection1 = dir;');
    expect(code).toContain('const bg = rm1Background(rdWorld);');
    expect(code).toContain('return vec4(add(col, mul(bg, sub(1, alpha))), float(1));');
    expect(code).not.toContain('Discard(');
    const r = codeToGraph(code);
    expect(r.errors).toEqual([]);
    expect(r.nodes.filter((n) => n.data.registryType === 'rayDirection')).toHaveLength(1);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('a position-dependent Glow is its own per-step Fn', () => {
    const { nodes, edges } = volumeGraph();
    nodes.push(makeNode('g', 'abs'));
    edges.push(makeEdge('pos', 'out', 'g', 'x'), makeEdge('g', 'out', 'rm', 'glow'));
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const rm1Glow = Fn(([p]) => {');
    expect(code).toContain('col.addAssign(mul(rm1Glow(pos), w));');
    const r = codeToGraph(code);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });
});

describe('Raymarch Output — both', () => {
  it('a volume in front of a surface: fixed steps, surface hit, both round-trip', () => {
    const { nodes, edges } = surfaceGraph();
    nodes.push(makeNode('len', 'length'), makeNode('dens', 'oneMinus'));
    edges.push(makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'dens', 'x'), makeEdge('dens', 'out', 'rm', 'density'));
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const rm1Field = Fn(');
    expect(code).toContain('const rm1Density = Fn(');
    expect(code).toContain('      const adv = max(stepSize, gap);');
    expect(code).toContain('col.assign(add(col, mul(surf, mul(sub(1, alpha), surfCov))));');
    const r = codeToGraph(code);
    expect(r.errors).toEqual([]);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('drives with Field OR Density wired, and reports its Window radius', () => {
    const { nodes, edges } = volumeGraph();
    expect(drivingMarchOutput(nodes, edges)?.id).toBe('rm');
    expect(marchWindowRadius(nodes, edges)).toBe(40);
    expect(marchWindowRadius(nodes, edges.slice(0, 2))).toBeNull();
  });

  it('prices the Field body per step plus four normal taps, Density and Glow per step, plus the fixed cost', () => {
    const { nodes, edges } = surfaceGraph();
    const body = nodeCostPoints(nodes[0], edges) + nodeCostPoints(nodes[1], edges);
    expect(computeReachableCost(nodes, edges)).toBe(body * (64 + 4) + nodeCostPoints(nodes[2], edges) + getCost('raymarchOutput'));
  });
});

describe('the march\'s own light (2026-09-03): direction, colours, occlusion, shadow, step scale', () => {
  const surface = (values: Record<string, string | number> = {}, extraNodes: AppNode[] = [], extraEdges: AppEdge[] = []) => {
    const pos = makeNode('pos', 'positionLocal');
    const sd = makeNode('sd', 'sdCircle');
    const rm = { ...makeNode('rm', 'raymarchOutput'), data: { ...makeNode('rm', 'raymarchOutput').data, values } } as AppNode;
    const nodes = [pos, sd, rm, ...extraNodes];
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field'), ...extraEdges];
    return { nodes, edges, code: graphToCode(nodes, edges).code };
  };

  it('an untouched node shades exactly as the fixed light did: 0.85 key + 0.15 ambient, no occlusion, no shadow, step scale 1', () => {
    const { code } = surface();
    expect(code).toContain('const key = normalize(vec3(lightX, lightY, lightZ));');
    expect(code).toContain('const lightX = float(0.6);');
    expect(code).toContain('const lam = add(mul(vec3(0.85, 0.85, 0.85), max(dot(nrm, key), float(0))), vec3(0.15, 0.15, 0.15));');
    expect(code).toContain('const adv = max(mul(max(d, eps), stepScale), gap);');
    expect(code).toContain('const stepScale = float(1);');
    expect(code).not.toContain('const occ = ');
    expect(code).not.toContain('const sh = float(1).toVar();');
    expect(code).not.toContain('LightColor');
    expect(code).not.toContain('Ambient');
  });

  it('light direction, occlusion, shadow and step scale round-trip as numbers AND as wires', () => {
    const values = { lightX: -1, lightY: 0.25, lightZ: 0.5, ao: 0.7, shadow: 0.3, stepScale: 0.6 };
    const { code } = surface(values);
    expect(code).toContain('const occ = add(');
    expect(code).toContain('const aoF = clamp(sub(float(1), mul(occ, mul(float(3), ao))), float(0), float(1));');
    expect(code).toContain('const sh = float(1).toVar();');
    expect(code).toContain('sh.assign(min(sh, div(hd, mul(shadow, st))));');
    expect(code).toContain('const lam = add(mul(vec3(0.85, 0.85, 0.85), mul(max(dot(nrm, key), float(0)), shF)), mul(vec3(0.15, 0.15, 0.15), aoF));');
    const r = codeToGraph(code);
    expect(r.errors.filter((e) => e.severity !== 'warning')).toHaveLength(0);
    const back = r.nodes.find((n) => n.data.registryType === 'raymarchOutput')!;
    expect(getNodeValues(back)).toMatchObject(values);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
    // Wired: a Float drives the light's X.
    const f = makeNode('f', 'float', { value: 0.3 });
    const wired = surface({}, [f], [makeEdge('f', 'out', 'rm', 'lightX')]);
    expect(wired.code).toContain('const lightX = float(float1);');
    const r2 = codeToGraph(wired.code);
    expect(r2.edges.some((e) => e.targetHandle === 'lightX')).toBe(true);
    expect(graphToCode(r2.nodes, r2.edges).code).toBe(wired.code);
  });

  it('light colour and ambient: a swatch emits color(0x…) and comes back as the stored value; a wire is a captured chain', () => {
    const { code } = surface({ lightColor: '#ffcc88', ambient: '#102030' });
    expect(code).toContain('const rm1LightColor = color(0xffcc88);');
    expect(code).toContain('const rm1Ambient = color(0x102030);');
    expect(code).toContain('const lam = add(mul(rm1LightColor, max(dot(nrm, key), float(0))), rm1Ambient);');
    const r = codeToGraph(code);
    const back = r.nodes.find((n) => n.data.registryType === 'raymarchOutput')!;
    expect(getNodeValues(back)).toMatchObject({ lightColor: '#ffcc88', ambient: '#102030' });
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    const wired = surface({}, [c], [makeEdge('c', 'out', 'rm', 'ambient')]);
    expect(wired.code).toContain('const rm1Ambient = color1;');
    const r2 = codeToGraph(wired.code);
    expect(r2.edges.some((e) => e.targetHandle === 'ambient')).toBe(true);
    expect(graphToCode(r2.nodes, r2.edges).code).toBe(wired.code);
  });

  it('occlusion and shadow are priced as extra Field taps only while switched on', () => {
    const off = surface();
    const base = computeReachableCost(off.nodes, off.edges);
    const aoOn = surface({ ao: 0.5 });
    const shOn = surface({ shadow: 0.2 });
    const fieldCost = getCost('sdCircle');
    expect(computeReachableCost(aoOn.nodes, aoOn.edges)).toBe(base + 5 * fieldCost);
    expect(computeReachableCost(shOn.nodes, shOn.edges)).toBe(base + 24 * fieldCost);
  });
});

describe('property names vs the march\'s own names', () => {
  const traverse = (typeof (_traverse as unknown as { default?: unknown }).default === 'function'
    ? (_traverse as unknown as { default: typeof _traverse }).default
    : _traverse) as typeof _traverse;
  /** The 13 number sockets — the ones read as `float(<ref>)` / `int(<ref>)` inside the march IIFE. */
  const NUMBER_SOCKETS = Object.keys(NODE_REGISTRY.get('raymarchOutput')!.defaultValues!);
  const prop = (name: string, value = 0.5) => makeNode('pr', 'property_float', { name, value });

  /**
   * Everything switched on — Field, Density, Glow, Color, Emissive and
   * Background all depend on their root, Occlusion, Shadow, Bend and Horizon
   * are non-zero — so every local the march can declare is in the text.
   */
  const fullMarch = (values: Record<string, string | number> = {}) => {
    const rm = makeNode('rm', 'raymarchOutput', { ao: 0.5, shadow: 0.3, bend: 0.2, horizon: 0.1, ...values });
    const nodes: AppNode[] = [
      makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('len', 'length'), makeNode('dens', 'oneMinus'),
      makeNode('gl', 'abs'), makeNode('cl', 'fract'), makeNode('em', 'normalize'),
      makeNode('dir', 'rayDirection'), makeNode('sky', 'length'), rm,
    ];
    const edges: AppEdge[] = [
      makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field'),
      makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'dens', 'x'), makeEdge('dens', 'out', 'rm', 'density'),
      makeEdge('pos', 'out', 'gl', 'x'), makeEdge('gl', 'out', 'rm', 'glow'),
      makeEdge('pos', 'out', 'cl', 'x'), makeEdge('cl', 'out', 'rm', 'color'),
      makeEdge('pos', 'out', 'em', 'v'), makeEdge('em', 'out', 'rm', 'emissive'),
      makeEdge('dir', 'out', 'sky', 'v'), makeEdge('sky', 'out', 'rm', 'background'),
    ];
    return { nodes, edges };
  };

  /** The `const rm<n> = Fn(() => {…})()` declarator's path. */
  const marchPath = (ast: ReturnType<typeof parse>, base = 'rm1'): NodePath<t.VariableDeclarator> => {
    let found: NodePath<t.VariableDeclarator> | null = null;
    traverse(ast, {
      VariableDeclarator(p) {
        if (t.isIdentifier(p.node.id, { name: base }) && t.isCallExpression(p.node.init) && t.isCallExpression(p.node.init.callee)) found = p;
      },
    });
    expect(found, base).not.toBeNull();
    return found!;
  };

  /** The IIFE body's own locals, every local at ANY depth inside it, and the step Fns' parameters. */
  const marchNames = (code: string) => {
    const ast = parse(code, { sourceType: 'module' });
    const rm = marchPath(ast);
    const iifeArrow = ((rm.node.init as t.CallExpression).callee as t.CallExpression).arguments[0];
    const iife = new Set<string>();
    const all = new Set<string>();
    rm.traverse({
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id)) return;
        all.add(p.node.id.name);
        if (p.getFunctionParent()?.node === iifeArrow) iife.add(p.node.id.name);
      },
      Function(p) {
        for (const prm of p.node.params) {
          const ids = t.isArrayPattern(prm) ? prm.elements : [prm];
          for (const id of ids) if (t.isIdentifier(id)) all.add(id.name);
        }
      },
    });
    const stepParams = new Set<string>();
    traverse(ast, {
      VariableDeclarator(p) {
        const init = p.node.init;
        if (!t.isIdentifier(p.node.id) || !/^rm1(Field|Density|Color|Emissive|Glow|Background)$/.test(p.node.id.name)) return;
        if (!t.isCallExpression(init) || !t.isIdentifier(init.callee, { name: 'Fn' })) return;
        const arrow = init.arguments[0];
        if (!t.isArrowFunctionExpression(arrow)) return;
        for (const prm of arrow.params) if (t.isArrayPattern(prm)) for (const id of prm.elements) if (t.isIdentifier(id)) stepParams.add(id.name);
      },
    });
    return { iife, all, stepParams };
  };

  it('MARCH_IIFE_LOCALS is exactly what the IIFE body declares, and the step Fns take only `p` and `dir`', () => {
    const { nodes, edges } = fullMarch();
    const { iife, stepParams } = marchNames(graphToCode(nodes, edges).code);
    expect([...iife].sort()).toEqual([...MARCH_IIFE_LOCALS].sort());
    expect([...stepParams].sort()).toEqual(['dir', 'p']);
    expect([...new Set(MARCH_SCOPES.flatMap((sp) => sp.params.map((prm) => prm.name)))].sort()).toEqual(['dir', 'p']);
  });

  it('a property named like ANY march local, wired to ANY number socket, is the one the march reads — and round-trips with its wire', () => {
    const { nodes: fullNodes, edges: fullEdges } = fullMarch();
    const { all } = marchNames(graphToCode(fullNodes, fullEdges).code);
    // The reserved names are a subset of what the walk sees; the rest (loop and
    // `nrm` locals) must stay bindable WITHOUT a rename.
    for (const name of MARCH_IIFE_LOCALS) expect(all.has(name), name).toBe(true);
    const bad: string[] = [];
    for (const name of all) {
      for (const socket of NUMBER_SOCKETS) {
        const nodes = [...fullNodes, prop(name)];
        const edges = [...fullEdges, makeEdge('pr', 'out', 'rm', socket)];
        const out = graphToCode(nodes, edges);
        const emitted = out.varNames.get('pr')!;
        const tag = `${name} → ${socket} (as ${emitted})`;
        let ast: ReturnType<typeof parse>;
        try {
          ast = parse(out.code, { sourceType: 'module' });
        } catch {
          bad.push(`${tag}: does not parse`);
          continue;
        }
        // The socket's ONE read must resolve to the property's declaration. A
        // shadowed read binds to the march's own local instead (or dies in its
        // TDZ), which leaves the uniform with no reference inside the march.
        const decl: { binding?: Binding } = {};
        traverse(ast, {
          VariableDeclarator(p) {
            const init = p.node.init;
            if (t.isIdentifier(p.node.id, { name: emitted }) && t.isCallExpression(init) && t.isIdentifier(init.callee, { name: 'uniform' })) {
              decl.binding = p.scope.getBinding(emitted);
            }
          },
        });
        if (!decl.binding) { bad.push(`${tag}: no uniform declaration`); continue; }
        const rm = marchPath(ast);
        const reads = decl.binding.referencePaths.filter((rp) => rp.isDescendant(rm));
        if (reads.length !== 1) bad.push(`${tag}: the march reads the property ${reads.length} times`);
        const r = codeToGraph(out.code);
        if (r.errors.length) bad.push(`${tag}: ${r.errors.map((e) => e.message).join('; ')}`);
        const pr = r.nodes.find((n) => n.data.registryType === 'property_float');
        if (!pr || !r.edges.some((e) => e.source === pr.id && e.targetHandle === socket)) bad.push(`${tag}: the wire is lost`);
        if (graphToCode(r.nodes, r.edges).code !== out.code) bad.push(`${tag}: not byte-stable`);
      }
    }
    expect(bad).toEqual([]);
    // Every local × every socket, each parsed and round-tripped: ~4 s in a full
    // run, so the default 5 s limit would fail the release gate under load
    // (docs/dev/testing.md, wall-clock tests).
  }, 60_000);

  it('`p` and `dir` are the step Fns\' parameters: a property of that name moves to p2 / dir2 and is read as itself', () => {
    // Read inside the Field chain: the chain's own `p` must not capture it.
    const inChain = {
      nodes: [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('ad', 'add'), prop('p'), makeNode('rm', 'raymarchOutput')],
      edges: [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'ad', 'a'), makeEdge('pr', 'out', 'ad', 'b'), makeEdge('ad', 'out', 'rm', 'field')],
    };
    // Wired straight into Field (a constant field) and into Density.
    const constField = { nodes: [prop('p'), makeNode('rm', 'raymarchOutput')], edges: [makeEdge('pr', 'out', 'rm', 'field')] };
    const constDensity = { nodes: [prop('p'), makeNode('rm', 'raymarchOutput')], edges: [makeEdge('pr', 'out', 'rm', 'density')] };
    // Read inside the Background chain, whose parameter is `dir`.
    const { nodes: vn, edges: ve } = volumeGraph();
    const inSky = {
      nodes: [...vn, makeNode('dir', 'rayDirection'), makeNode('mu', 'mul'), prop('dir')],
      edges: [...ve, makeEdge('dir', 'out', 'mu', 'a'), makeEdge('pr', 'out', 'mu', 'b'), makeEdge('mu', 'out', 'rm', 'background')],
    };
    const cases: [string, { nodes: AppNode[]; edges: AppEdge[] }, string, string][] = [
      ['in the Field chain', inChain, 'p2', 'add(sdCircle1, p2)'],
      ['a constant Field', constField, 'p2', 'const rm1Field = Fn(([p]) => p2);'],
      ['a constant Density', constDensity, 'p2', '  const rm1Density = Fn(([p]) => {\n    return p2;\n  });'],
      ['in the Background chain', inSky, 'dir2', 'mul(rayDirection1, dir2)'],
    ];
    for (const [label, g, name, text] of cases) {
      const { code } = graphToCode(g.nodes, g.edges);
      expect(code, label).toContain(`const ${name} = uniform(0.5);`);
      expect(code, label).toContain(text);
      const r = codeToGraph(code);
      expect(r.errors, label).toEqual([]);
      expect(graphToCode(r.nodes, r.edges).code, label).toBe(code);
    }
  });

  it('a march that does not DRIVE renames nothing: a mesh shader\'s public property keeps its name, byte for byte', () => {
    // A property's name is its schema key, its A-Frame attribute and its
    // persisted-uniform key — reserved names move it only while the march runs.
    const flag = (n: AppNode): AppNode => ({ ...n, data: { ...n.data, activeOutput: true } }) as AppNode;
    for (const name of [...MARCH_IIFE_LOCALS, 'p', 'dir']) {
      const pr = prop(name, 3);
      const mesh = { nodes: [pr, makeNode('out', 'output')], edges: [makeEdge('pr', 'out', 'out', 'roughness')] };
      const before = graphToCode(mesh.nodes, mesh.edges).code;
      expect(before, name).toContain(`const ${name} = uniform(3);`);
      // Unwired…
      expect(graphToCode([...mesh.nodes, makeNode('rm', 'raymarchOutput')], mesh.edges).code, name).toBe(before);
      // …and wired but parked behind a flagged plain Output.
      const parked = graphToCode(
        [pr, flag(makeNode('out', 'output')), makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('rm', 'raymarchOutput')],
        [...mesh.edges, makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field')],
      ).code;
      expect(parked, name).toContain(`const ${name} = uniform(3);`);
      // The moment it drives, the march's name wins and the property moves.
      const driving = graphToCode([pr, makeNode('rm', 'raymarchOutput')], [makeEdge('pr', 'out', 'rm', 'field')]).code;
      expect(driving, name).toContain(`const ${name}2 = uniform(3);`);
    }
  });

  it('the exported module names a RENAMED property as the body reads it: no dead attribute beside it', () => {
    // A property named like a march local, read in the flat body (Glow) and in
    // the IIFE (Bend): the namer moves it to `shadow2` / `bend2` while the march
    // drives, so the schema and the usage header must say so too — the stored
    // name would be an attribute nothing reads (review 2026-10-27).
    for (const [name, socket] of [['shadow', 'glow'], ['bend', 'bend']] as const) {
      const { nodes: fullNodes, edges: fullEdges } = fullMarch();
      const nodes = [...fullNodes.filter((n) => socket !== 'glow' || n.id !== 'gl'), prop(name, 0.4)];
      const edges = [...fullEdges.filter((e) => e.targetHandle !== socket), makeEdge('pr', 'out', 'rm', socket)];
      const { code, varNames } = graphToCode(nodes, edges);
      expect(varNames.get('pr'), name).toBe(`${name}2`);
      const m = buildExportModule({ inlineImages: true, graph: { nodes, edges, code, omitted: 0, uniformKeys: null } });
      expect(m, name).toContain(`shader="src: shader.js; ${name}2: 0.4"`);
      expect(m, name).toContain(`  ${name}2: { type: 'number', default: 0.4 },`);
      expect(m, name).not.toContain(`  ${name}: { type: 'number'`);
      expect(m, name).toContain(`const ${name}2 = params.${name}2;`);
    }
  });

  it('a property already called rm1LightColor / rm1Ambient moves the march to rm2 instead of declaring the name twice', () => {
    for (const name of ['rm1LightColor', 'rm1Ambient']) {
      const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), prop(name), makeNode('rm', 'raymarchOutput', { lightColor: '#ffcc88', ambient: '#102030' })];
      const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field'), makeEdge('pr', 'out', 'rm', 'bend')];
      const { code } = graphToCode(nodes, edges);
      expect(code, name).toContain(`  const ${name} = uniform(0.5);`);
      expect(code, name).toContain('  const rm2LightColor = color(0xffcc88);');
      expect(code, name).toContain('  const rm2Ambient = color(0x102030);');
      expect(code, name).toContain(`    const bend = float(${name});`);
      expect(() => parse(code, { sourceType: 'module' }), name).not.toThrow();
      const r = codeToGraph(code);
      expect(r.errors, name).toEqual([]);
      expect(r.nodes.some((n) => n.data.registryType === 'property_float' && getNodeValues(n).name === name), name).toBe(true);
      expect(getNodeValues(r.nodes.find((n) => n.data.registryType === 'raymarchOutput')!), name).toMatchObject({ lightColor: '#ffcc88', ambient: '#102030' });
      expect(graphToCode(r.nodes, r.edges).code, name).toBe(code);
    }
  });

  it('the parse tells a property named like a march channel from the channel: a `uniform(…)` is never one', () => {
    for (const name of ['rm1Field', 'rm1Ambient', 'rm1LightColor', 'rm1Color']) {
      const nodes = [prop(name), makeNode('out', 'output')];
      const edges = [makeEdge('pr', 'out', 'out', 'roughness')];
      const { code } = graphToCode(nodes, edges);
      expect(code, name).toContain(`const ${name} = uniform(0.5);`);
      const r = codeToGraph(code);
      expect(r.errors, name).toEqual([]);
      expect(r.nodes.map((n) => n.data.registryType).sort(), name).toEqual(['output', 'property_float']);
      expect(r.nodes.some((n) => n.data.registryType === 'raymarchOutput'), name).toBe(false);
      expect(graphToCode(r.nodes, r.edges).code, name).toBe(code);
    }
    // A colour property, through the same guard.
    const pc = makeNode('pc', 'property_color', { name: 'rm1Color', hex: '#336699' });
    const { code } = graphToCode([pc, makeNode('out', 'output')], [makeEdge('pc', 'out', 'out', 'color')]);
    const r = codeToGraph(code);
    expect(r.nodes.some((n) => n.data.registryType === 'property_color' && getNodeValues(n).name === 'rm1Color')).toBe(true);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });
});
