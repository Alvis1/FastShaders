import { describe, it, expect } from 'vitest';
import { graphToCode } from '@/engine/graphToCode';
import { previewGraph } from '@/utils/nodePreview';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

/**
 * OUT-ONLY image graphs, re-emitted — pinned byte for byte BEFORE GLB Phase 4
 * (the Texture node) touches the image branch.
 *
 * Phase 4 gives the Image node four more output sockets (Alpha, R, G, B —
 * swizzles of ONE sample) and a set of glTF mapping keys on `values`. Both are
 * opt-in by construction: an image wired only from `out` switches nothing on,
 * and a mapping key that is absent, junk or at its default means today's
 * bytes. This file is the proof, taken on the code that predates both.
 *
 * WHAT MAY CHANGE, AND WHEN (review every `-u` against this list): NOTHING.
 * Every Phase 4 step must pass this file unedited:
 *   - Step 3 (wide sample) only fires when an edge leaves from a CHANNEL
 *     handle. No case here has one — the tampered handles are deliberately
 *     never `alpha`/`r`/`g`/`b`, which become real sockets.
 *   - Step 7 (mapping flags) only fires on a VALID value. Case 7 carries junk
 *     only: valid values (`'gltf'`, `'flip'`, 1..3, finite numbers) are Step
 *     7's own tests, not this pin.
 * Phase 2's imageGraphByteStability.test.ts pins the texture-sharing and
 * settings cases; this file does not repeat them.
 */

const A = 'data:image/webp;base64,' + btoa('abc');
const base: Record<string, unknown> = {
  imageB64: A,
  width: 2,
  height: 2,
  fileName: 'x.webp',
  colorSpace: 'color',
};

interface Graph { nodes: AppNode[]; edges: AppEdge[] }

/** An Image node whose `values` may hold ANYTHING (`true`, `null`, NaN): a
 *  `.fastshader` does, and makeNode's value type cannot say so. */
function img(id: string, extra: Record<string, unknown> = {}): AppNode {
  const n = makeNode(id, 'imageNode');
  (n.data as { values: Record<string, unknown> }).values = { ...base, ...extra };
  return n;
}
const out = () => makeNode('out1', 'output');

/** An edge whose source handle is anything at all, `null` included. */
function edgeFrom(source: string, sourceHandle: string | null, target: string, targetHandle: string): AppEdge {
  const e = makeEdge(source, sourceHandle ?? 'null', target, targetHandle);
  (e as { sourceHandle: string | null }).sourceHandle = sourceHandle;
  return e;
}

/** Tampered NON-channel source handles. Never `alpha`/`r`/`g`/`b`: those are
 *  the Texture node's channel sockets from Phase 4 Step 3 on. */
const TAMPERED_HANDLES: Record<string, string | null> = {
  x: 'x',
  proto: '__proto__',
  constructor: 'constructor',
  empty: '',
  null: null,
};

/** The Preview-mode source graph (case 4): image → mul → Color, a colour on
 *  Emissive, so the preview's reroute visibly replaces both. */
function previewSource(): Graph {
  return {
    nodes: [img('imgA'), makeNode('m1', 'mul'), makeNode('c1', 'color', { hex: '#112233' }), out()],
    edges: [
      makeEdge('imgA', 'out', 'm1', 'a'),
      makeEdge('m1', 'out', 'out1', 'color'),
      makeEdge('c1', 'out', 'out1', 'emissive'),
    ],
  };
}

function outOnlyCases(): Record<string, Graph> {
  const cases: Record<string, Graph> = {
    // 1. One node feeding the three channels that treat an image specially.
    'color-normal-env-one-node': {
      nodes: [img('imgA'), out()],
      edges: [
        makeEdge('imgA', 'out', 'out1', 'color'),
        makeEdge('imgA', 'out', 'out1', 'normal'),
        makeEdge('imgA', 'out', 'out1', 'env'),
      ],
    },
    // 2. Through an `any` op.
    'through-mul': {
      nodes: [img('imgA'), makeNode('m1', 'mul'), out()],
      edges: [makeEdge('imgA', 'out', 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'color')],
    },
    // 3. One sample, two consumers.
    'two-consumers': {
      nodes: [img('imgA'), makeNode('m1', 'mul'), makeNode('a1', 'add'), out()],
      edges: [
        makeEdge('imgA', 'out', 'm1', 'a'),
        makeEdge('imgA', 'out', 'a1', 'a'),
        makeEdge('m1', 'out', 'out1', 'color'),
        makeEdge('a1', 'out', 'out1', 'emissive'),
      ],
    },
    // 4. Preview mode's derived graph (⌘/Ctrl+click previews `outputs[0]`).
    'preview-mode': (() => {
      const g = previewSource();
      return previewGraph(g.nodes, g.edges, { nodeId: 'imgA', handleId: 'out' });
    })(),
  };
  // 5. Tampered non-channel source handles.
  for (const [key, handle] of Object.entries(TAMPERED_HANDLES)) {
    cases[`tampered-handle-${key}`] = {
      nodes: [img('imgA'), makeNode('m1', 'mul'), out()],
      edges: [edgeFrom('imgA', handle, 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'color')],
    };
  }
  // 6. An invalid payload wired out-only.
  cases['invalid-payload'] = {
    nodes: [img('imgA', { imageB64: '' }), out()],
    edges: [makeEdge('imgA', 'out', 'out1', 'color')],
  };
  return cases;
}

/**
 * 7. JUNK values of the glTF mapping keys Phase 4 Step 7 introduces
 * (`orientation`, `normalGreen`, `uvSet`, `xf*`). Each is read EXACTLY from
 * Step 7 on, so every value below must emit what the flagless graph emits.
 * Valid values stay OUT of this list — Step 7 changes their bytes by design.
 */
const XF_JUNK: unknown[] = ['1', '0.5', 'abc', '', true, null, NaN, Infinity, -Infinity, 2e6, -2e6];
const JUNK_FLAGS: Record<string, unknown[]> = {
  orientation: ['GLTF', 'gltf ', ' gltf', 'Gltf', '', true, 1, 0, null, NaN],
  normalGreen: ['FLIP', 'flip ', 'Flip', '', true, 1, -1, null, NaN],
  uvSet: ['1', '2', '', true, 1.5, 4, -1, 0.5, null, NaN, Infinity],
  xfOffsetX: XF_JUNK,
  xfOffsetY: XF_JUNK,
  xfRotation: XF_JUNK,
  xfScaleX: XF_JUNK,
  xfScaleY: XF_JUNK,
};

/** Where each junk value is carried. `normal` is where `normalGreen` would
 *  act; `share` is where `orientation` would split one texture into two. */
const FLAG_VARIANTS: Record<string, (extra: Record<string, unknown>) => Graph> = {
  color: (extra) => ({
    nodes: [img('imgA', extra), out()],
    edges: [makeEdge('imgA', 'out', 'out1', 'color')],
  }),
  normal: (extra) => ({
    nodes: [img('imgA', { colorSpace: 'data', ...extra }), out()],
    edges: [makeEdge('imgA', 'out', 'out1', 'normal')],
  }),
  // Two nodes, one payload: the junk rides on the SECOND, so a reader that
  // took it for a real orientation would give it its own texture.
  share: (extra) => ({
    nodes: [img('imgA'), img('imgB', extra), makeNode('m1', 'mul'), out()],
    edges: [
      makeEdge('imgA', 'out', 'm1', 'a'),
      makeEdge('imgB', 'out', 'm1', 'b'),
      makeEdge('m1', 'out', 'out1', 'color'),
    ],
  }),
};

/** The node a variant carries its junk on. */
const FLAG_HOLDER: Record<string, string> = { color: 'imgA', normal: 'imgA', share: 'imgB' };

function flaglessBaselines(): Record<string, string> {
  const outMap: Record<string, string> = {};
  for (const [key, build] of Object.entries(FLAG_VARIANTS)) {
    const g = build({});
    outMap[`flagless-${key}`] = graphToCode(g.nodes, g.edges).code;
  }
  return outMap;
}

function emitAll(cases: Record<string, Graph>): Record<string, string> {
  const outMap: Record<string, string> = {};
  for (const [key, g] of Object.entries(cases)) outMap[key] = graphToCode(g.nodes, g.edges).code;
  return outMap;
}

const count = (s: string, needle: string) => s.split(needle).length - 1;
const valuesOf = (g: Graph, id: string) =>
  (g.nodes.find((n) => n.id === id)!.data as { values: Record<string, unknown> }).values;

describe('out-only image graphs emit byte-identical code', () => {
  it('out-only cases', () => {
    expect(emitAll(outOnlyCases())).toMatchSnapshot();
  });

  it('flagless baselines for the junk-flag sweep', () => {
    expect(flaglessBaselines()).toMatchSnapshot();
  });

  it('every junk future-flag value emits exactly the flagless code', () => {
    const baselines = flaglessBaselines();
    const moved: string[] = [];
    for (const [key, junk] of Object.entries(JUNK_FLAGS)) {
      for (const value of junk) {
        for (const [variant, build] of Object.entries(FLAG_VARIANTS)) {
          const g = build({ [key]: value });
          if (graphToCode(g.nodes, g.edges).code !== baselines[`flagless-${variant}`]) {
            moved.push(`${variant} ${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
          }
        }
      }
    }
    expect(moved).toEqual([]);
  });

  it('covers every case, so one cannot be dropped with a `-u`', () => {
    expect(Object.keys(outOnlyCases())).toEqual([
      'color-normal-env-one-node',
      'through-mul',
      'two-consumers',
      'preview-mode',
      'tampered-handle-x',
      'tampered-handle-proto',
      'tampered-handle-constructor',
      'tampered-handle-empty',
      'tampered-handle-null',
      'invalid-payload',
    ]);
    expect(Object.keys(flaglessBaselines())).toEqual(['flagless-color', 'flagless-normal', 'flagless-share']);
    expect(Object.keys(JUNK_FLAGS)).toEqual([
      'orientation',
      'normalGreen',
      'uvSet',
      'xfOffsetX',
      'xfOffsetY',
      'xfRotation',
      'xfScaleX',
      'xfScaleY',
    ]);
    // The whole sweep, so a value cannot be quietly dropped either.
    expect(Object.values(JUNK_FLAGS).reduce((n, v) => n + v.length, 0)).toBe(10 + 9 + 11 + 5 * 11);
  });

  it('every case really exercises what its key names', () => {
    // A snapshot pins whatever came out, including a fixture that silently
    // stopped wiring what it claims to. These are the facts each key exists for.
    const cases = outOnlyCases();
    const code = emitAll(cases);
    for (const [key, c] of Object.entries(code)) {
      // Out-only: never the wide sample, whatever the case.
      expect(c, key).not.toContain('.rgba');
      expect(c, key).not.toContain('vec4(');
    }

    const cne = code['color-normal-env-one-node'];
    expect(count(cne, ').rgb;')).toBe(1);
    expect(cne).toContain('normalMap(');
    expect(cne).toContain('env: texture(_image1_tex)');
    expect(cne).toMatch(/color: image1\b/);

    expect(code['through-mul']).toContain('const mul1 = mul(image1, 1);');

    const two = code['two-consumers'];
    expect(count(two, ').rgb;')).toBe(1);
    expect(two).toContain('mul(image1');
    expect(two).toContain('add(image1');

    // Preview mode: the derived graph routes `out` onto Color and drops every
    // other Output input, so the module returns the image itself.
    const pv = cases['preview-mode'];
    expect(pv.edges.some((e) => e.source === 'imgA' && e.sourceHandle === 'out' && e.targetHandle === 'color')).toBe(true);
    expect(code['preview-mode']).toContain('return image1;');
    const src = previewSource();
    expect(graphToCode(src.nodes, src.edges).code).not.toContain('return image1;');

    for (const [key, handle] of Object.entries(TAMPERED_HANDLES)) {
      const g = cases[`tampered-handle-${key}`];
      expect(g.edges[0].sourceHandle, key).toBe(handle);
      expect(code[`tampered-handle-${key}`], key).toContain('texture(_image1_tex, ');
      expect(code[`tampered-handle-${key}`], key).toContain(').rgb;');
    }

    expect(code['invalid-payload']).toContain('const image1 = vec3(0, 0, 0);');
    expect(code['invalid-payload']).not.toContain('_image1_tex');

    // The junk sweep's variants wire what they claim, and the fixture really
    // carries each junk value on the node the variant names.
    const b = flaglessBaselines();
    expect(b['flagless-color']).toContain('return image1;');
    expect(b['flagless-normal']).toContain('normalMap(');
    expect(count(b['flagless-share'], 'new globalThis.THREE.Texture(')).toBe(1);
    expect(count(b['flagless-share'], 'texture(_image1_tex, ')).toBe(2);
    for (const [key, junk] of Object.entries(JUNK_FLAGS)) {
      for (const value of junk) {
        for (const [variant, build] of Object.entries(FLAG_VARIANTS)) {
          const held = valuesOf(build({ [key]: value }), FLAG_HOLDER[variant]);
          expect(Object.is(held[key], value), `${variant} ${key}`).toBe(true);
        }
      }
    }
  });
});
