/**
 * The Texture (Image) node's CHANNEL sockets — emission (GLB Phase 4 Step 3).
 *
 * Alpha/R/G/B are SWIZZLES OF ONE SAMPLE, the toHsl shape. Four properties
 * have to hold together, and each fails in a way the others cannot catch:
 *  1. BYTE STABILITY — while no channel socket is wired, the node emits the
 *     `.rgb` vec3 and consumers read the bare variable, exactly as before the
 *     sockets existed (registry/imageOutOnlyByteStability.test.ts pins the
 *     bytes; this file pins the MODE switch).
 *  2. ONE SAMPLE — wiring any channel emits `texture(…).rgba` ONCE, and every
 *     consumer reads a swizzle of it. Four `texture()` calls would compile and
 *     look right while costing four fetches (TSL never merges TextureNodes).
 *  3. GATES — only the Color (`out`) socket is an image to Normal (normalMap
 *     decode + the colour-space flip) and to Environment (the texture OBJECT,
 *     i.e. IBL). A channel is a scalar; letting it through would turn an Alpha
 *     wire into full-colour IBL, or `normalMap()` of a float.
 *  4. INERT APPLY — the wide sample is a MEMBER expression, so codeToGraph
 *     drops it with a warning. A bare `texture(...)` would mint an `unknown`
 *     node that re-emits `_imageN_tex` after the Apply dropped its declaration.
 *
 * WIDTHS arrived with Step 4, which declared the four float ports with their
 * labelled rows: `portShapeForHandle(img, 'alpha')` is 1, so the Color and
 * Environment widen (`vec3(image1.a)`) and the computeShape broadcast through
 * an `any` op (`vec3(mul1)`) are asserted below, beside the registry parity
 * check (drag-connect's `nearestByCy` tie-break lives in dragConnect.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Texture } from 'three';
import * as TSL from 'three/tsl';
import { graphToCode } from './graphToCode';
import { getEdgeOutputShape } from './cpuEvaluator';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { IMAGE_CHANNEL_COMPONENTS } from '@/utils/imageChannels';
import { codeToGraph } from './codeToGraph';
import { nodeCostPoints, computeReachableCost } from '@/utils/nodeCost';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

const URL_WEBP = `data:image/webp;base64,${btoa('abc')}`;
const valid = { imageB64: URL_WEBP, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' };
const SAMPLE_UV = 'uv().mul(vec2(-1, 1)).add(vec2(1, 0))';
const RGB_LINE = `  const image1 = texture(_image1_tex, ${SAMPLE_UV}).rgb;\n`;
const RGBA_LINE = `  const image1 = texture(_image1_tex, ${SAMPLE_UV}).rgba;\n`;

const img = (values: Record<string, string | number> = valid) => makeNode('img1', 'imageNode', values);
const out = () => makeNode('out1', 'output');

/** An edge whose source handle is anything at all, `null` included. */
function edgeFrom(source: string, sourceHandle: string | null, target: string, targetHandle: string): AppEdge {
  const e = makeEdge(source, sourceHandle ?? 'null', target, targetHandle);
  (e as { sourceHandle: string | null }).sourceHandle = sourceHandle;
  return e;
}

const emit = (nodes: AppNode[], edges: AppEdge[]) => graphToCode(nodes, edges).code;
const sampleCount = (code: string) => (code.match(/= texture\(/g) ?? []).length;
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** Color from `out` + Alpha into Opacity: the smallest wide graph. */
function alphaAndColor(values: Record<string, string | number> = valid) {
  return {
    nodes: [img(values), out()],
    edges: [makeEdge('img1', 'out', 'out1', 'color'), makeEdge('img1', 'alpha', 'out1', 'opacity')],
  };
}

describe('out-only — the mode never switches', () => {
  it('an out-only image emits the vec3 `.rgb` sample and the bare variable', () => {
    const code = emit([img(), out()], [makeEdge('img1', 'out', 'out1', 'color')]);
    expect(code).toContain(RGB_LINE);
    expect(code).toContain('  return image1;\n');
    expect(code).not.toContain('.rgba');
    expect(code).not.toContain('vec4(');
  });

  it('a dangling image (no edges at all) stays out-only', () => {
    const code = emit([img(), out()], []);
    expect(code).not.toContain('.rgba');
    expect(code).not.toContain('vec4(');
  });

  it('a tampered NON-channel source handle emits exactly what `out` emits', () => {
    const through = (handle: string | null) =>
      emit(
        [img(), makeNode('m1', 'mul'), out()],
        [edgeFrom('img1', handle, 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'color')],
      );
    const baseline = through('out');
    expect(baseline).toContain(RGB_LINE);
    for (const h of ['x', '__proto__', 'constructor', 'toString', '', null]) {
      expect(through(h), String(h)).toBe(baseline);
    }
  });

  it('an invalid payload wired out-only keeps the vec3 fallback', () => {
    const code = emit([img({ ...valid, imageB64: '' }), out()], [makeEdge('img1', 'out', 'out1', 'color')]);
    expect(code).toContain('  const image1 = vec3(0, 0, 0);\n');
    expect(code).not.toContain('vec4(');
  });
});

describe('wide mode — ONE `.rgba` sample, swizzled at the consumer', () => {
  it('Alpha → Opacity beside Color → Color', () => {
    const { nodes, edges } = alphaAndColor();
    const code = emit(nodes, edges);
    expect(sampleCount(code)).toBe(1);
    expect(code).toContain(RGBA_LINE);
    expect(code).not.toContain(RGB_LINE);
    expect(code).toContain('color: image1.rgb');
    expect(code).toContain('opacity: image1.a');
  });

  it('all five sockets wired still sample ONCE', () => {
    const code = emit(
      [img(), makeNode('m1', 'mul'), out()],
      [
        makeEdge('img1', 'out', 'out1', 'color'),
        makeEdge('img1', 'alpha', 'out1', 'opacity'),
        makeEdge('img1', 'r', 'out1', 'roughness'),
        makeEdge('img1', 'g', 'out1', 'metalness'),
        makeEdge('img1', 'b', 'm1', 'a'),
        makeEdge('m1', 'out', 'out1', 'emissive'),
      ],
    );
    expect(sampleCount(code)).toBe(1);
    for (const ref of ['image1.rgb', 'image1.a', 'image1.r', 'image1.g', 'image1.b']) {
      expect(code, ref).toContain(ref);
    }
  });

  it('once one channel is wired, EVERY `out` consumer reads `.rgb` — never the vec4', () => {
    const code = emit(
      [img(), makeNode('m1', 'mul'), out()],
      [
        makeEdge('img1', 'out', 'm1', 'a'),
        makeEdge('m1', 'out', 'out1', 'emissive'),
        makeEdge('img1', 'alpha', 'out1', 'opacity'),
      ],
    );
    expect(code).toContain('mul(image1.rgb');
    expect(code).not.toMatch(/mul\(image1[,)]/);
  });

  it('a tampered handle beside a wired channel reads `.rgb` — the Map never resolves a prototype key', () => {
    for (const h of ['__proto__', 'constructor', 'toString', 'x', '', null]) {
      const code = emit(
        [img(), makeNode('m1', 'mul'), out()],
        [
          edgeFrom('img1', h, 'm1', 'a'),
          makeEdge('m1', 'out', 'out1', 'emissive'),
          makeEdge('img1', 'alpha', 'out1', 'opacity'),
        ],
      );
      expect(code, String(h)).toContain('mul(image1.rgb');
    }
  });

  it('the invalid-payload fallback goes wide too: vec4(0, 0, 0, 1)', () => {
    const { nodes, edges } = alphaAndColor({ ...valid, imageB64: '' });
    const code = emit(nodes, edges);
    expect(code).toContain('  const image1 = vec4(0, 0, 0, 1);\n');
    expect(code).not.toContain('const image1 = vec3(0, 0, 0)');
    expect(code).toMatch(/import \{[^}]*\bvec4\b[^}]*\} from 'three\/tsl'/);
    expect(code).toContain('opacity: image1.a');
  });

  it('is deterministic', () => {
    const { nodes, edges } = alphaAndColor();
    expect(emit(nodes, edges)).toBe(emit(nodes, edges));
  });
});

describe('gates — only the Color socket is an image to Normal and Environment', () => {
  it('Environment from `out` (in wide mode) is still the texture OBJECT', () => {
    const code = emit(
      [img(), out()],
      [makeEdge('img1', 'out', 'out1', 'env'), makeEdge('img1', 'alpha', 'out1', 'opacity')],
    );
    expect(code).toContain('env: texture(_image1_tex)');
    expect(code).toContain('opacity: image1.a');
  });

  it('Environment from Alpha is a scalar, never IBL', () => {
    const code = emit([img(), out()], [makeEdge('img1', 'alpha', 'out1', 'env')]);
    expect(code).not.toContain('env: texture(');
    // Alpha is a declared float, so the Environment channel widens it.
    expect(code).toContain('env: vec3(image1.a)');
  });

  it('Normal from `out` (in wide mode) is decoded: normalMap(image1.rgb)', () => {
    const code = emit(
      [img({ ...valid, colorSpace: 'data' }), out()],
      [makeEdge('img1', 'out', 'out1', 'normal'), makeEdge('img1', 'alpha', 'out1', 'opacity')],
    );
    expect(code).toContain('normalMap(image1.rgb)');
  });

  it('Normal from R is a raw scalar — no normalMap', () => {
    const code = emit([img(), out()], [makeEdge('img1', 'r', 'out1', 'normal')]);
    expect(code).not.toContain('normalMap');
    expect(code).toContain('image1.r');
  });

  it('NodeEditor.applyConnection flips the colour space for the Color socket only', () => {
    const s = src('../components/NodeEditor/NodeEditor.tsx');
    expect(s).toContain("import { isImageChannelHandle } from '@/utils/imageChannels';");
    const at = s.indexOf("if (connection.targetHandle === 'normal') {");
    expect(at).toBeGreaterThan(0);
    const block = s.slice(at, s.indexOf("colorSpace: 'data'", at));
    expect(block).toContain(
      "src?.data.registryType === 'imageNode' && !isImageChannelHandle(connection.sourceHandle)",
    );
  });

  it('graphToCode gates both the normalMap decode and the Environment texture object', () => {
    const s = src('./graphToCode.ts');
    const normal = s.slice(s.indexOf("ch === 'normal' &&"), s.indexOf('normalMap(${ref})'));
    expect(normal).toContain('!isImageChannelHandle(edge.sourceHandle)');
    const env = s.slice(s.indexOf('const placedEnv ='), s.indexOf('imagePlanner.get(envSrc.id)'));
    expect(env).toContain('!isImageChannelHandle(envEdge.sourceHandle)');
  });
});

describe('an Apply of wide code stays inert', () => {
  it('mints no unknown, split or image node and raises no error', () => {
    const { nodes, edges } = alphaAndColor();
    const r = codeToGraph(emit(nodes, edges));
    expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    const types = r.nodes.map((n) => n.data.registryType);
    expect(types).not.toContain('unknown');
    expect(types).not.toContain('split');
    expect(types).not.toContain('imageNode');
  });

  it('the sample is a MEMBER expression in source, never a bare texture() declarator', () => {
    const s = src('./graphToCode.ts');
    expect(s).toContain("texture(${texVar}, ${uvExpr}).${wide ? 'rgba' : 'rgb'};`");
    expect(s).not.toContain('= texture(${texVar}, ${uvExpr});`');
  });
});

describe('cost — one sample however many sockets are wired', () => {
  it('neither the node price nor the reachable total moves with the wiring', () => {
    const nodes = [img(), out()];
    const outOnly = [makeEdge('img1', 'out', 'out1', 'color')];
    const wide = [
      ...outOnly,
      makeEdge('img1', 'alpha', 'out1', 'opacity'),
      makeEdge('img1', 'r', 'out1', 'roughness'),
    ];
    const price = nodeCostPoints(nodes[0], outOnly);
    expect(price).toBeGreaterThan(0);
    expect(nodeCostPoints(nodes[0], wide)).toBe(price);
    expect(computeReachableCost(nodes, wide)).toBe(computeReachableCost(nodes, outOnly));
  });
});

describe('against the real three/tsl', () => {
  // The emitted module is untyped text; the question is runtime structure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Chain = any;
  const texOf = (n: Chain): Chain => {
    for (let i = 0; i < 8 && n; i++) {
      if (n.isTextureNode) return n;
      n = n.node;
    }
    return null;
  };

  it('`.rgba` and every swizzle of it reach the SAME TextureNode — one sample', () => {
    const T = TSL as unknown as { texture: (t: Texture, uv: Chain) => Chain; uv: () => Chain };
    const s = T.texture(new Texture(), T.uv()).rgba;
    const tex = texOf(s);
    expect(tex).not.toBeNull();
    for (const k of ['rgb', 'a', 'r', 'g', 'b']) {
      expect(s[k], k).toBeTruthy();
      expect(texOf(s[k]), k).toBe(tex);
    }
  });
});

describe('memo keys already fold sourceHandle (re-wiring Color → Alpha must repaint)', () => {
  it.each([
    ['../components/NodeEditor/nodes/ShaderNode.tsx', "const sh = typeof e.sourceHandle === 'string'"],
    ['../components/NodeEditor/nodes/ShaderNode.tsx', "${e.source}|${e.sourceHandle ?? ''}"],
    ['../components/NodeEditor/nodes/MathPreviewNode.tsx', "${e.source}|${e.sourceHandle ?? ''}"],
    ['../components/NodeEditor/nodes/PreviewNode.tsx', "${e.sourceHandle ?? ''}"],
    ['../components/NodeEditor/nodes/ClockNode.tsx', "${e.sourceHandle ?? ''}"],
    ['../components/NodeEditor/nodes/LiveEdgeValue.tsx', '[sourceId, sourceHandle, animated]'],
    ['../components/NodeEditor/edges/EdgeInfoCard.tsx', '[sourceId, sourceHandle, isTimeDriven]'],
    ['../components/NodeEditor/edges/TypedEdge.tsx', 'getUnwrappedEdge(s.nodes, s.edges, id)?.sourceHandle'],
  ])('%s', (file, needle) => {
    expect(src(file)).toContain(needle);
  });
});

describe('widths — the channel sockets are declared floats', () => {
  it('Alpha straight into Color is widened: vec3(image1.a), never a float splatted into alpha', () => {
    // A Color-only graph emits the `return <colour>` shorthand; the splat
    // form would be the bare `return image1.a;`.
    const code = emit([img(), out()], [makeEdge('img1', 'alpha', 'out1', 'color')]);
    expect(code).toContain('return vec3(image1.a);');
    expect(code).not.toContain('return image1.a;');
    const withOpacity = emit(
      [img(), out()],
      [makeEdge('img1', 'alpha', 'out1', 'color'), makeEdge('img1', 'g', 'out1', 'opacity')],
    );
    expect(withOpacity).toContain('color: vec3(image1.a)');
    expect(withOpacity).toContain('opacity: image1.g');
  });

  it('Alpha through an `any` op into Color: the broadcast reads the socket, so vec3(mul1)', () => {
    const code = emit(
      [img(), makeNode('mul1', 'mul'), out()],
      [makeEdge('img1', 'alpha', 'mul1', 'a'), makeEdge('mul1', 'out', 'out1', 'color')],
    );
    expect(code).toContain('return vec3(mul1);');
    expect(code).not.toContain('return mul1;');
  });

  it('the Color socket keeps its bare out-only reference', () => {
    const code = emit([img(), out()], [makeEdge('img1', 'out', 'out1', 'color')]);
    expect(code).toContain('return image1;');
  });

  it('edge shapes: 1 per channel socket, 3 for Color', () => {
    const nodes = [img(), out()];
    const edges = [
      makeEdge('img1', 'out', 'out1', 'color'),
      makeEdge('img1', 'alpha', 'out1', 'opacity'),
      makeEdge('img1', 'g', 'out1', 'roughness'),
    ];
    expect(getEdgeOutputShape(edges[0], nodes, edges)).toBe(3);
    expect(getEdgeOutputShape(edges[1], nodes, edges)).toBe(1);
    expect(getEdgeOutputShape(edges[2], nodes, edges)).toBe(1);
  });
});

describe('registry parity — the declared sockets ARE the table', () => {
  const def = NODE_REGISTRY.get('imageNode')!;

  it('output ids are `out`, then the channel table in its order', () => {
    expect(def.outputs.map((o) => o.id)).toEqual(['out', ...IMAGE_CHANNEL_COMPONENTS.keys()]);
  });

  it('`out` is the vec3 outputs[0]; every channel socket is a float', () => {
    expect(def.outputs[0]).toMatchObject({ id: 'out', dataType: 'vec3' });
    for (const o of def.outputs.slice(1)) expect(o.dataType, o.id).toBe('float');
  });

  it('no input id collides with an output id', () => {
    // TypedEdge's disconnect selector matches data-handleid with no
    // source/target class, so a shared id would pick the wrong socket.
    const outs = new Set(def.outputs.map((o) => o.id));
    expect(def.inputs.filter((i) => outs.has(i.id))).toEqual([]);
  });
});
