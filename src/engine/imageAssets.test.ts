import { describe, it, expect } from 'vitest';
import {
  IMAGE_ASSET_PREFIX,
  collectImageAssets,
  imageAssetFor,
  inlineImageAssets,
  inlineImageAssetsFromNodes,
} from './imageAssets';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '../test-utils';

const B64 = btoa('abc'); // "YWJj"
const URL_WEBP = `data:image/webp;base64,${B64}`;
const valid = { imageB64: URL_WEBP, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' };

describe('imageAssetFor', () => {
  it('returns a placeholder, the canonical data: URL, and a one-line comment', () => {
    const a = imageAssetFor('img1', valid);
    expect(a).not.toBeNull();
    expect(a!.key).toMatch(/^img1-[0-9a-f]{8}$/);
    expect(a!.placeholder).toBe(`${IMAGE_ASSET_PREFIX}${a!.key}`);
    expect(a!.src).toBe(URL_WEBP);
    expect(a!.comment).toBe('// x.webp, 2x2 webp, 3 B');
    expect(a!.comment).not.toContain('\n');
  });

  it('is null for every payload decodeImageNode rejects', () => {
    for (const bad of [
      { ...valid, imageB64: '' },
      { ...valid, imageB64: 'https://evil.example/x.png' },
      { ...valid, imageB64: 'javascript:alert(1)' },
      { ...valid, imageB64: `data:image/svg+xml;base64,${B64}` },
      { ...valid, width: 2.5 },
      { ...valid, height: 0 },
    ]) {
      expect(imageAssetFor('img1', bad)).toBeNull();
    }
  });

  it('re-encodes from decoded bytes rather than trusting the stored string', () => {
    // "AB==" is atob-valid but non-canonical — it decodes to the single byte
    // 0x00, whose canonical encoding is "AA==".
    const a = imageAssetFor('img1', { ...valid, imageB64: 'data:image/png;base64,AB==' });
    expect(a!.src).toBe('data:image/png;base64,AA==');
  });

  it('hashes the payload, so swapping bytes changes the key', () => {
    const other = btoa('xyz');
    const a = imageAssetFor('img1', valid);
    // Same dimensions and file name — only the bytes differ. Without the hash
    // the generated code would be identical and every code-keyed memo (the
    // debounced preview rebuild, the srcDoc memo) would skip the update.
    const b = imageAssetFor('img1', { ...valid, imageB64: `data:image/webp;base64,${other}` });
    expect(a!.key).not.toBe(b!.key);
  });

  it('keys stay distinct per node, so two images never alias', () => {
    const other = btoa('xyz');
    const a = imageAssetFor('img1', valid);
    const b = imageAssetFor('img2', { ...valid, imageB64: `data:image/webp;base64,${other}` });
    expect(a!.key).not.toBe(b!.key);
    expect(a!.src).not.toBe(b!.src);
  });

  it('sanitizes adversarial node ids and file names out of the emitted text', () => {
    const a = imageAssetFor('img"1\n', { ...valid, fileName: 'a"b\nc*/d' });
    expect(a!.key).not.toMatch(/["\n]/);
    expect(a!.comment).not.toMatch(/["\n]/);
    expect(a!.placeholder).not.toMatch(/["\n]/);
  });

  it('omits the file-name segment when there is nothing safe left', () => {
    const a = imageAssetFor('img1', { ...valid, fileName: '///' });
    expect(a!.comment).toBe('// 2x2 webp, 3 B');
  });
});

describe('inlineImageAssets', () => {
  it('expands a known placeholder back to its data: URL', () => {
    const assets = new Map([['img1-deadbeef', URL_WEBP]]);
    const code = 'x.src = "fs-asset:img1-deadbeef";';
    expect(inlineImageAssets(code, assets)).toBe(`x.src = "${URL_WEBP}";`);
  });

  it('leaves an unknown key verbatim (decode() then hits the 1x1 fallback)', () => {
    const code = 'x.src = "fs-asset:gone-00000000";';
    expect(inlineImageAssets(code, new Map([['img1-deadbeef', URL_WEBP]]))).toBe(code);
  });

  it('is a no-op on code with no placeholders, and on an empty map', () => {
    const plain = 'const x = 1;';
    expect(inlineImageAssets(plain, new Map([['a', URL_WEBP]]))).toBe(plain);
    expect(inlineImageAssets('x.src = "fs-asset:a";', new Map())).toBe('x.src = "fs-asset:a";');
  });

  it('expands every placeholder in one pass', () => {
    const assets = new Map([['a-1', 'data:image/png;base64,AA=='], ['b-2', 'data:image/png;base64,BB==']]);
    const out = inlineImageAssets('p("fs-asset:a-1"); q("fs-asset:b-2");', assets);
    expect(out).toBe('p("data:image/png;base64,AA=="); q("data:image/png;base64,BB==");');
  });

  it('treats a $-substitution sequence in a payload as literal text', () => {
    // Replacement goes through a function, so `$&` can never be reinterpreted
    // as a backreference and duplicate the matched placeholder into the output.
    const evil = 'data:image/png;base64,$&$1$`';
    const out = inlineImageAssets('x.src = "fs-asset:k";', new Map([['k', evil]]));
    expect(out).toBe(`x.src = "${evil}";`);
  });

  it('cannot match past a closing quote', () => {
    const code = 'const a = "fs-asset:k"; const b = "unrelated";';
    expect(inlineImageAssets(code, new Map([['k', 'data:image/png;base64,AA==']]))).toBe(
      'const a = "data:image/png;base64,AA=="; const b = "unrelated";',
    );
  });
});

describe('collectImageAssets / round trip through graphToCode', () => {
  const imageGraph = (values: Record<string, string | number>, id = 'img1') => ({
    nodes: [makeNode(id, 'imageNode', values), makeNode('out1', 'output')],
    edges: [makeEdge(id, 'out', 'out1', 'color')],
  });

  it('collects only decodable image nodes', () => {
    const { nodes } = imageGraph(valid);
    expect(collectImageAssets(nodes).size).toBe(1);
    expect(collectImageAssets(imageGraph({ ...valid, imageB64: '' }).nodes).size).toBe(0);
    expect(collectImageAssets([makeNode('c1', 'color', { hex: '#fff' })]).size).toBe(0);
  });

  it('generated code round-trips: placeholder out, exact payload back in', () => {
    const { nodes, edges } = imageGraph(valid);
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain(IMAGE_ASSET_PREFIX);
    expect(code).not.toContain(B64);
    const inlined = inlineImageAssetsFromNodes(code, nodes);
    expect(inlined).toContain(`_image1_img.src = "${URL_WEBP}";`);
    expect(inlined).not.toContain(IMAGE_ASSET_PREFIX);
  });

  it('two image nodes each recover their own payload', () => {
    const other = `data:image/png;base64,${btoa('xyz')}`;
    const a = makeNode('imgA', 'imageNode', valid);
    const b = makeNode('imgB', 'imageNode', { ...valid, imageB64: other, fileName: 'y.png' });
    const out = makeNode('out1', 'output');
    const nodes = [a, b, out];
    const edges = [makeEdge('imgA', 'out', 'out1', 'color'), makeEdge('imgB', 'out', 'out1', 'normal')];
    const inlined = inlineImageAssetsFromNodes(graphToCode(nodes, edges).code, nodes);
    expect(inlined).toContain(`"${URL_WEBP}"`);
    expect(inlined).toContain(`"${other}"`);
    expect(inlined).not.toContain(IMAGE_ASSET_PREFIX);
  });

  it('a stale placeholder (node deleted) degrades instead of throwing', () => {
    const { nodes, edges } = imageGraph(valid);
    const { code } = graphToCode(nodes, edges);
    // Same code, but the image node is gone from the graph — the placeholder
    // survives into the module and the runtime decode() fallback takes over.
    const orphaned = inlineImageAssetsFromNodes(code, [makeNode('out1', 'output')]);
    expect(orphaned).toBe(code);
  });
});
