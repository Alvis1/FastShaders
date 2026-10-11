/**
 * A Split reads its SOURCE SOCKET for every source whose sockets are not the
 * bare variable (`SPLIT_SOCKET_AWARE` in graphToCode; docs/dev/codegen.md).
 *
 * The Fresnel / Color Ramp / toHsl members are pinned in
 * ownMemberConsumers.test.ts. This file pins the four sources that joined the
 * set on 2026-10-11, each of which read the BARE variable through a Split:
 *  - the Texture node's channel sockets: Alpha → Split.x emitted `image1.x`
 *    (red) and G → Split.x the same red, while the card (cpuEvaluator's
 *    handleChannels) showed the right channel;
 *  - Data Viz `value`: Split.x read the ramp colour's red, not `_dataviz1_t`;
 *  - Sound and the Data node: Split.x named `sound1` / `data1`, which nothing
 *    declares — a ReferenceError that killed the module.
 * A scalar socket is its own `.x` and has no `.y/.z/.w` (the consumer reads as
 * unwired); a source whose socket IS the bare variable — `out` of a narrow or a
 * wide image, Data Viz's Color — keeps `<bare>.<comp>`, byte-identical.
 */
import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

const URL_WEBP = `data:image/webp;base64,${btoa('abc')}`;
const IMG = { imageB64: URL_WEBP, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' };
const RGB_SAMPLE = '  const image1 = texture(_image1_tex, uv()).rgb;\n';
const RGBA_SAMPLE = '  const image1 = texture(_image1_tex, uv()).rgba;\n';

const emit = (nodes: AppNode[], edges: AppEdge[]) => graphToCode(nodes, edges).code;

/** S.<handle> → Split.v, Split.<comp> → Output.roughness (+ any extra edges). */
function throughSplit(source: AppNode, handle: string, comp: string, extra: AppEdge[] = []) {
  const nodes = [source, makeNode('X', 'split'), makeNode('O', 'output')];
  const edges = [makeEdge(source.id, handle, 'X', 'v'), makeEdge('X', comp, 'O', 'roughness'), ...extra];
  return { nodes, edges, code: emit(nodes, edges) };
}

const image = () => makeNode('S', 'imageNode', IMG);
/** A second wire from a channel socket: the image is WIDE whatever feeds the Split. */
const widen = [makeEdge('S', 'alpha', 'O', 'opacity')];

describe('Texture node — a channel socket through a Split reads that channel', () => {
  it('Alpha → Split.x emits image1.a, never the red image1.x', () => {
    const { code } = throughSplit(image(), 'alpha', 'x');
    expect(code).toContain(RGBA_SAMPLE);
    expect(code).toContain('roughness: image1.a');
    expect(code).not.toContain('image1.x');
  });

  it('G → Split.x emits image1.g (and R, B their own)', () => {
    expect(throughSplit(image(), 'g', 'x').code).toContain('roughness: image1.g');
    expect(throughSplit(image(), 'r', 'x').code).toContain('roughness: image1.r');
    expect(throughSplit(image(), 'b', 'x').code).toContain('roughness: image1.b');
  });

  it('a channel is a scalar: Split.y/z/w of it emit nothing — the consumer reads as unwired', () => {
    for (const comp of ['y', 'z', 'w']) {
      for (const h of ['alpha', 'r', 'g', 'b']) {
        const { code } = throughSplit(image(), h, comp);
        expect(code, `${h}.${comp}`).not.toContain('roughness:');
        // The wide sample stays ONE sample even when nothing reads it.
        expect((code.match(/= texture\(/g) ?? []).length, `${h}.${comp}`).toBe(1);
      }
    }
    // Beside another wired channel, only the Split's consumer drops out.
    const { code } = throughSplit(image(), 'g', 'y', widen);
    expect(code).toContain('return { opacity: image1.a };');
  });

  it('out → Split is byte-identical, narrow and wide: the bare variable swizzled', () => {
    const narrow = throughSplit(image(), 'out', 'y').code;
    expect(narrow).toContain(RGB_SAMPLE);
    expect(narrow).toContain('  return { roughness: image1.y };\n');

    const wide = throughSplit(image(), 'out', 'y', widen).code;
    expect(wide).toContain(RGBA_SAMPLE);
    expect(wide).toContain('  return { opacity: image1.a, roughness: image1.y };\n');

    // Split.w of the WIDE Color reads the sample's alpha rather than failing —
    // the same rule as Color Ramp's Color (a vector socket swizzles the bare variable).
    expect(throughSplit(image(), 'out', 'w', widen).code).toContain('roughness: image1.w');
  });

  it('an Apply of the emitted code stays inert: no error, no unknown/split/image node', () => {
    for (const [h, extra] of [['alpha', []], ['g', widen], ['out', widen]] as const) {
      const { code } = throughSplit(image(), h, 'x', [...extra]);
      const r = codeToGraph(code);
      expect(r.errors.filter((e) => e.severity !== 'warning'), h).toEqual([]);
      const types = r.nodes.map((n) => n.data.registryType);
      expect(types, h).not.toContain('unknown');
      expect(types, h).not.toContain('imageNode');
      expect(types, h).not.toContain('split');
    }
  });
});

describe('sources with a variable of their own per socket', () => {
  it('Data Viz Value → Split.x reads the scalar, not the ramp colour; Color → Split is unchanged', () => {
    const viz = () => makeNode('S', 'dataviz');
    expect(throughSplit(viz(), 'value', 'x').code).toContain('roughness: _dataviz1_t');
    expect(throughSplit(viz(), 'value', 'x').code).not.toContain('dataviz1.x');
    expect(throughSplit(viz(), 'value', 'y').code).not.toContain('roughness:');
    expect(throughSplit(viz(), 'out', 'y').code).toContain('roughness: dataviz1.y');
  });

  it('Sound → Split.x reads that channel uniform; it used to name an undeclared `sound1`', () => {
    for (const ch of ['level', 'bass', 'mid', 'treble']) {
      const code = throughSplit(makeNode('S', 'soundNode'), ch, 'x').code;
      expect(code, ch).toContain(`  const sound1_${ch} = uniform(0);\n`);
      expect(code, ch).toContain(`roughness: sound1_${ch}`);
      expect(code, ch).not.toMatch(/\bsound1\./);
    }
    expect(throughSplit(makeNode('S', 'soundNode'), 'bass', 'y').code).not.toContain('roughness:');
  });

  it('Data → Split.x reads that column; it used to name an undeclared `data1`', () => {
    const data = makeNode('S', 'dataNode');
    (data.data as { dynamicOutputs?: unknown }).dynamicOutputs = [
      { id: 'col0', label: 'a', dataType: 'float' },
      { id: 'col1', label: 'b', dataType: 'float' },
    ];
    const code = throughSplit(data, 'col1', 'x').code;
    expect(code).toContain('roughness: data1_col1');
    expect(code).not.toMatch(/\bdata1\./);
    expect(throughSplit(data, 'col1', 'z').code).not.toContain('roughness:');
  });

  it('each parses back without a hard error', () => {
    const data = makeNode('S', 'dataNode');
    (data.data as { dynamicOutputs?: unknown }).dynamicOutputs = [{ id: 'col0', label: 'a', dataType: 'float' }];
    for (const [n, h] of [[makeNode('S', 'dataviz'), 'value'], [makeNode('S', 'soundNode'), 'bass'], [data, 'col0']] as const) {
      const r = codeToGraph(throughSplit(n, h, 'x').code);
      expect(r.errors.filter((e) => e.severity !== 'warning'), `${n.data.registryType}.${h}`).toEqual([]);
    }
  });
});
