import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getBuiltinTextures } from './builtinTextures';
import { NODE_REGISTRY } from './nodeRegistry';
import { codeToGraph } from '@/engine/codeToGraph';
import { graphToCode } from '@/engine/graphToCode';
import { nodeCostPoints } from '@/utils/nodeCost';
import { bridgeEdgesAcrossDeletedNodes } from '@/utils/edgeUtils';
import { pickSpliceInputPort } from '@/components/NodeEditor/edgeSplice';
import {
  LED_BRIGHTNESS,
  LED_CELL,
  LED_DISC_EDGE,
  LED_EMITTERS,
  LED_TILE_PIXELS,
  ledDisplayShade,
  ledEmitter,
  ledTileLevel,
  linearToSrgb,
} from '@/components/NodeEditor/ledDisplayTile';
import { getNodeValues } from '@/types';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

/**
 * The LED Display texture's contract.
 *
 * It was asked for as three things, and each is a property of the GRAPH — so a
 * later tidy-up of the snippet can break any of them while every generic
 * built-in suite stays green (those only ask that it parses and re-emits; the
 * byte-stability snapshot moves, and a deliberate edit re-records it):
 *
 *   1. ONE uniform sets the diode grid (`diodeScale`): it must really drive the
 *      grid, in whole pixels, and scrubbing it to 0 must not divide by zero.
 *   2. The picture comes from ONE swappable source: a noise node by default, an
 *      Image node when the user wants a picture. That holds only while the
 *      source is fed the CELL-CENTRE coordinate in ordinary 0-1 UV, by one
 *      node, and nothing downstream assumes the source was a noise.
 *   3. It is cheap, and the tile prints the price the CostBar charges.
 *
 * And, since the owner's "the diodes only get overlaid on top of the image"
 * (2026-10-02), one more: the diodes must REPRODUCE the picture — each emitter
 * shines with its own channel, linearly, through a fixed disc, as the ONLY
 * light (a black board for the Output's Color, the diodes for its Emissive).
 */

const led = () => getBuiltinTextures().find((t) => t.id === 'led-display')!;
const isNoise = (n: AppNode) => NODE_REGISTRY.get(n.data.registryType)?.category === 'noise';
/** The shader nodes of the group: no frame, no note. */
const members = (nodes: AppNode[]) => nodes.filter((n) => n.type !== 'group' && n.type !== 'note');
const ofType = (nodes: AppNode[], type: string) => nodes.filter((n) => n.data.registryType === type);
const uniformNamed = (nodes: AppNode[], name: string) =>
  nodes.find((n) => n.data.registryType === 'property_float' && getNodeValues(n).name === name)!;
const labelled = (nodes: AppNode[], label: string) =>
  nodes.find((n) => (n.data as { label?: string }).label === label)!;
const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const num = (n: AppNode, key: string) => Number(getNodeValues(n)[key]);

/** The node wired into `handle` of `node`, or undefined. */
function feeder(nodes: AppNode[], edges: AppEdge[], node: AppNode, handle: string): AppNode | undefined {
  const edge = edges.find((e) => e.target === node.id && e.targetHandle === handle);
  return nodes.find((n) => n.id === edge?.source);
}
/** The edge wired into `handle` of `node`, or undefined. */
function edgeInto(edges: AppEdge[], node: AppNode, handle: string): AppEdge | undefined {
  return edges.find((e) => e.target === node.id && e.targetHandle === handle);
}
/** Every node that reads `node`'s output. */
function readers(nodes: AppNode[], edges: AppEdge[], node: AppNode): AppNode[] {
  return edges.filter((e) => e.source === node.id).map((e) => nodes.find((n) => n.id === e.target)!);
}
/** The whole-number, guarded grid: max(floor(diodeScale + 0.5), 1). */
function gridOf(nodes: AppNode[], edges: AppEdge[]): AppNode {
  const [nearest] = readers(nodes, edges, uniformNamed(nodes, 'diodeScale'));
  const [whole] = readers(nodes, edges, nearest);
  return readers(nodes, edges, whole)[0];
}
/** The Floor that picks the display pixel (the other Floor rounds the grid). */
function cellFloorOf(nodes: AppNode[], edges: AppEdge[]): AppNode {
  return ofType(nodes, 'floor').find((f) => feeder(nodes, edges, f, 'x')?.data.registryType === 'mul')!;
}
/** The picture as the diodes receive it: the source's one reader, max(·, 0). */
function pictureOf(nodes: AppNode[], edges: AppEdge[]): AppNode {
  return readers(nodes, edges, members(nodes).find(isNoise)!)[0];
}
/** The group's loose ends: the shader nodes nothing inside it reads. */
function looseEnds(nodes: AppNode[], edges: AppEdge[]): AppNode[] {
  const sources = new Set(edges.map((e) => e.source));
  return members(nodes).filter((n) => !sources.has(n.id));
}
/** Every node `node` depends on, itself included. */
function upstream(edges: AppEdge[], node: AppNode): Set<string> {
  const seen = new Set<string>([node.id]);
  const queue = [node.id];
  for (let id = queue.shift(); id; id = queue.shift()) {
    for (const e of edges) {
      if (e.target === id && !seen.has(e.source)) {
        seen.add(e.source);
        queue.push(e.source);
      }
    }
  }
  return seen;
}

describe('LED Display texture', () => {
  it('parses cleanly and does not grow on a code -> graph -> code round trip', () => {
    const first = codeToGraph(led().code);
    expect(first.errors).toEqual([]);
    expect(first.nodes.filter((n) => n.data.registryType === 'unknown')).toEqual([]);
    const emitted = graphToCode(first.nodes, first.edges).code;
    const second = codeToGraph(emitted);
    expect(second.errors).toEqual([]);
    // An Apply in the code panel must hand back the same graph, node for node.
    expect(second.nodes.map((n) => n.data.registryType).sort())
      .toEqual(first.nodes.map((n) => n.data.registryType).sort());
    expect(graphToCode(second.nodes, second.edges).code).toBe(emitted);
  });

  it('has ONE grid uniform, diodeScale, made a whole number the same way on every backend', () => {
    const { nodes, edges } = led();
    const names = ofType(nodes, 'property_float').map((n) => getNodeValues(n).name).sort();
    expect(names).toEqual(['diodeBrightness', 'diodeScale']);
    // floor(x + 0.5), never round(): round breaks .5 ties half-to-even on WGSL
    // and away from zero on GLSL, so 40.5 drew 40 columns on WebGPU and 41 on
    // WebGL2. A whole number at all because the slider moves in 0.4 steps, and
    // a fractional grid ends in a partial column (a seam, an opposite-edge cell).
    expect(ofType(nodes, 'round')).toEqual([]);
    const nearest = readers(nodes, edges, uniformNamed(nodes, 'diodeScale'));
    expect(nearest.map((n) => n.data.registryType)).toEqual(['add']);
    expect(num(nearest[0], 'b')).toBe(0.5);
    const whole = readers(nodes, edges, nearest[0]);
    expect(whole.map((n) => n.data.registryType)).toEqual(['floor']);
    // …then max(…, 1): the slider starts at 0, and a zero grid divides by zero.
    const guard = readers(nodes, edges, whole[0]);
    expect(guard.map((n) => n.data.registryType)).toEqual(['max']);
    expect(num(guard[0], 'b')).toBe(1);
  });

  it('drives the grid with that uniform: uv x grid, then Floor and Fract of the same product', () => {
    const { nodes, edges } = led();
    const grid = gridOf(nodes, edges);
    const floor = cellFloorOf(nodes, edges);
    const fract = ofType(nodes, 'fract');
    expect(fract).toHaveLength(1);
    // The cell coordinate is uv times the GUARDED grid — not a literal, which
    // would leave the uniform reaching the Divide alone and scaling nothing.
    const cell = feeder(nodes, edges, floor, 'x')!;
    expect(cell.data.registryType).toBe('mul');
    expect(feeder(nodes, edges, cell, 'a')?.data.registryType).toBe('uv');
    expect(feeder(nodes, edges, cell, 'b')).toBe(grid);
    // Which pixel (Floor) and where inside it (Fract) are read off ONE product.
    expect(feeder(nodes, edges, fract[0], 'x')).toBe(cell);
    // The grid is read exactly twice: by that product and by the hand-off Divide.
    const gridReaders = readers(nodes, edges, grid);
    expect(gridReaders).toHaveLength(2);
    expect(gridReaders).toContain(cell);
    expect(gridReaders).toContain(ofType(nodes, 'div')[0]);
  });

  it('feeds its ONE colour picture source the cell-centre UV, from ONE node', () => {
    const { nodes, edges } = led();
    const noise = members(nodes).filter(isNoise);
    expect(noise).toHaveLength(1);
    // THREE independent channels: a grey source lights all three emitters of
    // every pixel equally, and the diodes then read as a pattern laid over the
    // picture rather than the thing making its colours.
    expect(noise[0].data.registryType).toBe('perlinVec3');
    // A picture: finer than the 0-1 UV square (one flat level otherwise), and
    // far coarser than the grid (a per-pixel colour carpet otherwise).
    expect(num(noise[0], 'scale')).toBeGreaterThanOrEqual(2);
    expect(num(noise[0], 'scale')).toBeLessThanOrEqual(8);
    const pos = edges.filter((e) => e.target === noise[0].id && e.targetHandle === 'pos');
    expect(pos).toHaveLength(1);
    // The hand-off is the graph's only Divide — the node the in-frame note
    // names — taking the cell centre back into the 0-1 UV an Image node's UV
    // socket expects, by the SAME guarded grid the multiply used.
    const divs = ofType(nodes, 'div');
    expect(divs).toHaveLength(1);
    expect(pos[0].source).toBe(divs[0].id);
    expect(feeder(nodes, edges, divs[0], 'b')).toBe(gridOf(nodes, edges));
    // The centre, not the corner: floor + 0.5.
    const centre = feeder(nodes, edges, divs[0], 'a')!;
    expect(centre.data.registryType).toBe('add');
    expect(num(centre, 'b')).toBe(0.5);
    expect(feeder(nodes, edges, centre, 'a')).toBe(cellFloorOf(nodes, edges));
    // Between the source and the diodes there is ONE node, max(·, 0): it keeps
    // the noise's negative half dark and is the identity on an image (0-1), so
    // nothing downstream assumes the source is a noise.
    expect(readers(nodes, edges, noise[0])).toHaveLength(1);
    const picture = pictureOf(nodes, edges);
    expect(picture.data.registryType).toBe('max');
    expect(num(picture, 'b')).toBe(0);
  });

  it('drives every emitter LINEARLY with its own channel of the picture', () => {
    // What makes the diodes reproduce the picture instead of sitting on top of
    // it: light out = channel × (something that does not depend on the
    // picture). The first version squared a dome and over-drove it ×8, so every
    // channel over about an eighth looked fully lit — a blue sky lit its green
    // emitters, and the picture showed mainly as dot size.
    const { nodes, edges } = led();
    const picture = pictureOf(nodes, edges);
    const brightness = uniformNamed(nodes, 'diodeBrightness');
    // No gain past 1 by default: with the board black (below), a full channel
    // reaches the top of the disc and no further, so no tone clips.
    expect(num(brightness, 'value')).toBeLessThanOrEqual(1);
    // From the picture to the loose end: Multiplies only, the picture on ONE
    // side of each, the other side independent of it — linear in every channel.
    let at = picture;
    const path: AppNode[] = [];
    for (let next = readers(nodes, edges, at); next.length > 0; next = readers(nodes, edges, at)) {
      expect(next, 'the picture branches').toHaveLength(1);
      at = next[0];
      path.push(at);
      expect(at.data.registryType, 'a non-linear step after the picture').toBe('mul');
      const other = ['a', 'b'].map((h) => feeder(nodes, edges, at, h)!).find((n) => !upstream(edges, n).has(picture.id));
      expect(other, 'the picture multiplied by itself').toBeDefined();
    }
    expect(path).toHaveLength(2);
    // The two other factors: the fixed disc, then diodeBrightness.
    const [lit, out] = path;
    const disc = ['a', 'b'].map((h) => feeder(nodes, edges, lit, h)!).find((n) => n !== picture)!;
    expect(disc.data.registryType).toBe('clamp');
    expect([num(disc, 'min'), num(disc, 'max')]).toEqual([0, 1]);
    expect(['a', 'b'].map((h) => feeder(nodes, edges, out, h))).toContain(brightness);
    // The disc never reads the picture (a shape that depends on brightness is
    // how the first version grew bright dots and shrank dim ones).
    expect(upstream(edges, disc).has(picture.id)).toBe(false);
  });

  it('shapes every emitter as a flat disc around its OWN centre: clamp((1 - dx² - dy²) × 4, 0, 1)', () => {
    // Pinned node by node, because one cost-neutral token turns the diodes into
    // a pattern over the picture: `sub(d2, 1)` lights the board between them
    // and darkens their centres, `sub(dx2, dy2)` makes a prism of stripes.
    const { nodes, edges } = led();
    const disc = labelled(nodes, 'disc');
    expect(disc.data.registryType).toBe('clamp');
    const edge = feeder(nodes, edges, disc, 'x')!;
    expect(edge.data.registryType).toBe('mul');
    expect(num(edge, 'b')).toBe(LED_DISC_EDGE);
    const dome = feeder(nodes, edges, edge, 'a')!;
    expect(dome.data.registryType).toBe('oneMinus');
    const d2 = feeder(nodes, edges, dome, 'x')!;
    expect(d2.data.registryType).toBe('add');
    // Each term is a SQUARE: both inputs of the Multiply are the same Subtract.
    const square = (handle: string) => {
      const m = feeder(nodes, edges, d2, handle)!;
      expect(m.data.registryType).toBe('mul');
      const s = feeder(nodes, edges, m, 'a')!;
      expect(feeder(nodes, edges, m, 'b')).toBe(s);
      expect(s.data.registryType).toBe('sub');
      return s;
    };
    const dx = square('a');
    const dy = square('b');
    // Each Subtract is emitter centre − the cell position on ITS axis.
    const fract = ofType(nodes, 'fract')[0];
    const [q] = readers(nodes, edges, fract);
    for (const [s, label, axis] of [[dx, 'emitterX', 'x'], [dy, 'emitterY', 'y']] as const) {
      expect(feeder(nodes, edges, s, 'a')).toBe(labelled(nodes, label));
      const at = edgeInto(edges, s, 'b')!;
      const split = nodes.find((n) => n.id === at.source)!;
      expect(split.data.registryType).toBe('split');
      expect(at.sourceHandle).toBe(axis);
      expect(feeder(nodes, edges, split, 'v')).toBe(q);
    }
    expect(q.data.registryType).toBe('mul');
    expect(num(q, 'b')).toBe(LED_CELL);
  });

  it('makes the diodes the ONLY light: a black board for Color, the diodes for Emissive', () => {
    // The group ends in TWO nodes, and the description names both wires. With
    // Color unwired, loader 0.8 copies the emission into the base colour and the
    // scene lights it as well (×1.4-1.9, clipping over ~0.7); with an older
    // graph's Color still wired, that material stays under the diodes — the
    // overlay again.
    const { nodes, edges } = led();
    const ends = looseEnds(nodes, edges);
    expect(ends.map((n) => n.data.registryType).sort()).toEqual(['color', 'mul']);
    const board = ends.find((n) => n.data.registryType === 'color')!;
    expect(String(getNodeValues(board).hex).toLowerCase()).toBe('#000000');
    const diodes = ends.find((n) => n.data.registryType === 'mul')!;
    expect(upstream(edges, diodes).has(pictureOf(nodes, edges).id)).toBe(true);
    // Wired as the description says, the module emits exactly that pair.
    const { code } = graphToCode(
      [...members(nodes), makeNode('ledOut', 'output')],
      [...edges, makeEdge(board.id, 'out', 'ledOut', 'color'), makeEdge(diodes.id, 'out', 'ledOut', 'emissive')],
    );
    expect(code).toMatch(/return \{ color: (\w+), emissive: \w+ \}/);
    const boardVar = /return \{ color: (\w+),/.exec(code)![1];
    expect(code).toContain(`const ${boardVar} = color(0x000000);`);
  });

  it('shows a picture once the noise is swapped for an Image node', () => {
    // The note's END state: what fed the noise feeds the image's UV socket,
    // what the noise fed is fed by the image's Color.
    const { nodes, edges } = led();
    const shader = members(nodes);
    const noise = shader.find(isNoise)!;
    const posEdge = edges.find((e) => e.target === noise.id && e.targetHandle === 'pos')!;
    const outEdges = edges.filter((e) => e.source === noise.id);
    expect(outEdges).toHaveLength(1);
    const diodes = looseEnds(nodes, edges).find((n) => n.data.registryType === 'mul')!;

    const image = makeNode('ledImage', 'imageNode', {
      imageB64: 'data:image/png;base64,' + btoa('abc'),
      width: 2,
      height: 2,
      fileName: 'x.png',
      colorSpace: 'color',
    });
    const swappedNodes: AppNode[] = [...shader.filter((n) => n.id !== noise.id), image, makeNode('ledOut', 'output')];
    const swappedEdges: AppEdge[] = [
      ...edges.filter((e) => e !== posEdge && !outEdges.includes(e)),
      makeEdge(posEdge.source, posEdge.sourceHandle ?? 'out', 'ledImage', 'uv'),
      ...outEdges.map((e) => makeEdge('ledImage', 'out', e.target, e.targetHandle ?? 'a')),
      makeEdge(diodes.id, 'out', 'ledOut', 'emissive'),
    ];
    const { code } = graphToCode(swappedNodes, swappedEdges);
    expect(code).not.toMatch(/mx_\w*noise/);
    // Sampled at the cell centre (the Divide), never at the fragment's own uv.
    expect(code).toMatch(/texture\(_\w+_tex, div1[.)]/);
    // The noise's default position must not survive as a stray read.
    expect(code).not.toContain('positionGeometry');
    // One colour sample, through max(·, 0), into the diodes.
    expect(code).toMatch(/const (\w+) = texture\([^;]+\)\.rgb;[\s\S]*max\(\1, 0\)/);
  });

  it('gets there with the two gestures the note names, deleting first', () => {
    // "Delete the noise node, then drag the Image node over the wire that is
    // left": deleting bridges the noise's input to its reader, and a node
    // dropped on a wire is spliced in at its FIRST input with its first output
    // — for an Image that is UV in and Color out. No hidden socket to find.
    // (Drop-first rewires the same on paper, but on the canvas the wire into
    // the noise is short and crossed by the emitter wires; the note says
    // delete first.)
    const { nodes, edges } = led();
    const noise = members(nodes).find(isNoise)!;
    const divide = ofType(nodes, 'div')[0];
    const picture = pictureOf(nodes, edges);
    const imageDef = NODE_REGISTRY.get('imageNode')!;
    const port = pickSpliceInputPort(imageDef, [], []);
    expect(port).toBe('uv');
    expect(imageDef.outputs[0].id).toBe('out');

    const bridged = bridgeEdgesAcrossDeletedNodes(edges, new Set([noise.id]));
    const left = bridged.filter((e) => e.source === divide.id && e.target === picture.id);
    expect(left).toHaveLength(1);
    const spliced = [
      ...bridged.filter((e) => e !== left[0]),
      makeEdge(left[0].source, left[0].sourceHandle ?? 'out', 'img', port!),
      makeEdge('img', imageDef.outputs[0].id, left[0].target, left[0].targetHandle ?? 'a'),
    ];
    expect(spliced.filter((e) => e.target === 'img').map((e) => `${e.source}:${e.targetHandle}`)).toEqual([`${divide.id}:uv`]);
    expect(spliced.filter((e) => e.source === 'img').map((e) => `${e.target}:${e.targetHandle}`)).toEqual([`${picture.id}:a`]);
  });

  it('costs what its tile says, and the tile counts its shader nodes', () => {
    // BINARY arithmetic only. The badge sums `data.cost`; the CostBar sums
    // nodeCostPoints, which prices a chain base x (operands - 1) — so one
    // three-operand Multiply would make the tile print less than the graph costs.
    const { nodes, edges, totalCost } = led();
    const bar = members(nodes).reduce((sum, n) => sum + nodeCostPoints(n, edges), 0);
    expect(totalCost).toBe(bar);
    // 94: the colour noise 68, the Divide 4, uv 2, the clamp 2, eighteen
    // 1-point nodes. An Image in the noise's place brings it to ~32.
    expect(totalCost).toBe(94);
    // "28 nodes" on the tile: the frame and the explainer note are not nodes of
    // the graph. LED Display is the first texture to pin a note, and until it
    // did, `nodes.length - 1` was the same number.
    expect(members(nodes)).toHaveLength(28);
    expect(readSource('../components/NodeEditor/TextureCard.tsx')).toMatch(
      /memberCount = texture\.nodes\.filter\(\s*\(n\) => n\.type !== 'group' && n\.type !== 'note',?\s*\)\.length/,
    );
  });

  it('places three emitters per display pixel, each with bare board round it', () => {
    const { nodes } = led();
    const xyz = (label: string) => {
      const v = getNodeValues(labelled(nodes, label));
      return [Number(v.x), Number(v.y), Number(v.z)];
    };
    const ex = xyz('emitterX');
    const ey = xyz('emitterY');
    expect(ex).toEqual([1.1, 3.3, 2.2]);
    expect(ey).toEqual([3.3, 3.3, 1.1]);
    // The disc is 1 - d² (pinned above): radius 1. Every emitter keeps a strip
    // of board between itself and the cell border — what 4.4 rather than 4 buys.
    for (const c of [...ex, ...ey]) {
      expect(c - 1).toBeGreaterThan(0);
      expect(c + 1).toBeLessThan(LED_CELL);
    }
  });

  it('pins a note that fits the note box, like a preset', () => {
    // codeGroupBuilder sizes the box for a 200-character caption; the budget
    // builtinPresets.test.ts holds every preset note to.
    const notes = led().nodes.filter((n) => n.type === 'note');
    expect(notes).toHaveLength(1);
    const heading = String(notes[0].data.heading);
    const text = String(notes[0].data.text);
    expect(heading.length).toBeGreaterThan(0);
    expect(heading.length).toBeLessThanOrEqual(26);
    expect(text.length).toBeGreaterThan(40);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(heading).toMatch(/^[\x20-\x7E]+$/);
    expect(text).toMatch(/^[\x20-\x7E]+$/);
    // It names the nodes the swap touches, and there is ONE of each to find.
    expect(text).toContain('Divide');
    expect(ofType(led().nodes, 'div')).toHaveLength(1);
    expect(text).toContain('noise node');
    expect(members(led().nodes).filter(isNoise)).toHaveLength(1);
    expect(text).toContain('Image node');
    expect(text.indexOf('delete the noise')).toBeLessThan(text.indexOf('Image node over the wire'));
    for (const e of led().edges) {
      expect(e.source).not.toBe(notes[0].id);
      expect(e.target).not.toBe(notes[0].id);
    }
  });
});

describe('LED Display tile (what the thumbnail draws)', () => {
  it('uses the texture\'s own emitter numbers', () => {
    const { nodes } = led();
    const v = (label: string) => getNodeValues(labelled(nodes, label));
    const ex = v('emitterX');
    const ey = v('emitterY');
    expect(LED_EMITTERS).toEqual([
      [Number(ex.x), Number(ey.x)],
      [Number(ex.y), Number(ey.y)],
      [Number(ex.z), Number(ey.z)],
    ]);
    expect(LED_BRIGHTNESS).toBe(num(uniformNamed(nodes, 'diodeBrightness'), 'value'));
    // LED_CELL and LED_DISC_EDGE are asserted against the graph above.
  });

  it('lights each emitter with its own channel only, linearly', () => {
    for (let i = 0; i < 3; i++) {
      const [cx, cy] = LED_EMITTERS[i];
      for (const level of [0.1, 0.5, 1]) {
        expect(ledEmitter(i, level, cx, cy)).toBeCloseTo(level * LED_BRIGHTNESS, 9);
        // Flat: the same light 0.3 radii off-centre (the plateau is 0.87).
        expect(ledEmitter(i, level, cx + 0.3, cy)).toBeCloseTo(level * LED_BRIGHTNESS, 9);
      }
      for (let j = 0; j < 3; j++) {
        if (j !== i) expect(ledEmitter(i, 1, LED_EMITTERS[j][0], LED_EMITTERS[j][1])).toBe(0);
      }
      // Dark board just past the rim.
      expect(ledEmitter(i, 1, cx + 1.05, cy)).toBe(0);
    }
  });

  it('draws v UP: R left of G on top, B beneath them', () => {
    // Where each channel's emitter sits inside a display pixel ON THE TILE
    // (y down): the centroid of its light, relative to the cell's top-left,
    // over every cell where that channel is lit.
    const w = 256;
    const cellPx = w / LED_TILE_PIXELS;
    const centroid = (ch: number) => {
      let sx = 0, sy = 0, sw = 0;
      for (let py = 0; py < w; py++) {
        for (let px = 0; px < w; px++) {
          const v = ledDisplayShade(((px + 0.5) / w) * 2 - 1, ((py + 0.5) / w) * 2 - 1)[ch];
          if (v <= 0) continue;
          sx += ((px + 0.5) % cellPx) * v;
          sy += ((py + 0.5) % cellPx) * v;
          sw += v;
        }
      }
      expect(sw, `channel ${ch} never lit on the tile`).toBeGreaterThan(0);
      return { x: sx / sw / cellPx, y: sy / sw / cellPx };
    };
    const [r, g, b] = [centroid(0), centroid(1), centroid(2)];
    // The texture's own centres, flipped to y down: R (0.25, 0.25), G (0.75,
    // 0.25), B (0.5, 0.75) of the cell.
    for (const [c, i] of [[r, 0], [g, 1], [b, 2]] as const) {
      expect(c.x).toBeCloseTo(LED_EMITTERS[i][0] / LED_CELL, 1);
      expect(c.y).toBeCloseTo(1 - LED_EMITTERS[i][1] / LED_CELL, 1);
    }
    expect(b.y).toBeGreaterThan(r.y);
    expect(r.x).toBeLessThan(g.x);
  });

  it('encodes linear light to sRGB, never brighter than the level', () => {
    expect(linearToSrgb(0.5) * 255).toBeCloseTo(188, 0);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 9);
    // The tile stores the ENCODED value: at an emitter's centre it is exactly
    // the encoded level (unencoded, every dim emitter would show far darker
    // than the preview draws it).
    let checked = 0;
    for (let cy = 0; cy < LED_TILE_PIXELS; cy++) {
      for (let cx = 0; cx < LED_TILE_PIXELS; cx++) {
        for (let i = 0; i < 3; i++) {
          const level = ledTileLevel(i, cx + 0.5, cy + 0.5);
          if (level <= 0.02 || level >= 0.98) continue;
          // The emitter's centre in tile coordinates (y down).
          const x = ((cx + LED_EMITTERS[i][0] / LED_CELL) / LED_TILE_PIXELS) * 2 - 1;
          const y = 1 - ((cy + LED_EMITTERS[i][1] / LED_CELL) / LED_TILE_PIXELS) * 2;
          expect(ledDisplayShade(x, y)[i]).toBeCloseTo(linearToSrgb(level * LED_BRIGHTNESS), 6);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    const w = 128;
    for (let py = 0; py < w; py += 3) {
      for (let px = 0; px < w; px += 3) {
        const x = (px / w) * 2 - 1;
        const y = (py / w) * 2 - 1;
        const cellX = ((x + 1) / 2) * LED_TILE_PIXELS;
        const cellY = ((1 - y) / 2) * LED_TILE_PIXELS;
        const shade = ledDisplayShade(x, y);
        for (let i = 0; i < 3; i++) {
          const level = ledTileLevel(i, Math.floor(cellX) + 0.5, Math.floor(cellY) + 0.5);
          expect(shade[i]).toBeLessThanOrEqual(linearToSrgb(Math.min(level * LED_BRIGHTNESS, 1)) + 1e-9);
        }
      }
    }
  });

  it('shows the texture\'s mix: separate colours, mostly one or two emitters per pixel', () => {
    const lit = (v: number) => v > 0.04;
    let three = 0;
    const alone = new Set<number>();
    for (let y = 0; y < LED_TILE_PIXELS; y++) {
      for (let x = 0; x < LED_TILE_PIXELS; x++) {
        const levels = [0, 1, 2].map((i) => ledTileLevel(i, x + 0.5, y + 0.5));
        const on = levels.filter(lit).length;
        if (on === 3) three++;
        if (on === 1) alone.add(levels.findIndex(lit));
      }
    }
    // A shared seed (R = G = B) or a lifted picture lights all three nearly
    // everywhere — the overlay look the texture no longer has.
    expect(three / LED_TILE_PIXELS ** 2).toBeLessThan(0.25);
    expect([...alone].sort()).toEqual([0, 1, 2]);
  });
});
