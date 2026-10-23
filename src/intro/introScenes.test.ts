/**
 * The intro's slides as data, and the rules every slide keeps: it writes
 * nothing, and the heavy chunks (the Babel parser, the image encoder) arrive
 * only when their slide shows — the intro itself opens at boot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import type { AppNode } from '@/types';
import { buildImageTour, imageFrame } from './imageTour';
import { buildFolderTour, folderFrame, EDIT_FROM, EDIT_TO } from './folderTour';
import { buildCodeTour, codeFrame, codeSnapshots, tokenClasses, CODE_PLAN } from './codeTour';
import { buildExposeTour, exposeFrame } from './exposeTour';
import { buildDrawTour, drawFrame, flowerStrokes, penAt, strokePrefix } from './drawTour';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { usesExposedPorts } from '@/utils/exposedPorts';
import { buildPreviewTour, modifierCap, previewFrame } from './previewTour';
import {
  CHAOS,
  ORGANIZE_EDGES,
  ORGANIZE_NODES,
  buildOrganizeTour,
  marqueeHits,
  nodeAt,
  organizeFrame,
  organizeGraph,
  organizedPositions,
} from './organizeTour';
import { organizeLayout } from '@/engine/layoutEngine';
import { UNIFORM_HIGH, UNIFORM_LOW, UNIFORM_START, buildUniformTour, thumbAt, uniformFrame } from './uniformTour';
import { INTRO_MODELS, IRON, MODEL_OUTPUT, SPHERE_TUNE, buildModelTour, combinePresets, modelFrame } from './modelTour';
import { buildPreviewShaderModule } from '@/engine/tslToPreviewHTML';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { previewGraph } from '@/utils/nodePreview';
import { sceneNodes, toAppEdges } from './sceneGraph';
import { VALUES_CLICKS, VALUES_FLOAT, buildValuesTour, valuesFrame, valuesGraph } from './valuesTour';
import { LABELS_PAIR_MS, buildLabelsTour, labelsFrame } from './labelsTour';
import { DOUBLE_ACTIVATE_MS } from '@/components/NodeEditor/labelPeek';
import { evaluateEdgeRange, getEdgeOutputShape } from '@/engine/cpuEvaluator';
import { edgeChipChannels } from '@/components/NodeEditor/edges/EdgeInfoCard';
import { readGltfModel } from '@/utils/gltfReader';
import { glbImportFactsOf, planGlbImportDialog } from '@/utils/glbImportGate';

const lone = () =>
  graphToCode(
    [{ id: 'o', type: 'output', position: { x: 0, y: 0 }, data: { registryType: 'output', label: 'Output', cost: 0 } } as unknown as AppNode],
    [],
  ).code;

/** Every distinct state tag a tour passes through, in order. */
function tags<S>(total: number, at: (t: number) => S, tag: (s: S) => string): string[] {
  const out: string[] = [];
  for (let t = 0; t < total; t += 5) {
    const s = tag(at(t));
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

describe('image slide', () => {
  const geo = { enter: { x: -40, y: 230 }, drop: { x: 196, y: 64 }, yes: { x: 400, y: 200 }, ok: { x: 420, y: 260 } };

  it('drags in, asks, places the node with the device notice, then shows the node alone', () => {
    const tour = buildImageTour(geo, { notice: true });
    const seen = tags(tour.tl.total, (t) => imageFrame(tour, t).state, (s) =>
      s.dragging ? 'drag' : s.ask ? 'ask' : s.notice ? 'node+notice' : s.node ? 'node' : 'idle');
    expect(seen).toEqual(['drag', 'ask', 'node+notice', 'node']);
  });

  it('skips the notice when the photo fit the device', () => {
    const tour = buildImageTour(geo, { notice: false });
    for (let t = 0; t < tour.tl.total; t += 5) expect(imageFrame(tour, t).state.notice).toBe(false);
    expect(imageFrame(tour, tour.placed).state).toMatchObject({ node: true, ask: false });
  });
});

describe('work folder slide', () => {
  const geo = {
    pick: { x: 400, y: 20 }, caret: { x: 420, y: 20 }, save: { x: 390, y: 20 },
    rows: { 'waves.js': { x: 200, y: 120 }, 'metal.js': { x: 200, y: 90 } }, value: { x: 160, y: 170 },
  };

  it('picks, loads waves, loads metal, scrubs the value, saves', () => {
    const tour = buildFolderTour(geo);
    const seen = tags(tour.tl.total, (t) => folderFrame(tour, t).state, (s) =>
      `${s.picked ? 'P' : '-'}${s.list ? 'L' : '-'}:${s.doc}${s.saved ? ':saved' : ''}`);
    expect(seen).toEqual([
      '--:none', 'P-:none', 'PL:none', 'P-:waves.js', 'PL:waves.js', 'P-:metal.js', 'P-:metal.js:saved', 'P-:metal.js',
    ]);
  });

  it('the scrub only raises the value, from EDIT_FROM to EDIT_TO, before Save', () => {
    const tour = buildFolderTour(geo);
    const values = tags(tour.tl.total, (t) => folderFrame(tour, t).state, (s) => String(s.value));
    expect(Number(values[0])).toBe(EDIT_FROM);
    expect(Number(values[values.length - 1])).toBe(EDIT_TO);
    expect(values.map(Number)).toEqual([...values.map(Number)].sort((a, b) => a - b));
    expect(folderFrame(tour, tour.saved).state).toMatchObject({ saved: true, value: EDIT_TO });
  });
});

describe('code slide', () => {
  it('every edit finds its anchor in the code the app shows for a fresh graph', () => {
    const snaps = codeSnapshots(lone());
    expect(snaps).not.toBeNull();
    expect(snaps).toHaveLength(CODE_PLAN.filter((p) => p === 'apply').length);
  });

  it('each Apply parses cleanly into the graph the slide promises — no stray Vec3 from the empty Output', () => {
    const [first, last] = codeSnapshots(lone())!;
    const types = (code: string) => {
      const r = codeToGraph(code);
      expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
      return {
        nodes: r.nodes.map((n) => n.data.registryType).sort(),
        edges: r.edges.map((e) => {
          const t = (id: string) => r.nodes.find((n) => n.id === id)!.data.registryType;
          return `${t(e.source)}.${e.sourceHandle}>${t(e.target)}.${e.targetHandle}`;
        }).sort(),
      };
    };
    expect(types(first)).toEqual({ nodes: ['output', 'perlin'], edges: ['perlin.out>output.color'] });
    expect(types(last)).toEqual({
      nodes: ['output', 'perlin', 'sin', 'time'],
      edges: ['perlin.out>output.color', 'sin.out>perlin.scale', 'time.out>sin.x'],
    });
  });

  it('types, Applies, types, Applies — the graph never runs ahead of the code', () => {
    const tour = buildCodeTour(lone(), { apply: { x: 520, y: 170 }, rest: { x: 470, y: 262 } })!;
    expect(tour).not.toBeNull();
    const snaps = codeSnapshots(lone())!;
    const applied = tags(tour.tl.total, (t) => codeFrame(tour, t).state, (s) => String(s.applied));
    expect(applied).toEqual(['0', '1', '2']);
    // At each Apply the code on screen is the snapshot the graph was built from.
    for (let t = 0; t < tour.tl.total; t += 5) {
      const s = codeFrame(tour, t).state;
      if (s.applied > 0 && s.caret === null && !s.pressed) {
        const next = snaps[s.applied - 1];
        if (s.text === next) continue;
        // Typing for the NEXT Apply has started; the graph still shows the last one.
        expect(s.text.length).toBeGreaterThan(next.length);
      }
    }
    expect(codeFrame(tour, tour.still).state.applied).toBe(2);
    expect(tour.liveFrom).toBeLessThan(tour.still);
  });

  it('colours keywords, strings and numbers, not identifiers that end in a digit', () => {
    const src = "const sin1 = vec3(1, 0); import 'x';";
    const cls = tokenClasses(src);
    expect(cls.slice(0, 5)).toEqual(['kw', 'kw', 'kw', 'kw', 'kw']);
    expect(cls[src.indexOf('sin1') + 3]).toBeNull();
    expect(cls[src.indexOf('(1') + 1]).toBe('num');
    expect(cls[src.indexOf("'x'")]).toBe('str');
  });
});

describe('sockets slide', () => {
  const geo = {
    noise: { x: 100, y: 120 }, output: { x: 440, y: 60 }, paramBox: { x: 140, y: 190 }, channelBox: { x: 330, y: 90 },
    away: { x: 250, y: 268 }, from: { x: 190, y: 190 }, to: { x: 372, y: 110 },
  };

  it('ticks the parameter, then the channel, each in its own menu, then wires into the new socket', () => {
    const tour = buildExposeTour(geo);
    const seen = tags(tour.tl.total, (t) => exposeFrame(tour, t).state, (s) =>
      `${s.menu}${s.param ? '+p' : ''}${s.channel ? '+c' : ''}${s.dragging ? '+drag' : ''}${s.wired ? '+w' : ''}`);
    expect(seen).toEqual(['none', 'noise', 'noise+p', 'none+p', 'output+p', 'output+p+c', 'none+p+c', 'none+p+c+drag', 'none+p+c+w']);
  });

  it('the noise really offers that parameter as a socket, and the Output that channel', () => {
    const perlin = NODE_REGISTRY.get('perlin')!;
    expect(usesExposedPorts(perlin)).toBe(true);
    expect(Object.keys(perlin.defaultValues ?? {})).toContain('scale');
    expect(NODE_REGISTRY.get('output')!.inputs.map((p) => p.id)).toContain('emissive');
    const menu = readFileSync(path.join(__dirname, '../components/NodeEditor/menus/ShaderSettingsMenu.tsx'), 'utf8');
    expect(menu).toMatch(/const OPTIONAL_OUTPUT_PORTS = \[[^\]]*'emissive'/);
  });
});

describe('annotation slide', () => {
  const centre = { x: 468, y: 184 };
  const r = 30;
  const flower = flowerStrokes(centre, r);
  const [petals, ring, stem, leaf] = flower;

  it('is a flower in four strokes: petals round the head, a centre inside them, a stem below, a leaf off the stem', () => {
    expect(flower).toHaveLength(4);
    const dist = (p: { x: number; y: number }) => Math.hypot(p.x - centre.x, p.y - centre.y);
    // Five petals: once round the head, the outline swells out past 80% of
    // the radius in five separate runs (the hand wobble cannot split one).
    const rs = petals.map(dist);
    const out = rs.map((v) => v > r * 0.8);
    const runs = out.filter((o, i) => o && !out[(i + out.length - 1) % out.length]).length;
    expect(runs).toBe(5);
    expect(Math.max(...ring.map(dist))).toBeLessThan(Math.min(...rs));
    expect(Math.min(...stem.map((p) => p.y))).toBeGreaterThan(centre.y);
    expect(Math.max(...stem.map((p) => p.y))).toBeGreaterThan(centre.y + 2 * r);
    // The leaf comes back to the stem, near (not onto) where it left it.
    expect(Math.hypot(leaf[0].x - leaf[leaf.length - 1].x, leaf[0].y - leaf[leaf.length - 1].y)).toBeLessThan(4);
    // Drawn by hand: no two petals alike, the same flower every time.
    const reach = (i: number) => Math.max(...petals.slice(i * 34, (i + 1) * 34).map(dist));
    expect(new Set([0, 1, 2, 3, 4].map((i) => reach(i).toFixed(1))).size).toBe(5);
    expect(flowerStrokes(centre, r)).toEqual(flower);
  });

  it('a stroke grows from nothing to whole, and the pen sits at its end', () => {
    expect(strokePrefix(stem, 0)).toEqual([]);
    expect(strokePrefix(stem, 1)).toEqual(stem);
    const half = strokePrefix(stem, 0.5);
    expect(half.length).toBeGreaterThan(1);
    expect(half.length).toBeLessThan(stem.length);
    expect(penAt(stem, 0.5)).toEqual(half[half.length - 1]);
  });

  it('Draw on, every stroke in order, Draw off, menu, the note typed — and the pen IS the pointer while drawing', () => {
    const geo = { drawBtn: { x: 150, y: 270 }, strokes: flower, noteClick: { x: 200, y: 120 }, noteRow: { x: 230, y: 220 } };
    const text = 'Flower';
    const tour = buildDrawTour(geo, text);
    const seen = tags(tour.tl.total, (t) => drawFrame(tour, t).state, (s) =>
      s.stroke >= 0 ? `stroke${s.stroke}` : s.menu ? 'menu' : s.note ? 'note' : s.draw ? 'draw' : 'idle');
    expect(seen).toEqual([
      'idle', 'draw', 'stroke0', 'draw', 'stroke1', 'draw', 'stroke2', 'draw', 'stroke3', 'draw', 'idle', 'menu', 'note',
    ]);
    for (let t = 0; t < tour.tl.total; t += 25) {
      const f = drawFrame(tour, t);
      if (f.state.stroke >= 0) expect(f.cursor).toEqual(penAt(flower[f.state.stroke], f.progress[f.state.stroke]));
    }
    expect(drawFrame(tour, tour.still).state.typed).toBe(text.length);
    expect(drawFrame(tour, tour.still).progress).toEqual([1, 1, 1, 1]);
  });
});

describe('organize slide', () => {
  // Cards of plausible size; the scene passes the measured ones.
  const sizes = new Map<string, { width: number; height: number }>(ORGANIZE_NODES.map(({ id }) => [id, { width: 110, height: id === 'o-output' ? 190 : 70 }]));
  const organized = organizedPositions(sizes)!;
  const boxes = (at: ReadonlyMap<string, { x: number; y: number }>) =>
    [...at].map(([id, p]) => ({ id, x: p.x, y: p.y, w: sizes.get(id)!.width, h: sizes.get(id)!.height }));
  const overlaps = (at: ReadonlyMap<string, { x: number; y: number }>) => {
    const b = boxes(at);
    let n = 0;
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (marqueeHits({ x: b[i].x, y: b[i].y }, { x: b[i].x + b[i].w, y: b[i].y + b[i].h }, [b[j]]).size) n++;
    return n;
  };

  it('starts as a heap: cards piled over each other, wires running backwards', () => {
    const chaos = new Map(Object.entries(CHAOS));
    expect(overlaps(chaos)).toBeGreaterThan(2);
    expect(ORGANIZE_EDGES.filter((e) => CHAOS[e.source].x > CHAOS[e.target].x).length).toBeGreaterThan(2);
    expect(organizeGraph().nodes).toHaveLength(9);
  });

  it('Organize is the canvas’s own: nothing overlaps, every wire runs left to right, the heap’s corner is kept', () => {
    const { nodes, edges } = organizeGraph();
    const own = organizeLayout(nodes.map((n) => ({ ...n, selected: true, measured: sizes.get(n.id) }) as AppNode), edges)!;
    expect(organized).toEqual(own);
    expect(overlaps(organized)).toBe(0);
    for (const e of ORGANIZE_EDGES) expect(organized.get(e.source)!.x).toBeLessThan(organized.get(e.target)!.x);
    const min = (m: ReadonlyMap<string, { x: number; y: number }>, k: 'x' | 'y') => Math.min(...[...m.values()].map((p) => p[k]));
    const chaos = new Map(Object.entries(CHAOS));
    expect(min(organized, 'x')).toBeCloseTo(min(chaos, 'x'));
    expect(min(organized, 'y')).toBeCloseTo(min(chaos, 'y'));
  });

  it('the marquee selects what it touches (Partial), not only what it holds', () => {
    const hit = marqueeHits({ x: 0, y: 0 }, { x: 50, y: 50 }, [
      { id: 'in', x: 10, y: 10, w: 20, h: 20 },
      { id: 'touch', x: 40, y: 40, w: 100, h: 100 },
      { id: 'out', x: 60, y: 0, w: 10, h: 10 },
    ]);
    expect([...hit].sort()).toEqual(['in', 'touch']);
  });

  it('heap, marquee, selected, menu, organized — and the nodes stay in the heap until Organize is pressed', () => {
    const tour = buildOrganizeTour({
      marqueeFrom: { x: 10, y: 10 },
      marqueeTo: { x: 540, y: 280 },
      menuClick: { x: 270, y: 150 },
      organizeRow: { x: 320, y: 190 },
      chaos: new Map(Object.entries(CHAOS)),
      organized,
    });
    const seen = tags(tour.tl.total, (t) => organizeFrame(tour, t).state, (s) =>
      s.organized ? 'organized' : s.menu ? 'menu' : s.marquee ? 'marquee' : s.selected ? 'selected' : 'heap');
    expect(seen).toEqual(['heap', 'marquee', 'selected', 'menu', 'organized']);
    const menu = organizeFrame(tour, tour.menu);
    for (const { id } of ORGANIZE_NODES) expect(nodeAt(menu.key, id)).toEqual(CHAOS[id]);
    const done = organizeFrame(tour, tour.organized);
    for (const { id } of ORGANIZE_NODES) {
      const p = nodeAt(done.key, id);
      expect(p.x).toBeCloseTo(organized.get(id)!.x);
      expect(p.y).toBeCloseTo(organized.get(id)!.y);
    }
    expect(done.state.selected).toBe(true);
  });
});

describe('preview / attach slide', () => {
  const geo = { node: { x: 60, y: 190 }, away: { x: 250, y: 30 }, colorRow: { x: 120, y: 50 } };

  it('Preview with its modifier, a press elsewhere ends it, Attach with the other, then Color', () => {
    const tour = buildPreviewTour(geo);
    const seen = tags(tour.tl.total, (t) => previewFrame(tour, t).state, (s) =>
      `${s.key ?? '-'}:${s.previewing ? 'P' : ''}${s.menu ? 'M' : ''}${s.attached ? 'A' : ''}`);
    expect(seen).toEqual(['-:', 'preview:', 'preview:P', '-:P', '-:', 'attach:', 'attach:M', '-:M', '-:A']);
  });

  it('names the modifier the way the keyboard in front of the user does', () => {
    expect(modifierCap('preview', true)).toContain('⌥');
    expect(modifierCap('attach', true)).toContain('⌘');
    expect(modifierCap('preview', false)).toBe('Alt');
    expect(modifierCap('attach', false)).toBe('Ctrl');
  });

  it('Preview mode routes the node into Color in a DERIVED graph, never the scene\'s own', () => {
    const nodes = sceneNodes([
      { id: 'p', def: NODE_REGISTRY.get('perlin')! },
      { id: 'v', def: NODE_REGISTRY.get('voronoi')! },
      { id: 'o', def: NODE_REGISTRY.get('output')! },
    ]);
    const edges = toAppEdges([{ source: 'p', sourceHandle: 'out', target: 'o', targetHandle: 'color' }]);
    const derived = previewGraph(nodes, edges, { nodeId: 'v', handleId: 'out' });
    expect(derived.edges.some((e) => e.source === 'v' && e.targetHandle === 'color')).toBe(true);
    expect(derived.edges.some((e) => e.source === 'p' && e.targetHandle === 'color')).toBe(false);
    expect(edges).toHaveLength(1);
  });
});

describe('uniforms slide', () => {
  const geo = { track: { x0: 340, x1: 500, y: 60 }, bounds: { min: 0, max: 10 }, setDefault: { x: 440, y: 30 } };

  it('drags down to coarse, up to fine, then bakes it — the thumb under the pointer all the way', () => {
    const tour = buildUniformTour(geo);
    const values = tags(tour.tl.total, (t) => uniformFrame(tour, t).state, (s) => `${s.value}${s.baked ? 'b' : ''}`);
    expect(values[0]).toBe(String(UNIFORM_START));
    expect(values).toContain(String(UNIFORM_LOW));
    expect(values[values.length - 1]).toBe(`${UNIFORM_HIGH}b`);
    expect(uniformFrame(tour, tour.tuned).state).toMatchObject({ value: UNIFORM_HIGH, baked: false });
    expect(uniformFrame(tour, tour.baked).state).toMatchObject({ value: UNIFORM_HIGH, baked: true });
    expect(thumbAt(geo, 0).x).toBe(340);
    expect(thumbAt(geo, 10).x).toBe(500);
    expect(thumbAt(geo, 5).x).toBe(420);
  });
});

describe('models slide', () => {
  const presets = getBuiltinPresets();
  const wave = presets.find((p) => p.id === 'vertex-wave')!;
  const field = presets.find((p) => p.id === 'checker')!;

  it('one graph: Vertex Wave into Displacement at amplitude 0.03, Checker into Color with Iron for its dark squares', () => {
    const g = combinePresets(wave, field);
    const into = g.edges.filter((e) => e.target === MODEL_OUTPUT).map((e) => e.targetHandle).sort();
    expect(into).toEqual(['color', 'position']);
    const code = graphToCode(g.nodes, g.edges).code;
    expect(code).toMatch(/waveAmplitude = uniform\(0\.03\)/);
    expect(IRON).toBe('#c5c7c8');
    expect(code).toMatch(/checkColorB = uniform\(color\(0xc5c7c8\)\)/i);
    // Projected from the geometry's positions, not its UVs — all three axes.
    expect(code).not.toMatch(/\buv\(/);
    expect(code).toMatch(/positionGeometry/);
    expect(code).toMatch(/\.z\b/);
    expect(code.match(/floor\(/g)?.length).toBe(3);
    // The figure: count 16, frequency 150, amplitude 0.001; the sphere: UVs.
    const figure = INTRO_MODELS[1].tune;
    expect(figure).toEqual({ amplitude: 0.001, frequency: 150, count: 16, projection: 'position' });
    const fig = combinePresets(wave, field, figure);
    const figCode = graphToCode(fig.nodes, fig.edges).code;
    expect(figCode).toMatch(/waveAmplitude = uniform\(0\.001\)/);
    expect(figCode).toMatch(/waveFrequency = uniform\(150\)/);
    expect(figCode).toMatch(/\bcount = uniform\(16\)/);
    const sphere = combinePresets(wave, field, SPHERE_TUNE);
    const sphereCode = graphToCode(sphere.nodes, sphere.edges).code;
    expect(sphereCode).toMatch(/\buv\(/);
    expect(sphereCode.match(/floor\(/g)?.length).toBe(2);
    // …and the seam fix applies to it: a position wave, a uv colour.
    expect(buildPreviewShaderModule(sphereCode)).toContain('uvDisplaced: false');
  });

  it('asks "Only Mesh / Mesh with Materials" exactly where the app does: the textured figure, not Rodin', () => {
    const ctx = { allowManyMaterials: false, ignoreImageLimits: false, deviceMaxDim: 2048 };
    const offered = INTRO_MODELS.map(({ fileName, path: p }) => {
      const bytes = new Uint8Array(readFileSync(path.join(__dirname, '../../public', p)));
      const read = readGltfModel(bytes, 'glb');
      const facts = read.ok ? glbImportFactsOf(read.model, fileName, bytes.length) : null;
      return planGlbImportDialog(facts, ctx).offer;
    });
    expect(offered).toEqual([false, true]);
  });

  it('drops each model in turn, answering the question only where it is asked', () => {
    const geo = { enter: { x: -40, y: 236 }, drop: { x: 280, y: 150 }, onlyMesh: { rodin: null, figure: { x: 250, y: 200 } } };
    const tour = buildModelTour(geo);
    const seen = tags(tour.tl.total, (t) => modelFrame(tour, t).state, (s) => `${s.shown}${s.dragging ? `>${s.dragging}` : ''}${s.ask ? `?${s.ask}` : ''}`);
    expect(seen).toEqual(['sphere', 'sphere>rodin', 'rodin', 'rodin>figure', 'rodin?figure', 'figure']);
    expect(modelFrame(tour, tour.figure).state.shown).toBe('figure');
  });
});

describe('wire values slide', () => {
  const graph = valuesGraph();
  const chip = (source: string, t = 0) => {
    const e = graph.edges.find((x) => x.source === source && x.target === 'output')!;
    return edgeChipChannels(evaluateEdgeRange(e, graph.nodes, graph.edges, t), getEdgeOutputShape(e, graph.nodes, graph.edges));
  };

  it('shows a number, a range on two channels, three channels, and a live value — as the canvas chip words them', () => {
    expect(chip('float')).toEqual({ count: 1, values: [VALUES_FLOAT.toFixed(2)] });
    expect(chip('uv')).toEqual({ count: 2, values: ['0.00…1.00', '0.00…1.00'] });
    expect(chip('position').count).toBe(3);
    expect(chip('position').values.every((v) => v.includes('…'))).toBe(true);
    expect(chip('sine', 1)).toEqual({ count: 1, values: [Math.sin(1).toFixed(2)] });
    expect(chip('sine', 2).values).not.toEqual(chip('sine', 1).values);
  });

  it('shows one wire at a time, in that order, and clicks each before fading it out', () => {
    const p = { x: 0, y: 0 };
    const tour = buildValuesTour({ clicks: { float: p, uv: p, position: p, sine: p }, rest: { x: 10, y: 10 } });
    const seen = tags(tour.tl.total, (t) => valuesFrame(tour, t).state, (s) => `${s.phase}${s.selected ? ':chip' : ''}`);
    expect(seen).toEqual(VALUES_CLICKS.flatMap((w) => [w, `${w}:chip`]));
    for (const w of VALUES_CLICKS) {
      const f = valuesFrame(tour, tour.stills[w]);
      expect(f.state).toMatchObject({ phase: w, selected: true });
      expect(f.fade).toBe(1);
    }
  });
});

describe('socket labels slide', () => {
  const tour = buildLabelsTour({ image: { x: 100, y: 100 }, mix: { x: 400, y: 60 }, rest: { x: 250, y: 250 } });

  it('double-clicks the Image, puts its labels away, then double-taps Mix', () => {
    const seen = tags(tour.tl.total, (t) => labelsFrame(tour, t).state, (s) => `${s.peek ?? '-'}${s.touch ? ':touch' : ''}`);
    expect(seen).toEqual(['-', 'image', '-', '-:touch', 'mix:touch', '-:touch']);
    expect(labelsFrame(tour, tour.image).state.peek).toBe('image');
    expect(labelsFrame(tour, tour.mix).state).toMatchObject({ peek: 'mix', touch: true });
  });

  it('presses twice inside the canvas’s double-click window', () => {
    expect(LABELS_PAIR_MS).toBeLessThan(DOUBLE_ACTIVATE_MS);
    const presses = tags(tour.tl.total, (t) => labelsFrame(tour, t).state, (s) => (s.pressed ? 'down' : 'up')).filter((x) => x === 'down');
    // Two pairs, and the click / tap on empty canvas after each.
    expect(presses.length).toBe(6);
  });
});

describe('every slide', () => {
  const dir = __dirname;
  const scenes = readdirSync(dir).filter((f) => /Scene\.tsx$/.test(f));

  it('there are fourteen, and the window lists them all', () => {
    const win = readFileSync(path.join(dir, 'IntroWindow.tsx'), 'utf8');
    expect(scenes.sort()).toEqual([
      'BudgetScene.tsx', 'CodeScene.tsx', 'ConnectScene.tsx', 'DrawScene.tsx', 'ExposeScene.tsx', 'FolderScene.tsx', 'ImageScene.tsx', 'InsertScene.tsx',
      'LabelsScene.tsx', 'ModelScene.tsx', 'OrganizeScene.tsx', 'PreviewScene.tsx', 'UniformScene.tsx', 'ValuesScene.tsx',
    ]);
    for (const f of scenes) expect(win, f).toContain(`Scene: ${f.replace('.tsx', '')},`);
  });

  it('writes nothing: no graph, no history, no preference, no storage', () => {
    for (const f of readdirSync(dir).filter((x) => /\.tsx?$/.test(x) && !/\.test\.ts$/.test(x) && x !== 'introGate.ts')) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      // (A scene's own `setState` is React's useState setter, not the store's.)
      expect(src, f).not.toMatch(/\b(setNodes|setEdges|addNode|pushHistory|updateNodeData|setLanguage)\(|useAppStore\.setState|getState\(\)\.(set|add|push|update|remove|delete)\w*\(|localStorage|indexedDB|stashImageOrigin/);
    }
  });

  it('loads the parser, the libraries and the encoder only when their slide shows', () => {
    for (const f of scenes) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      // (Not layoutEngine: the store imports it statically, so it is on the
      // boot graph already and a slide's static import adds nothing.)
      expect(src, f).not.toMatch(/^import [^;]*from '@\/(engine\/codeToGraph|registry\/builtin(Textures|Presets)|utils\/imageImport)'/m);
    }
    expect(readFileSync(path.join(dir, 'CodeScene.tsx'), 'utf8')).toContain("import('@/engine/codeToGraph')");
    expect(readFileSync(path.join(dir, 'ImageScene.tsx'), 'utf8')).toContain("import('@/utils/imageImport')");
  });
});
