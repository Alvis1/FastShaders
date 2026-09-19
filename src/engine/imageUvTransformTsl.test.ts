import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as TSL from 'three/tsl';
import { gltfUvMatrix } from '@/utils/imageUvMapping';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '../test-utils';

/**
 * Contract test: the TSL the image branch WRITES AS TEXT for the glTF mapping
 * is real, and means what the emitter assumes (the dataVizTslContract
 * pattern). Every other image test compares generated source with expected
 * source, which cannot catch `mat2` reading its arguments in the other order,
 * `uv(n)` naming a different attribute, or `normalMap` ignoring a second
 * argument: each of those produces perfect-looking source and a wrong picture.
 */

// Arity types are erased at this boundary: the emitted module is a string the
// type checker never sees, and the question here is runtime existence.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;
const T = TSL as unknown as Record<string, Chain>;

/** Evaluate an EMITTED expression with the names the module imports bound. */
function evalEmitted(expr: string, x: Chain = null): Chain {
  const f = new Function('mat2', 'vec2', 'vec3', 'uv', 'normalMap', 'x', `return ${expr};`);
  return f(T.mat2, T.vec2, T.vec3, T.uv, T.normalMap, x);
}

const THREE_SRC = (p: string) => readFileSync(new URL(`../../node_modules/three/src/nodes/${p}`, import.meta.url), 'utf8');

describe('the glTF-mapping TSL exists in the shipped three', () => {
  it('exports every symbol the branch imports by name', () => {
    for (const name of ['mat2', 'vec2', 'uv', 'normalMap', 'texture']) {
      expect(typeof T[name], name).toBe('function');
    }
  });

  it('builds each emitted expression without throwing', () => {
    const rot = evalEmitted('mat2(0, 1, -1, 0).mul(uv())');
    expect(rot?.isNode).toBe(true);
    const chained = evalEmitted('mat2(0.5, -0.25, 0.25, 2).mul(uv(2)).add(vec2(0.25, 0.5)).mul(vec2(-1, 1)).add(vec2(1, 0))');
    expect(chained?.isNode).toBe(true);
    expect(evalEmitted('uv().mul(vec2(2, 3))')?.isNode).toBe(true);
    expect(evalEmitted('uv(3)')?.isNode).toBe(true);
    const nm = evalEmitted('normalMap(x, vec2(1, -1))', T.vec3(0.5, 0.5, 1));
    expect(nm?.isNode).toBe(true);
    // The second argument lands in the node's scale — the slot NormalMapNode
    // multiplies the unpacked xy by.
    expect(nm.scaleNode).toBeTruthy();
    expect(evalEmitted('normalMap(x)', T.vec3(0.5, 0.5, 1)).scaleNode).toBeNull();
  });
});

describe('what the emission relies on, pinned to three\'s own source', () => {
  it('the EMITTED mat2 text builds exactly gltfUvMatrix, not its transpose', () => {
    // A NON-symmetric transform (rotation plus non-uniform scale): its matrix
    // and its transpose differ in every off-diagonal slot, so reading the
    // arguments in the other order cannot pass. Run the real emitter and the
    // real three/tsl — a source pin on RotateNode proves nothing here, since
    // RotateNode passes NODE arguments (the column-major JoinNode path) while
    // the emitter passes numbers, which TSL turns into a row-major Matrix2.
    const t = { offsetX: 0, offsetY: 0, rotation: 0.4, scaleX: 2, scaleY: 0.5 };
    const { code } = graphToCode(
      [
        makeNode('img1', 'imageNode', {
          imageB64: `data:image/webp;base64,${btoa('abc')}`, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color',
          orientation: 'gltf', xfRotation: t.rotation, xfScaleX: t.scaleX, xfScaleY: t.scaleY,
        }),
        makeNode('out1', 'output'),
      ],
      [makeEdge('img1', 'out', 'out1', 'color')],
    );
    const args = code.match(/texture\(_image1_tex, mat2\(([^()]*)\)\.mul\(uv\(\)\)\)/)?.[1];
    expect(args, code).toBeDefined();
    // Numbers only: node arguments would flip the storage order again.
    const parts = args!.split(',').map((a) => a.trim());
    expect(parts).toHaveLength(4);
    for (const a of parts) expect(Number.isFinite(Number(a)) && a !== '', a).toBe(true);

    let n = evalEmitted(`mat2(${args})`);
    while (n?.isVarNode) n = n.node;
    expect(n?.isConstNode).toBe(true);
    // Matrix2.elements are column-major: M·(1,0) = (e0, e1), M·(0,1) = (e2, e3).
    const e: number[] = n.value.elements;
    const m = gltfUvMatrix(t);
    const col0 = [e[0], e[1]]; // where (u, v) = (1, 0) lands
    const col1 = [e[2], e[3]]; // where (u, v) = (0, 1) lands
    expect(col0[0]).toBeCloseTo(m.m00, 12);
    expect(col0[1]).toBeCloseTo(m.m10, 12);
    expect(col1[0]).toBeCloseTo(m.m01, 12);
    expect(col1[1]).toBeCloseTo(m.m11, 12);
    // …and the case really is non-symmetric, so the transpose would fail.
    expect(Math.abs(m.m01 - m.m10)).toBeGreaterThan(0.1);
  });

  it('uv(n) reads the attribute uv<n> (three\'s TEXCOORD_n), uv() reads uv', () => {
    expect(THREE_SRC('accessors/UV.js')).toContain("'uv' + ( index > 0 ? index : '' )");
  });

  it('normalMap multiplies the unpacked xy by its second argument', () => {
    expect(THREE_SRC('display/NormalMapNode.js')).toMatch(/normalMap\.xy\.mul\(\s*scale\s*\)/);
  });
});
