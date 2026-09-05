import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { computeReachableCost, nodeCostPoints, getCost } from '@/utils/nodeCost';
import { drivingMarchOutput, marchWindowRadius } from '@/utils/sdfPartition';
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
